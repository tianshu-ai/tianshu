// CodingWorker — drives opencode or claude-code CLI via bridge exec,
// streams NDJSON events back into a tianshu worker session.
//
// Architecture:
//   1. Create a worker session in the DB.
//   2. Write the task prompt to a temp file on the bridge machine
//      (avoids shell escaping issues with complex prompts).
//   3. Start the CLI via bridge exec in background, stdout → temp file.
//   4. Poll the temp file every few seconds, incrementally parse
//      NDJSON events, and write them into the worker session as
//      structured messages.
//   5. When the CLI exits (done marker appears), parse the final
//      result and mark the task done/stalled.
//
// The CLI runs on the user's bridge machine — no sandbox, no proxy.
// User just needs opencode or claude installed and configured.

import { randomUUID } from "node:crypto";
import type {
  AgentLoopRunner,
  AgentLoopRunnerRequest,
  PluginLogger,
  SandboxRunner,
  TaskSandboxPool,
  TenantDbHandle,
} from "@tianshu-ai/plugin-sdk";
import type { Task } from "../db/tasks.js";
import { updateTask } from "../db/tasks.js";
import type { TerminalUpdate, WorkerHandle } from "./pool.js";
import { createNdjsonParser } from "./ndjson-parser.js";

// ─── Types ──────────────────────────────────────────────

export type CodingCli = "opencode" | "claude";

export interface CodingWorkerConfig {
  agentId: string;
  name: string;
  cli: CodingCli;
  /** Default model override for the CLI. */
  modelId?: string | null;
  /** Custom system prompt prepended to the task prompt. */
  systemPrompt?: string | null;
  shell: SandboxRunner;
  db: TenantDbHandle;
  log: PluginLogger;
  /** AgentLoopRunner for the Phase 2 LLM wrap-up turn. */
  runner: AgentLoopRunner;
  /** LLM worker timeouts for the wrap-up turn. */
  timeouts?: AgentLoopRunnerRequest["timeouts"];
  /** Per-task sandbox pool. */
  taskPool?: TaskSandboxPool;
  /** Poll interval for reading CLI stdout (ms). Default: 3000. */
  pollIntervalMs?: number;
  /** Max run time (ms). Default: 600_000 (10 min). */
  maxRunMs?: number;
}

// ─── NDJSON event types (subset we care about) ──────────

/** Claude Code stream-json events. */
interface ClaudeEvent {
  type: "system" | "assistant" | "stream_event" | "result";
  subtype?: string;
  session_id?: string;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
    }>;
    model?: string;
    stop_reason?: string;
  };
  event?: {
    delta?: { type: string; text?: string };
  };
  result?: string;
  total_cost_usd?: number;
  usage?: Record<string, number>;
  // system event fields
  attempt?: number;
  max_retries?: number;
  error?: string;
  error_status?: number;
}

/** OpenCode --format json events. */
interface OpenCodeEvent {
  type: string;
  [key: string]: unknown;
}

type CliEvent = ClaudeEvent | OpenCodeEvent;

// ─── Session DB helpers ─────────────────────────────────
// These write directly to SQLite — the workboard plugin already
// holds the tenant DB handle, same pattern as the old opencode worker.

function createWorkerSession(
  db: TenantDbHandle,
  opts: {
    userId: string;
    workerRole: string;
    title?: string | null;
    parentSessionId?: string | null;
  },
): { id: string } {
  const id = `session_${randomUUID()}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions
       (id, user_id, parent_id, status, kind, worker_role, title, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.userId,
    opts.parentSessionId ?? null,
    "active",
    "worker",
    opts.workerRole,
    opts.title ?? null,
    now,
  );
  return { id };
}

/** Append a message to the session. Each event gets its own row so
 *  the Execution tab can render progress incrementally. */
function appendSessionMessage(
  db: TenantDbHandle,
  sessionId: string,
  role: "user" | "assistant" | "system" | "tool",
  content: string,
): void {
  const id = `msg_${randomUUID()}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, sessionId, role, content, now);
}

/** Write a tool call as two proper messages (assistant toolCall + tool result)
 *  so the chat UI renders them as collapsible cards. */
function appendToolCallMessages(
  db: TenantDbHandle,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  result: string,
  isError = false,
): void {
  const callId = `oc_${randomUUID().slice(0, 12)}`;
  const now = Date.now();

  // 1. Assistant message with toolCall block
  const assistantJson = JSON.stringify({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: callId,
      name: toolName,
      arguments: args,
    }],
  });
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, created_at)
     VALUES (?, ?, 'assistant', ?, ?)`,
  ).run(`msg_${randomUUID()}`, sessionId, assistantJson, now);

  // 2. Tool result message
  const toolJson = JSON.stringify({
    role: "toolResult",
    toolCallId: callId,
    toolName,
    content: [{ type: "text", text: result.slice(0, 4000) }],
    ...(isError ? { isError: true } : {}),
  });
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, created_at)
     VALUES (?, ?, 'tool', ?, ?)`,
  ).run(`msg_${randomUUID()}`, sessionId, toolJson, now + 1);
}

function archiveSession(db: TenantDbHandle, sessionId: string): void {
  db.prepare(
    `UPDATE sessions SET status = 'archived', ended_at = ? WHERE id = ?`,
  ).run(Date.now(), sessionId);
}

// ─── Prompt builder ─────────────────────────────────────

function buildCliPrompt(task: Task, systemPrompt?: string | null): string {
  const parts: string[] = [];
  if (systemPrompt?.trim()) parts.push(systemPrompt.trim());
  parts.push(`# Task: ${task.title}`);
  if (task.description?.trim()) parts.push(task.description.trim());
  return parts.join("\n\n");
}

// ─── Event → session message conversion ─────────────────

/** Claude Code events can contain multiple content blocks (text + tool_use).
 *  Return an array so the caller can write each as the right message type. */
function formatClaudeEvents(ev: ClaudeEvent): FormattedEvent[] {
  switch (ev.type) {
    case "system":
      if (ev.subtype === "init") {
        return [`[Session started: ${ev.session_id ?? "unknown"}]`];
      }
      if (ev.subtype === "api_retry") {
        return [`[API retry ${ev.attempt ?? "?"}/${ev.max_retries ?? "?"}: ${ev.error ?? "unknown"} (status ${ev.error_status ?? "?"})]`];
      }
      return [];

    case "assistant": {
      if (!ev.message?.content) return [];
      const results: FormattedEvent[] = [];
      for (const block of ev.message.content) {
        if (block.type === "text" && block.text?.trim()) {
          results.push(block.text);
        } else if (block.type === "thinking") {
          // Skip thinking blocks
        } else if (block.type === "tool_use") {
          const name = block.name ?? "unknown";
          const input = block.input as Record<string, unknown> | string | undefined;
          // Build compact args
          let args: Record<string, unknown> = {};
          if (input && typeof input === "object") {
            if (name === "Write" || name === "Edit") {
              const fp = (input as Record<string, unknown>).file_path ?? (input as Record<string, unknown>).path;
              const shortFp = typeof fp === "string" ? fp.replace(/.*\.tianshu_shell\//, "") : "file";
              args = { file: shortFp };
            } else if (name === "Bash") {
              const cmd = (input as Record<string, unknown>).command;
              args = { command: typeof cmd === "string" ? cmd.slice(0, 500) : "" };
            } else if (name === "Read") {
              const fp = (input as Record<string, unknown>).file_path ?? (input as Record<string, unknown>).path;
              args = { path: typeof fp === "string" ? fp.replace(/.*\.tianshu_shell\//, "") : "" };
            } else {
              args = input as Record<string, unknown>;
            }
          }
          results.push({
            kind: "toolCall" as const,
            toolName: name,
            args,
            result: "",  // Claude streams results separately
            isError: false,
          });
        } else if (block.type === "tool_result") {
          // Tool results come as separate assistant events in Claude
          // They reference a tool_use_id; write as text for now
          const text = block.text ?? "";
          if (text.trim()) results.push(text.slice(0, 2000));
        }
      }
      return results;
    }

    case "result": {
      const parts: string[] = [];
      if (ev.result) parts.push(ev.result);
      if (ev.total_cost_usd != null) parts.push(`Cost: $${ev.total_cost_usd.toFixed(4)}`);
      return parts.length > 0 ? [parts.join(" · ")] : [];
    }

    default:
      return [];
  }
}

/** Formatted event — either plain text or a structured tool call. */
interface FormattedToolCall {
  kind: "toolCall";
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
}
type FormattedEvent = string | FormattedToolCall | null;

function formatOpenCodeEvent(ev: OpenCodeEvent): FormattedEvent {
  // OpenCode v1.18+ --format json event shapes (verified empirically):
  //
  //   {"type":"step_start", "part":{"type":"step-start", ...}}
  //   {"type":"tool_use",  "part":{"type":"tool", "tool":"write",
  //     "state":{"input":{...}, "output":"...", "status":"completed"}, ...}}
  //   {"type":"text",       "part":{"type":"text", "text":"..."}}
  //   {"type":"file",       "part":{"type":"file", ...}}
  //   {"type":"step_finish","part":{"type":"step-finish",
  //     "tokens":{...}, "cost":0.23, "reason":"stop"|"tool-calls"}}
  //
  // All events carry a top-level `part` object with the payload.

  const type = ev.type as string;
  const part = ev.part as Record<string, unknown> | undefined;

  // ── text: assistant prose output ──
  if (type === "text" && part) {
    const text = part.text as string | undefined;
    if (text?.trim()) return text.slice(0, 4000);
  }

  // ── tool_use: return structured FormattedToolCall so the caller
  //    writes proper toolCall + toolResult JSON messages. ──
  if (type === "tool_use" && part) {
    const tool = part.tool as string ?? "unknown";
    const state = part.state as Record<string, unknown> | undefined;
    if (!state) return null;
    const status = state.status as string ?? "";
    const input = state.input as Record<string, unknown> | string | undefined;
    const output = state.output as string | undefined;

    // Skip noisy tools
    if (tool === "todowrite" || tool === "todoread") return null;

    // Build compact args for display
    let args: Record<string, unknown> = {};
    if (input) {
      if (tool === "write" || tool === "edit" || tool === "patch") {
        const fp = (input as Record<string, unknown>).filePath ?? (input as Record<string, unknown>).file;
        const shortFp = typeof fp === "string" ? fp.replace(/.*\.tianshu_shell\//, "") : "file";
        args = { file: shortFp };
      } else if (tool === "bash") {
        const cmd = (input as Record<string, unknown>).command;
        args = { command: typeof cmd === "string" ? cmd.slice(0, 500) : "" };
      } else if (tool === "read" || tool === "glob" || tool === "grep") {
        const fp = (input as Record<string, unknown>).filePath ?? (input as Record<string, unknown>).path ?? (input as Record<string, unknown>).pattern;
        args = { path: typeof fp === "string" ? fp.replace(/.*\.tianshu_shell\//, "") : "" };
      } else {
        args = typeof input === "string" ? { input: input.slice(0, 300) } : input as Record<string, unknown>;
      }
    }

    // Build result text
    let result = "";
    if (status === "error" && output) {
      result = output.slice(0, 2000);
    } else if (output) {
      result = output.slice(0, 2000);
    } else if (status === "completed") {
      result = "OK";
    }

    return {
      kind: "toolCall" as const,
      toolName: tool,
      args,
      result,
      isError: status === "error",
    };
  }

  // ── step_finish: skip individual step costs (too noisy). ──
  // The final result event or CodingWorker's summary captures totals.
  if (type === "step_finish") return null;

  // ── step_start, file: skip (noise) ──
  // step_start is just a marker; file events duplicate tool_use info.
  return null;
}

/** Return one or more formatted events. Claude events can contain
 *  multiple content blocks (text + tool_use), so always return array. */
function formatEvents(cli: CodingCli, ev: CliEvent): FormattedEvent[] {
  if (cli === "claude") {
    return formatClaudeEvents(ev as ClaudeEvent);
  }
  const result = formatOpenCodeEvent(ev as OpenCodeEvent);
  return result ? [result] : [];
}

// ─── Shell helpers ──────────────────────────────────────

/** Write content to a file on the bridge machine via base64 to avoid
 *  shell escaping issues. Works on both macOS and Linux. */
async function writeRemoteFile(
  shell: SandboxRunner,
  filePath: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  // base64 -d works on Linux, base64 -D on macOS; try -d first.
  await shell.exec({
    command: `echo '${b64}' | base64 -d > '${filePath}' 2>/dev/null || echo '${b64}' | base64 -D > '${filePath}'`,
    timeoutMs: 10_000,
    signal,
  });
}

/** Check if a CLI is available on the bridge machine. */
async function checkCliAvailable(
  shell: SandboxRunner,
  cli: CodingCli,
): Promise<{ available: boolean; path?: string; version?: string }> {
  const bin = cli === "claude" ? "claude" : "opencode";
  try {
    const res = await shell.exec({
      command: `which ${bin} 2>/dev/null && ${bin} --version 2>/dev/null || echo NOT_FOUND`,
      timeoutMs: 10_000,
    });
    const out = res.stdout.trim();
    if (out.includes("NOT_FOUND") || res.exitCode !== 0) {
      return { available: false };
    }
    const lines = out.split("\n").filter(Boolean);
    return {
      available: true,
      path: lines[0],
      version: lines[1] ?? undefined,
    };
  } catch {
    return { available: false };
  }
}

// ─── CodingWorker ───────────────────────────────────────

export class CodingWorker implements WorkerHandle {
  readonly kind: string;
  readonly agentId: string;
  readonly name: string;

  private readonly cfg: CodingWorkerConfig;

  constructor(cfg: CodingWorkerConfig) {
    this.cfg = cfg;
    this.agentId = cfg.agentId;
    this.name = cfg.name;
    this.kind = cfg.cli === "claude" ? "claude-code" : "opencode";
  }

  async run(task: Task, signal: AbortSignal): Promise<TerminalUpdate> {
    const {
      cli,
      shell,
      db,
      log,
      pollIntervalMs = 3000,
      maxRunMs = 600_000,
    } = this.cfg;

    // ── Pre-flight: discover bridge shell root + check CLI ──
    let bridgeRoot = "";
    try {
      const pwdRes = await shell.exec({ command: "pwd", timeoutMs: 5000 });
      bridgeRoot = pwdRes.stdout.trim();
    } catch { /* fall back to empty — strip logic handles it */ }

    const cliCheck = await checkCliAvailable(shell, cli);
    if (!cliCheck.available) {
      const bin = cli === "claude" ? "claude" : "opencode";
      log.warn("coding-worker: CLI not found on bridge", { taskId: task.id, cli });
      return {
        status: "stalled",
        resultSummary: `${bin} CLI not found on the bridge machine. Install it and try again.`,
      };
    }
    log.info?.("coding-worker: CLI found", {
      taskId: task.id,
      cli,
      path: cliCheck.path,
      version: cliCheck.version,
    });

    // ── Prepare paths ──
    // Scaffolding (prompt, output, pid) goes in /tmp so it doesn't
    // pollute the workspace. The CLI itself runs in the bridge's
    // shell root (or the workspace the shell runner points at) so
    // files it creates land in the user's real project tree.
    const tmpDir = `/tmp/tianshu-coding-${task.id}`;
    const promptFile = `${tmpDir}/prompt.txt`;
    const outputFile = `${tmpDir}/output.ndjson`;
    const pidFile = `${tmpDir}/cli.pid`;
    const exitFile = `${tmpDir}/exit.code`;
    const prompt = buildCliPrompt(task, this.cfg.systemPrompt);
    // NOTE: shell.workspacePath() is the SERVER-side path, not the
    // bridge machine's shell root. The bridge exec already runs in
    // the bridge's shell root (e.g. ~/.tianshu_shell), so the CLI
    // doesn't need an explicit --dir. We only need the server path
    // for stripping absolute prefixes from opencode's file events.

    // ── Create worker session ──
    const session = createWorkerSession(db, {
      userId: task.ownerUserId || "unknown",
      workerRole: this.kind,
      title: `[${cli}] ${task.title}`,
    });
    const sessionId = session.id;

    // Stamp session id on the task row immediately so the Execution
    // tab can start tailing while the CLI is still running.
    try {
      updateTask(db, task.id, { sessionId });
    } catch (err) {
      log.warn("coding-worker: stamp sessionId failed", {
        taskId: task.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    appendSessionMessage(db, sessionId, "user", prompt);

    // ── Write prompt to file on bridge (avoids shell escaping) ──
    try {
      await shell.exec({ command: `mkdir -p '${tmpDir}'`, timeoutMs: 5000, signal });
      await writeRemoteFile(shell, promptFile, prompt, signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("coding-worker: failed to write prompt file", { taskId: task.id, err: msg });
      appendSessionMessage(db, sessionId, "system", `Failed to prepare task: ${msg}`);
      archiveSession(db, sessionId);
      return { status: "stalled", resultSummary: `Failed to prepare: ${msg}`, sessionId };
    }

    // ── Build and start CLI command ──
    const bin = cli === "claude" ? "claude" : "opencode";
    const modelFlag = this.cfg.modelId ? ` --model '${this.cfg.modelId}'` : "";
    let cliCmd: string;
    if (cli === "claude") {
      // claude runs in the bridge exec's cwd (shell root)
      cliCmd =
        `cat '${promptFile}' | ${bin} -p -` +
        ` --output-format stream-json --verbose` +
        ` --dangerously-skip-permissions` +
        modelFlag;
    } else {
      // opencode runs in the bridge exec's cwd (shell root).
      // No --dir needed — bridge exec already sets cwd.
      cliCmd =
        `${bin} run` +
        ` --format json --dangerously-skip-permissions` +
        modelFlag +
        ` "$(cat '${promptFile}')"`;
    }

    // Run in background: redirect stdout to file, capture PID, write
    // exit code when done. The bridge exec returns immediately because
    // the `&` backgrounds the subshell.
    const launchCmd =
      `( ${cliCmd} > '${outputFile}' 2>&1 ; echo $? > '${exitFile}' ) &\n` +
      `echo $! > '${pidFile}'`;

    log.info?.("coding-worker: starting CLI", {
      taskId: task.id,
      cli,
      sessionId,
      version: cliCheck.version,
    });

    appendSessionMessage(db, sessionId, "system",
      `Starting ${bin} ${cliCheck.version ?? ""}…`);

    try {
      await shell.exec({ command: launchCmd, timeoutMs: 15_000, signal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("coding-worker: failed to launch CLI", { taskId: task.id, err: msg });
      appendSessionMessage(db, sessionId, "system", `Failed to start ${bin}: ${msg}`);
      archiveSession(db, sessionId);
      return { status: "stalled", resultSummary: `Failed to start ${bin}: ${msg}`, sessionId };
    }

    // ── Poll loop ──
    const parser = createNdjsonParser<CliEvent>();
    let fileOffset = 0;
    let lastResultText = "";
    let totalEvents = 0;
    let totalCost = 0;
    const modifiedFiles = new Set<string>();
    let cliExited = false;
    const deadline = Date.now() + maxRunMs;

    while (!cliExited && !signal.aborted && Date.now() < deadline) {
      await sleep(pollIntervalMs);

      // Check if CLI has exited (exit file exists)
      if (!cliExited) {
        try {
          const exitRes = await shell.exec({
            command: `cat '${exitFile}' 2>/dev/null || echo RUNNING`,
            timeoutMs: 5000,
            signal,
          });
          const exitStr = exitRes.stdout.trim();
          if (exitStr !== "RUNNING") {
            cliExited = true;
            log.info?.("coding-worker: CLI exited", {
              taskId: task.id,
              exitCode: exitStr,
            });
          }
        } catch {
          // poll errors are non-fatal
        }
      }

      // Read new lines from output file.
      // NDJSON is one JSON object per line. Track by line number
      // to avoid splitting multi-byte UTF-8 characters (emoji etc).
      let chunk = "";
      try {
        const res = await shell.exec({
          command: `tail -n +${fileOffset + 1} '${outputFile}' 2>/dev/null || true`,
          timeoutMs: 10_000,
          signal,
        });
        chunk = res.stdout;
      } catch {
        if (!cliExited) continue; // file might not exist yet
      }

      if (!chunk) {
        if (cliExited) break; // no more data
        continue;
      }

      // Count lines read (each NDJSON entry is one line)
      const linesRead = chunk.split("\n").filter((l) => l.trim()).length;
      fileOffset += linesRead;

      // Parse NDJSON events and write to session
      const events = parser.feed(chunk);
      for (const ev of events) {
        // Track cost/result BEFORE the text check — step_finish
        // events don't render but still carry cost data.
        const evType = (ev as { type?: string }).type;
        if (evType === "step_finish") {
          const cost = ((ev as OpenCodeEvent).part as Record<string, unknown> | undefined)?.cost;
          if (typeof cost === "number") totalCost += cost;
        }
        if (evType === "result" || evType === "session.complete" || evType === "done") {
          const r = (ev as ClaudeEvent).result
            ?? (ev as OpenCodeEvent).text as string | undefined;
          if (r) lastResultText = String(r);
        }
        if (evType === "result" && (ev as ClaudeEvent).total_cost_usd != null) {
          totalCost = (ev as ClaudeEvent).total_cost_usd!;
        }

        // Track files created/modified by tool_use events
        if (evType === "tool_use") {
          const part = (ev as OpenCodeEvent).part as Record<string, unknown> | undefined;
          const tool = part?.tool as string | undefined;
          if (tool === "write" || tool === "edit" || tool === "patch") {
            const state = part?.state as Record<string, unknown> | undefined;
            const input = state?.input as Record<string, unknown> | undefined;
            const fp = input?.filePath ?? input?.file;
            if (typeof fp === "string") modifiedFiles.add(fp);
          }
        }
        // Claude: track file writes from assistant tool_use blocks
        if (cli === "claude" && evType === "assistant") {
          const msg = (ev as ClaudeEvent).message;
          if (msg?.content) {
            for (const block of msg.content) {
              if (block.type === "tool_use" && (block.name === "write" || block.name === "edit")) {
                const input = block.input as Record<string, unknown> | undefined;
                const fp = input?.file_path ?? input?.path;
                if (typeof fp === "string") modifiedFiles.add(fp);
              }
            }
          }
        }

        const items = formatEvents(cli, ev);
        for (const formatted of items) {
          if (!formatted) continue;
          if (typeof formatted === "string") {
            appendSessionMessage(db, sessionId, "assistant", formatted);
            lastResultText = formatted;
          } else {
            appendToolCallMessages(db, sessionId, formatted.toolName, formatted.args, formatted.result, formatted.isError);
            if (formatted.result) lastResultText = formatted.result;
          }
          totalEvents++;
        }
      }
    }

    // ── Flush remaining buffered content ──
    const remaining = parser.flush();
    for (const ev of remaining) {
      const items = formatEvents(cli, ev);
      for (const formatted of items) {
        if (!formatted) continue;
        if (typeof formatted === "string") {
          appendSessionMessage(db, sessionId, "assistant", formatted);
          lastResultText = formatted;
        } else {
          appendToolCallMessages(db, sessionId, formatted.toolName, formatted.args, formatted.result, formatted.isError);
          if (formatted.result) lastResultText = formatted.result;
        }
        totalEvents++;
      }
    }

    // ── Read exit code if we haven't yet ──
    let exitCode: number | null = null;
    if (cliExited) {
      try {
        const res = await shell.exec({
          command: `cat '${exitFile}' 2>/dev/null`,
          timeoutMs: 5000,
        });
        exitCode = parseInt(res.stdout.trim(), 10);
        if (isNaN(exitCode)) exitCode = null;
      } catch { /* best effort */ }
    }

    // ── Determine final status ──
    let status: "done" | "stalled" | "aborted" = "done";
    let resultSummary: string;

    if (signal.aborted) {
      status = "aborted";
      resultSummary = "Aborted";
      appendSessionMessage(db, sessionId, "system", "[Run aborted]");
      // Kill the CLI process
      try {
        await shell.exec({
          command: `kill $(cat '${pidFile}' 2>/dev/null) 2>/dev/null; rm -rf '${tmpDir}'`,
          timeoutMs: 5000,
        });
      } catch { /* best effort */ }
    } else if (!cliExited) {
      status = "stalled";
      resultSummary = `Timed out after ${Math.round(maxRunMs / 1000)}s`;
      appendSessionMessage(db, sessionId, "system",
        `[Timed out after ${Math.round(maxRunMs / 1000)}s — killing CLI]`);
      try {
        await shell.exec({
          command: `kill $(cat '${pidFile}' 2>/dev/null) 2>/dev/null; rm -rf '${tmpDir}'`,
          timeoutMs: 5000,
        });
      } catch { /* best effort */ }
    } else if (exitCode != null && exitCode !== 0) {
      // Non-zero exit doesn't necessarily mean failure — the CLI may
      // have completed its work but a tool (e.g. test runner) failed.
      // Still proceed to LLM wrap-up; let the LLM assess the outcome.
      status = "done";
      resultSummary = lastResultText
        ? lastResultText.slice(0, 500)
        : `CLI exited with code ${exitCode}`;
      appendSessionMessage(db, sessionId, "system",
        `[${bin} exited with code ${exitCode}]`);
    } else {
      resultSummary = lastResultText
        ? lastResultText.slice(0, 500)
        : "Completed";
    }

    // ── Summary of CLI phase ──
    if (totalCost > 0 || totalEvents > 0) {
      const summaryParts: string[] = [];
      if (totalCost > 0) summaryParts.push(`Cost: $${totalCost.toFixed(4)}`);
      summaryParts.push(`${totalEvents} event(s)`);
      if (exitCode != null) summaryParts.push(`exit ${exitCode}`);
      appendSessionMessage(db, sessionId, "system",
        `[${bin} finished — ${summaryParts.join(" · ")}]`);
    }

    // ── Cleanup temp files (prompt, output, pid, exit code) ──
    try {
      await shell.exec({
        command: `rm -rf '${tmpDir}'`,
        timeoutMs: 5000,
      });
    } catch { /* best effort */ }

    // Only skip wrap-up for timeout/abort — not for non-zero exit.
    if (status === "stalled" || signal.aborted) {
      archiveSession(db, sessionId);
      log.info?.("coding-worker: finished (no wrap-up)", {
        taskId: task.id, cli, status, exitCode, sessionId,
      });
      return { status, resultSummary, sessionId };
    }

    // ── Phase 2: LLM wrap-up turn ──
    // The agent loop sees the full CLI execution transcript in the
    // session history. Its system prompt tells it to:
    //   1. Identify files the CLI created/modified
    //   2. Use sync_down / readFile / exec to copy them to workspace
    //   3. Summarize what was accomplished
    //   4. Call task_complete
    log.info?.("coding-worker: starting LLM wrap-up", {
      taskId: task.id, sessionId, modifiedFiles: [...modifiedFiles],
    });

    const fileList = [...modifiedFiles].map((f) => `- ${f}`).join("\n");
    const wrapUpPrompt = [
      `The ${bin} CLI has finished (exit code ${exitCode ?? "unknown"}).`,
      ``,
      modifiedFiles.size > 0
        ? `Files created/modified on the bridge machine:\n${fileList}`
        : `No file modifications were detected in the CLI output.`,
      ``,
      `Your job:`,
      `1. Copy each file listed above from the bridge machine into the workspace. Use \`sync_down\` or read the file via exec and write it with the file tools. The files are at their absolute paths on the bridge.`,
      `2. If the CLI ran tests, note whether they passed.`,
      `3. Write a brief summary of what was accomplished.`,
      `4. Call \`task_complete\` with the summary and list of result files.`,
      ``,
      `If you can't find a file, log it and continue with the rest.`,
    ].join("\n");

    try {
      const wrapResult = await this.cfg.runner.run({
        userId: task.ownerUserId || "unknown",
        initialUserMessage: wrapUpPrompt,
        systemPrompt: `You are a worker agent wrapping up a coding task. The ${bin} CLI already did the work — your job is to collect the results (sync files to workspace) and call task_complete. Be concise.`,
        modelId: this.cfg.modelId ?? undefined,
        sessionTitle: `[${cli}] ${task.title}`,
        workerRole: this.kind,
        workerSlug: this.cfg.agentId,
        taskId: task.id,
        projectSlug: task.projectSlug,
        taskTitle: task.title || null,
        timeouts: this.cfg.timeouts,
        signal,
        resumeSessionId: sessionId,
        onSessionStart: (sid) => {
          // Session already stamped in Phase 1, but update if
          // the runner created a new one.
          if (sid !== sessionId) {
            try { updateTask(db, task.id, { sessionId: sid }); } catch {}
          }
        },
      });

      log.info?.("coding-worker: wrap-up done", {
        taskId: task.id, status: wrapResult.status,
        reason: wrapResult.reason, sessionId: wrapResult.sessionId,
      });

      if (wrapResult.status === "done") {
        return {
          status: "done",
          resultSummary: wrapResult.summary || resultSummary,
          resultFiles: wrapResult.files,
          sessionId: wrapResult.sessionId,
        };
      }
      // Wrap-up didn't complete cleanly — return CLI results anyway
      return {
        status: "done",
        resultSummary,
        sessionId: wrapResult.sessionId || sessionId,
      };
    } catch (err) {
      log.warn("coding-worker: wrap-up failed", {
        taskId: task.id,
        err: err instanceof Error ? err.message : String(err),
      });
      // CLI succeeded, wrap-up failed — still report done
      archiveSession(db, sessionId);
      return { status: "done", resultSummary, sessionId };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
