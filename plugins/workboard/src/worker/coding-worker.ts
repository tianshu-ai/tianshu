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
  PluginLogger,
  SandboxRunner,
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
  role: "user" | "assistant" | "system",
  content: string,
): void {
  const id = `msg_${randomUUID()}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, sessionId, role, content, now);
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

function formatClaudeEvent(ev: ClaudeEvent): string | null {
  switch (ev.type) {
    case "system":
      if (ev.subtype === "init") {
        return `[Session started: ${ev.session_id ?? "unknown"}]`;
      }
      if (ev.subtype === "api_retry") {
        return `[API retry ${ev.attempt ?? "?"}/${ev.max_retries ?? "?"}: ${ev.error ?? "unknown"} (status ${ev.error_status ?? "?"})]`;
      }
      return null;

    case "assistant": {
      if (!ev.message?.content) return null;
      const parts: string[] = [];
      for (const block of ev.message.content) {
        if (block.type === "text" && block.text) {
          parts.push(block.text);
        } else if (block.type === "tool_use") {
          const input =
            typeof block.input === "string"
              ? block.input
              : JSON.stringify(block.input, null, 2);
          parts.push(
            `**Tool: ${block.name ?? "unknown"}**\n\`\`\`\n${(input ?? "").slice(0, 2000)}\n\`\`\``,
          );
        } else if (block.type === "tool_result") {
          parts.push(
            `**Tool result** (${block.tool_use_id ?? "?"})\n${(block.text ?? "").slice(0, 2000)}`,
          );
        }
      }
      return parts.length > 0 ? parts.join("\n\n") : null;
    }

    case "result": {
      const parts: string[] = ["## Result"];
      if (ev.result) parts.push(ev.result);
      if (ev.total_cost_usd != null) parts.push(`Cost: $${ev.total_cost_usd.toFixed(4)}`);
      if (ev.usage) {
        const u = ev.usage;
        const tokens = Object.entries(u).map(([k, v]) => `${k}: ${v}`).join(", ");
        parts.push(`Usage: ${tokens}`);
      }
      return parts.join("\n");
    }

    default:
      return null;
  }
}

function formatOpenCodeEvent(ev: OpenCodeEvent): string | null {
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

  // ── tool_use: tool call with input + output ──
  if (type === "tool_use" && part) {
    const tool = part.tool as string ?? "unknown";
    const state = part.state as Record<string, unknown> | undefined;
    if (!state) return `**Tool: ${tool}**`;
    const status = state.status as string ?? "";
    const input = state.input as Record<string, unknown> | string | undefined;
    const output = state.output as string | undefined;
    const title = part.title as string | undefined;

    const parts: string[] = [];
    parts.push(`**Tool: ${tool}**${title ? ` — ${title}` : ""}${status ? ` (${status})` : ""}`);
    if (input) {
      const inputStr = typeof input === "string" ? input : JSON.stringify(input, null, 2);
      parts.push("```\n" + inputStr.slice(0, 2000) + "\n```");
    }
    if (output) {
      parts.push(output.slice(0, 2000));
    }
    return parts.join("\n");
  }

  // ── step_finish: step completed with cost/token info ──
  if (type === "step_finish" && part) {
    const reason = part.reason as string ?? "";
    const tokens = part.tokens as Record<string, number> | undefined;
    const cost = part.cost as number | undefined;
    const parts: string[] = [];
    if (cost != null) parts.push(`Cost: $${cost.toFixed(4)}`);
    if (tokens) {
      const t = tokens;
      const info = [`input: ${t.input ?? 0}`, `output: ${t.output ?? 0}`];
      if (t.reasoning) info.push(`reasoning: ${t.reasoning}`);
      if (t.total) info.push(`total: ${t.total}`);
      parts.push(`Tokens: ${info.join(", ")}`);
    }
    if (reason && reason !== "stop") parts.push(`Reason: ${reason}`);
    return parts.length > 0 ? `_${parts.join(" · ")}_` : null;
  }

  // ── step_start, file: skip (noise) ──
  // step_start is just a marker; file events duplicate tool_use info.
  return null;
}

function formatEvent(cli: CodingCli, ev: CliEvent): string | null {
  return cli === "claude"
    ? formatClaudeEvent(ev as ClaudeEvent)
    : formatOpenCodeEvent(ev as OpenCodeEvent);
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

    // ── Pre-flight: check CLI is available ──
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
    const taskDir = `/tmp/tianshu-coding-${task.id}`;
    const promptFile = `${taskDir}/prompt.txt`;
    const outputFile = `${taskDir}/output.ndjson`;
    const pidFile = `${taskDir}/cli.pid`;
    const exitFile = `${taskDir}/exit.code`;
    const prompt = buildCliPrompt(task, this.cfg.systemPrompt);

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
      await shell.exec({ command: `mkdir -p '${taskDir}'`, timeoutMs: 5000, signal });
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
      // claude -p reads prompt from stdin or argument
      cliCmd =
        `cd '${taskDir}' && cat prompt.txt | ${bin} -p -` +
        ` --output-format stream-json --verbose` +
        modelFlag;
    } else {
      // opencode run reads prompt from positional arg; use cat + xargs
      // to avoid shell escaping. --dangerously-skip-permissions for headless.
      cliCmd =
        `cd '${taskDir}' && ${bin} run` +
        ` --format json --dangerously-skip-permissions` +
        modelFlag +
        ` "$(cat prompt.txt)"`;
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

      // Read new bytes from output file.
      // dd skip=N reads from byte offset N. More reliable than tail -c
      // across platforms.
      let chunk = "";
      try {
        const res = await shell.exec({
          command: `dd if='${outputFile}' bs=1 skip=${fileOffset} 2>/dev/null || true`,
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

      fileOffset += Buffer.byteLength(chunk, "utf8");

      // Parse NDJSON events and write to session
      const events = parser.feed(chunk);
      for (const ev of events) {
        const text = formatEvent(cli, ev);
        if (!text) continue;
        appendSessionMessage(db, sessionId, "assistant", text);
        lastResultText = text;
        totalEvents++;

        // Extract final result for the task summary
        const evType = (ev as { type?: string }).type;
        if (evType === "result" || evType === "session.complete" || evType === "done") {
          const r = (ev as ClaudeEvent).result
            ?? (ev as OpenCodeEvent).text as string | undefined
            ?? text;
          if (r) lastResultText = String(r);
        }
      }
    }

    // ── Flush remaining buffered content ──
    const remaining = parser.flush();
    for (const ev of remaining) {
      const text = formatEvent(cli, ev);
      if (!text) continue;
      appendSessionMessage(db, sessionId, "assistant", text);
      lastResultText = text;
      totalEvents++;
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
          command: `kill $(cat '${pidFile}' 2>/dev/null) 2>/dev/null; rm -rf '${taskDir}'`,
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
          command: `kill $(cat '${pidFile}' 2>/dev/null) 2>/dev/null; rm -rf '${taskDir}'`,
          timeoutMs: 5000,
        });
      } catch { /* best effort */ }
    } else if (exitCode != null && exitCode !== 0) {
      status = "stalled";
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

    // ── Cleanup temp files ──
    try {
      await shell.exec({
        command: `rm -rf '${taskDir}'`,
        timeoutMs: 5000,
      });
    } catch { /* best effort */ }

    archiveSession(db, sessionId);

    log.info?.("coding-worker: finished", {
      taskId: task.id,
      cli,
      status,
      exitCode,
      sessionId,
      totalEvents,
    });

    return { status, resultSummary, sessionId };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
