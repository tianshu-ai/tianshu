// WorkBuddyWorker — delegates tasks to WorkBuddy AI desktop app via CDP.
//
// Flow:
//   1. On first run, sync helper scripts (wb-send.mjs, wb-history.mjs)
//      to the bridge machine at ~/.tianshu_shell/scripts/workbuddy/.
//   2. Send the task to WorkBuddy via `node wb-send.mjs --new "prompt"`.
//   3. Collect full conversation history via `node wb-history.mjs`.
//   4. Pass history to an LLM worker to summarize results.
//
// Scripts are bundled in the workboard plugin under scripts/workbuddy/.
// On each run, md5 is checked; mismatched files are overwritten.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  AgentLoopRunner,
  AgentLoopRunnerRequest,
  PluginLogger,
  TenantDbHandle,
} from "@tianshu-ai/plugin-sdk";
import type { Task } from "../db/tasks.js";
import type { WorkerHandle, TerminalUpdate } from "./pool.js";

/** Minimal shell runner interface (same as CodingWorker uses). */
interface ShellRunner {
  exec(opts: {
    command: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface WorkBuddyWorkerConfig {
  agentId: string;
  name: string;
  shell: ShellRunner;
  runner: AgentLoopRunner;
  db: TenantDbHandle;
  log: PluginLogger;
  cdpPort?: number;
  /** Max time to wait for WorkBuddy response (ms). */
  maxWaitMs?: number;
  timeouts?: AgentLoopRunnerRequest["timeouts"];
  systemPrompt?: string | null;
  modelId?: string | null;
}

const SCRIPTS_DIR = "scripts/workbuddy";
const REMOTE_DIR = "~/.tianshu_shell/scripts/workbuddy";
const SCRIPTS = ["wb-send.mjs", "wb-history.mjs"];

/** Read a bundled script from the plugin's scripts/ directory. */
function readBundledScript(name: string): string {
  // Resolve relative to this file's directory → ../scripts/workbuddy/
  const candidates = [
    path.join(import.meta.dirname ?? __dirname, "..", "..", SCRIPTS_DIR, name),
    path.join(import.meta.dirname ?? __dirname, "..", SCRIPTS_DIR, name),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, "utf8"); } catch { /* next */ }
  }
  throw new Error(`bundled script not found: ${name}`);
}

function md5(content: string): string {
  return crypto.createHash("md5").update(content).digest("hex");
}

/** Write content to a remote file via base64 (same as CodingWorker). */
async function writeRemoteFile(
  shell: ShellRunner,
  filePath: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  await shell.exec({
    command: `mkdir -p $(dirname '${filePath}') && { echo '${b64}' | base64 -d > '${filePath}' 2>/dev/null || echo '${b64}' | base64 -D > '${filePath}'; }`,
    timeoutMs: 10_000,
    signal,
  });
}

export class WorkBuddyWorker implements WorkerHandle {
  readonly kind = "workbuddy";
  readonly agentId: string;
  readonly name: string;

  private readonly cfg: WorkBuddyWorkerConfig;
  private synced = false;

  constructor(cfg: WorkBuddyWorkerConfig) {
    this.cfg = cfg;
    this.agentId = cfg.agentId;
    this.name = cfg.name;
  }

  async run(task: Task, signal: AbortSignal): Promise<TerminalUpdate> {
    const { shell, runner, db, log, cdpPort = 9229, maxWaitMs = 300_000 } = this.cfg;

    // ── Step 1: Sync scripts to bridge ──
    if (!this.synced) {
      try {
        await this.syncScripts(signal);
        this.synced = true;
      } catch (err) {
        log.warn("workbuddy: script sync failed", { error: String(err) });
        return {
          status: "stalled",
          resultSummary: `Failed to sync WorkBuddy scripts to bridge: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // ── Step 2: Send task to WorkBuddy ──
    const prompt = buildWorkBuddyPrompt(task);
    log.info("workbuddy: sending task", { taskId: task.id, promptLen: prompt.length });

    let sendResult: { ok: boolean; response?: string; error?: string; duration_ms?: number };
    try {
      // Escape the prompt for shell — use base64 to avoid quoting issues
      const b64Prompt = Buffer.from(prompt, "utf8").toString("base64");
      const sendCmd = `cd ${REMOTE_DIR} && echo '${b64Prompt}' | base64 -d | xargs -0 node wb-send.mjs --port ${cdpPort} --new`;
      // Actually, xargs -0 won't work well. Use a temp file approach:
      const tmpFile = `/tmp/wb-task-${task.id.slice(0, 8)}.txt`;
      await writeRemoteFile(shell, tmpFile, prompt, signal);

      const res = await shell.exec({
        command: `cd ${REMOTE_DIR} && node wb-send.mjs --port ${cdpPort} --new "$(cat '${tmpFile}')"`,
        timeoutMs: maxWaitMs + 30_000,
        signal,
      });

      try {
        sendResult = JSON.parse(res.stdout.trim());
      } catch {
        sendResult = { ok: false, error: `unexpected output: ${res.stdout.slice(0, 200)}` };
      }
    } catch (err) {
      return {
        status: "stalled",
        resultSummary: `WorkBuddy send failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!sendResult.ok) {
      return {
        status: "stalled",
        resultSummary: `WorkBuddy returned error: ${sendResult.error || "unknown"}`,
      };
    }

    // ── Step 3: Collect history ──
    let history: { ok: boolean; messages?: Array<{ role: string; text: string }>; error?: string } = { ok: false };
    try {
      const histRes = await shell.exec({
        command: `cd ${REMOTE_DIR} && node wb-history.mjs --port ${cdpPort}`,
        timeoutMs: 30_000,
        signal,
      });
      try {
        history = JSON.parse(histRes.stdout.trim());
      } catch {
        history = { ok: false, error: `parse error: ${histRes.stdout.slice(0, 200)}` };
      }
    } catch (err) {
      log.warn("workbuddy: history extraction failed", { error: String(err) });
    }

    // ── Step 4: Summarize via LLM ──
    const summaryPrompt = buildSummaryPrompt(task, sendResult, history);

    // Create a session for the summary
    const sessionId = `session_wb_${task.id.slice(0, 16)}`;
    try {
      db.prepare(
        `INSERT OR IGNORE INTO sessions (id, user_id, status, kind, created_at, title)
         VALUES (?, ?, 'active', 'system', ?, ?)`,
      ).run(sessionId, task.ownerUserId, Date.now(), `WorkBuddy: ${task.title}`);

      // Stamp session_id on the task so the Execution tab can show it
      db.prepare(`UPDATE tasks SET session_id = ? WHERE id = ?`).run(sessionId, task.id);
    } catch { /* best effort */ }

    let resultSummary = sendResult.response || "WorkBuddy completed the task.";

    try {
      let summaryText = "";
      await runner.run({
        userId: task.ownerUserId || "unknown",
        signal,
        initialUserMessage: summaryPrompt,
        systemPrompt: this.cfg.systemPrompt || SUMMARY_SYSTEM_PROMPT,
        modelId: this.cfg.modelId ?? undefined,
        toolsAllow: [], // summary doesn't need tools
        toolsDeny: [],
        sessionTitle: `WorkBuddy summary: ${task.title}`,
        workerRole: "workbuddy",
        workerSlug: this.cfg.agentId,
        timeouts: { maxRunMs: 60_000 },
        resumeSessionId: sessionId,

      });
      if (summaryText.trim()) resultSummary = summaryText.trim();
    } catch (err) {
      log.warn("workbuddy: LLM summary failed, using raw response", { error: String(err) });
    }

    return {
      status: "done",
      resultSummary,
    };
  }

  /** Sync bundled scripts to bridge, checking md5. */
  private async syncScripts(signal?: AbortSignal): Promise<void> {
    const { shell, log } = this.cfg;

    // Ensure remote dir exists + symlink bridge node_modules for ESM imports
    await shell.exec({
      command: `mkdir -p ${REMOTE_DIR} && if [ ! -e ${REMOTE_DIR}/node_modules ]; then ln -s ~/.tianshu-launcher/overrides/bridge/node_modules ${REMOTE_DIR}/node_modules 2>/dev/null || true; fi`,
      timeoutMs: 5_000,
      signal,
    });

    for (const name of SCRIPTS) {
      const local = readBundledScript(name);
      const localMd5 = md5(local);

      // Check remote md5
      let remoteMd5 = "";
      try {
        const res = await shell.exec({
          command: `md5sum ${REMOTE_DIR}/${name} 2>/dev/null | cut -d' ' -f1 || md5 -q ${REMOTE_DIR}/${name} 2>/dev/null || echo MISSING`,
          timeoutMs: 5_000,
          signal,
        });
        remoteMd5 = res.stdout.trim();
      } catch { /* missing */ }

      if (remoteMd5 === localMd5) {
        log.info(`workbuddy: ${name} up to date`);
        continue;
      }

      log.info(`workbuddy: syncing ${name}`, { localMd5, remoteMd5 });
      await writeRemoteFile(shell, `${REMOTE_DIR}/${name}`, local, signal);
    }
  }
}

const SUMMARY_SYSTEM_PROMPT = `You are a task result summarizer. Given a task description and the WorkBuddy AI's response, write a clear and concise summary of what was accomplished. Include key results, any files or artifacts produced, and whether the task appears completed successfully. Be factual and brief.`;

function buildWorkBuddyPrompt(task: Task): string {
  const parts = [task.title];
  if (task.description) parts.push(task.description);
  if ((task as any).acceptanceCriteria) parts.push(`Acceptance criteria: ${(task as any).acceptanceCriteria}`);
  return parts.join("\n\n");
}

function buildSummaryPrompt(
  task: Task,
  sendResult: { ok: boolean; response?: string; duration_ms?: number },
  history: { ok: boolean; messages?: Array<{ role: string; text: string }> },
): string {
  const parts = [
    `## Task`,
    task.title,
    task.description ? `\n${task.description}` : "",
    `\n## WorkBuddy Response (${sendResult.duration_ms ? `${(sendResult.duration_ms / 1000).toFixed(1)}s` : "unknown duration"})`,
    sendResult.response || "(no response)",
  ];

  if (history.ok && history.messages && history.messages.length > 0) {
    parts.push(`\n## Full Conversation History`);
    for (const msg of history.messages) {
      parts.push(`**${msg.role}**: ${msg.text}`);
    }
  }

  parts.push(`\n## Instructions`);
  parts.push(`Summarize the task result. Was it completed successfully? What was produced?`);

  return parts.join("\n");
}
