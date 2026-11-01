// WorkBuddyWorker — delegates tasks to WorkBuddy AI desktop app via CDP.
//
// Flow:
//   1. Sync helper scripts to bridge (~/.tianshu_shell/scripts/workbuddy/).
//   2. Send task to WorkBuddy via wb-send.mjs (returns immediately).
//   3. Loop: wb-status.mjs → LLM judges if done + estimates wait → sleep → repeat.
//   4. Once done, wb-history.mjs → LLM summarizes → return result.

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
  /** Max total time for the whole task (ms). Default 30 min. */
  maxTotalMs?: number;
  timeouts?: AgentLoopRunnerRequest["timeouts"];
  systemPrompt?: string | null;
  modelId?: string | null;
}

const SCRIPTS_DIR = "scripts/workbuddy";
const REMOTE_DIR = "~/.tianshu_shell/scripts/workbuddy";
const SCRIPTS = ["wb-send.mjs", "wb-status.mjs", "wb-history.mjs"];

function readBundledScript(name: string): string {
  const dir = (import.meta as any).dirname ?? __dirname;
  const candidates = [
    path.join(dir, "..", "..", SCRIPTS_DIR, name),
    path.join(dir, "..", SCRIPTS_DIR, name),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, "utf8"); } catch { /* next */ }
  }
  throw new Error(`bundled script not found: ${name}`);
}

function md5(content: string): string {
  return crypto.createHash("md5").update(content).digest("hex");
}

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
    const { shell, runner, db, log, cdpPort = 9229, maxTotalMs = 1_800_000 } = this.cfg;
    const deadline = Date.now() + maxTotalMs;

    // ── Step 1: Sync scripts ──
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

    // ── Step 2: Send task ──
    const prompt = buildWorkBuddyPrompt(task);
    log.info("workbuddy: sending task", { taskId: task.id, promptLen: prompt.length });

    const tmpFile = `/tmp/wb-task-${task.id.slice(0, 8)}.txt`;
    try {
      await writeRemoteFile(shell, tmpFile, prompt, signal);
      const res = await shell.exec({
        command: `cd ${REMOTE_DIR} && node wb-send.mjs --port ${cdpPort} --new "$(cat '${tmpFile}')"`,
        timeoutMs: 30_000,
        signal,
      });
      const sendResult = JSON.parse(res.stdout.trim());
      if (!sendResult.ok) {
        return { status: "stalled", resultSummary: `WorkBuddy send failed: ${sendResult.error}` };
      }
    } catch (err) {
      return { status: "stalled", resultSummary: `WorkBuddy send failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    log.info("workbuddy: task sent, entering poll loop");

    // ── Step 3: LLM-driven wait loop ──
    // First estimate: ask LLM how long this task might take
    let sleepMs = await this.estimateWait(task, runner, signal);

    while (Date.now() < deadline) {
      if (signal.aborted) return { status: "aborted", resultSummary: "Task aborted" };

      log.info(`workbuddy: sleeping ${Math.round(sleepMs / 1000)}s before next check`);
      await sleep(sleepMs, signal);
      if (signal.aborted) return { status: "aborted", resultSummary: "Task aborted" };

      // Check status
      let status: WorkBuddyStatus;
      try {
        const res = await shell.exec({
          command: `cd ${REMOTE_DIR} && node wb-status.mjs --port ${cdpPort}`,
          timeoutMs: 30_000,
          signal,
        });
        status = JSON.parse(res.stdout.trim());
      } catch (err) {
        log.warn("workbuddy: status check failed", { error: String(err) });
        sleepMs = 15_000; // retry soon
        continue;
      }

      if (!status.ok) {
        log.warn("workbuddy: status error", { error: status.error });
        sleepMs = 15_000;
        continue;
      }

      // Ask LLM to judge
      const judgment = await this.judgeCompletion(task, status, runner, signal);

      if (judgment.done) {
        log.info("workbuddy: LLM judged task complete");
        break;
      }

      sleepMs = Math.max(5_000, Math.min(judgment.waitMs, 120_000));
      log.info(`workbuddy: LLM says wait ${Math.round(sleepMs / 1000)}s more`, { reason: judgment.reason });
    }

    // ── Step 4: Collect history & summarize ──
    let history = "";
    try {
      const res = await shell.exec({
        command: `cd ${REMOTE_DIR} && node wb-history.mjs --port ${cdpPort}`,
        timeoutMs: 30_000,
        signal,
      });
      history = res.stdout.trim();
    } catch (err) {
      log.warn("workbuddy: history collection failed", { error: String(err) });
    }

    // LLM summary
    const sessionId = `session_wb_${task.id.slice(0, 16)}`;
    try {
      db.prepare(
        `INSERT OR IGNORE INTO sessions (id, user_id, status, kind, created_at, title)
         VALUES (?, ?, 'active', 'system', ?, ?)`,
      ).run(sessionId, task.ownerUserId, Date.now(), `WorkBuddy: ${task.title}`);
      db.prepare(`UPDATE tasks SET session_id = ? WHERE id = ?`).run(sessionId, task.id);
    } catch { /* best effort */ }

    const summaryPrompt = buildSummaryPrompt(task, history);
    let resultSummary = "WorkBuddy completed the task.";

    try {
      await runner.run({
        userId: task.ownerUserId || "unknown",
        signal,
        initialUserMessage: summaryPrompt,
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        modelId: this.cfg.modelId ?? undefined,
        toolsAllow: [],
        toolsDeny: [],
        sessionTitle: `WorkBuddy summary: ${task.title}`,
        workerRole: "workbuddy",
        workerSlug: this.cfg.agentId,
        timeouts: { maxRunMs: 60_000 },
        resumeSessionId: sessionId,
      });
      // Read the summary from the session's last assistant message
      const row = db.prepare(
        `SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
      ).get(sessionId) as { content: string } | undefined;
      if (row?.content) resultSummary = row.content;
    } catch (err) {
      log.warn("workbuddy: LLM summary failed", { error: String(err) });
    }

    return { status: "done", resultSummary };
  }

  /** Ask LLM to estimate initial wait time based on task complexity. */
  private async estimateWait(task: Task, runner: AgentLoopRunner, signal: AbortSignal): Promise<number> {
    try {
      const sessionId = `session_wb_est_${Date.now()}`;
      this.cfg.db.prepare(
        `INSERT OR IGNORE INTO sessions (id, user_id, status, kind, created_at, title)
         VALUES (?, ?, 'active', 'system', ?, 'wb-estimate')`,
      ).run(sessionId, task.ownerUserId, Date.now());

      await runner.run({
        userId: task.ownerUserId || "unknown",
        signal,
        initialUserMessage: `Task sent to WorkBuddy AI: "${task.title}"\n${task.description || ""}\n\nEstimate how many seconds WorkBuddy will need to complete this task. Consider: simple questions ~10s, writing tasks ~30s, research tasks ~120s, complex multi-step tasks ~300s.\n\nRespond with ONLY a number (seconds). Nothing else.`,
        systemPrompt: "You estimate task completion times. Respond with only a number.",
        modelId: this.cfg.modelId ?? undefined,
        toolsAllow: [],
        toolsDeny: [],
        sessionTitle: "wb-estimate",
        workerRole: "workbuddy",
        workerSlug: this.cfg.agentId,
        timeouts: { maxRunMs: 15_000 },
        resumeSessionId: sessionId,
      });

      const row = this.cfg.db.prepare(
        `SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
      ).get(sessionId) as { content: string } | undefined;

      // Cleanup
      try {
        this.cfg.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
        this.cfg.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      } catch { /* best effort */ }

      const seconds = parseInt(row?.content?.trim() || "30", 10);
      return Math.max(5, Math.min(seconds, 600)) * 1000;
    } catch {
      return 30_000; // default 30s
    }
  }

  /** Ask LLM to judge if the task is complete based on current status. */
  private async judgeCompletion(
    task: Task,
    status: WorkBuddyStatus,
    runner: AgentLoopRunner,
    signal: AbortSignal,
  ): Promise<{ done: boolean; waitMs: number; reason: string }> {
    try {
      const sessionId = `session_wb_judge_${Date.now()}`;
      this.cfg.db.prepare(
        `INSERT OR IGNORE INTO sessions (id, user_id, status, kind, created_at, title)
         VALUES (?, ?, 'active', 'system', ?, 'wb-judge')`,
      ).run(sessionId, task.ownerUserId, Date.now());

      const judgePrompt = [
        `Task: "${task.title}"`,
        task.description ? `Description: ${task.description}` : "",
        ``,
        `WorkBuddy current state:`,
        `- Status indicator: ${status.status}`,
        `- isComplete flag: ${status.isComplete}`,
        `- isRunning flag: ${status.isRunning}`,
        `- Status text: ${status.statusText || "(none)"}`,
        `- Last agent response (truncated): ${(status.lastAgentText || "(none)").slice(0, 1000)}`,
        ``,
        `Is this task done? Respond in exactly this JSON format:`,
        `{"done": true/false, "waitSeconds": <number>, "reason": "<brief explanation>"}`,
        ``,
        `If "已完成" appears in status or the agent gave a complete answer, it's done.`,
        `If still running/thinking, estimate how many more seconds to wait.`,
      ].filter(Boolean).join("\n");

      await runner.run({
        userId: task.ownerUserId || "unknown",
        signal,
        initialUserMessage: judgePrompt,
        systemPrompt: "You judge task completion. Respond with only JSON.",
        modelId: this.cfg.modelId ?? undefined,
        toolsAllow: [],
        toolsDeny: [],
        sessionTitle: "wb-judge",
        workerRole: "workbuddy",
        workerSlug: this.cfg.agentId,
        timeouts: { maxRunMs: 15_000 },
        resumeSessionId: sessionId,
      });

      const row = this.cfg.db.prepare(
        `SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
      ).get(sessionId) as { content: string } | undefined;

      // Cleanup
      try {
        this.cfg.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
        this.cfg.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      } catch { /* best effort */ }

      const text = row?.content?.trim() || "";
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return {
          done: !!parsed.done,
          waitMs: Math.max(5, Number(parsed.waitSeconds) || 30) * 1000,
          reason: parsed.reason || "",
        };
      }
    } catch { /* fall through */ }

    // Default: not done, wait 30s
    return { done: false, waitMs: 30_000, reason: "judgment failed, retrying" };
  }

  /** Sync bundled scripts to bridge, checking md5. */
  private async syncScripts(signal?: AbortSignal): Promise<void> {
    const { shell, log } = this.cfg;

    await shell.exec({
      command: `mkdir -p ${REMOTE_DIR} && if [ ! -e ${REMOTE_DIR}/node_modules ]; then ln -s ~/.tianshu-launcher/overrides/bridge/node_modules ${REMOTE_DIR}/node_modules 2>/dev/null || true; fi`,
      timeoutMs: 5_000,
      signal,
    });

    for (const name of SCRIPTS) {
      const local = readBundledScript(name);
      const localMd5 = md5(local);

      let remoteMd5 = "";
      try {
        const res = await shell.exec({
          command: `md5sum ${REMOTE_DIR}/${name} 2>/dev/null | cut -d' ' -f1 || md5 -q ${REMOTE_DIR}/${name} 2>/dev/null || echo MISSING`,
          timeoutMs: 5_000,
          signal,
        });
        remoteMd5 = res.stdout.trim();
      } catch { /* missing */ }

      if (remoteMd5 === localMd5) continue;

      log.info(`workbuddy: syncing ${name}`, { localMd5, remoteMd5 });
      await writeRemoteFile(shell, `${REMOTE_DIR}/${name}`, local, signal);
    }
  }
}

interface WorkBuddyStatus {
  ok: boolean;
  status?: string;
  isComplete?: boolean;
  isRunning?: boolean;
  lastAgentText?: string;
  lastUserText?: string;
  statusText?: string;
  pageText?: string;
  error?: string;
}

const SUMMARY_SYSTEM_PROMPT = `You summarize task results from WorkBuddy AI. Given the task description and conversation history, write a clear summary of what was accomplished. Be factual and concise.`;

function buildWorkBuddyPrompt(task: Task): string {
  const parts = [task.title];
  if (task.description) parts.push(task.description);
  if ((task as any).acceptanceCriteria) parts.push(`Acceptance criteria: ${(task as any).acceptanceCriteria}`);
  return parts.join("\n\n");
}

function buildSummaryPrompt(task: Task, historyJson: string): string {
  let historyText = "";
  try {
    const h = JSON.parse(historyJson);
    if (h.ok && h.messages) {
      historyText = h.messages.map((m: any) => `**${m.role}**: ${m.text}`).join("\n\n");
    }
  } catch {
    historyText = historyJson.slice(0, 3000);
  }

  return [
    `## Task`,
    task.title,
    task.description || "",
    `## WorkBuddy Conversation`,
    historyText || "(no history captured)",
    `## Instructions`,
    `Summarize what WorkBuddy accomplished. Was the task completed? What were the key results?`,
  ].join("\n\n");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("aborted")); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  });
}
