// In-memory worker pool.
//
// One pool per active tenant. Each "slot" inside the pool wraps a
// configured worker agent (host table `worker_agents`, declared by
// migration 003-worker-agents and seeded by plugins via the
// `defaultWorkerAgents` manifest contribution).
//
// Lifecycle of a task:
//   1. Anyone (REST, agent tool, kanban UI) writes a `todo` row and
//      nudges the pool.
//   2. Each non-busy slot calls `claimNextTask` with its agent id +
//      kind-derived role; SQLite's serialised writer makes the
//      claim atomic. Tasks pinned to a different agent are skipped.
//   3. The slot's `WorkerHandle.run()` does the real work and
//      resolves with a terminal status. v0.2 ships one runtime,
//      `echo`, that just sleeps + reflects the title; real LLM /
//      tool runtimes ship later as separate plugins (ADR-0002 §1).
//
// `nudge()` is event-driven: every write path calls it. There's no
// polling loop. On plugin activate we also call `recoverOrphaned`
// once to flip in-flight tasks (left over from a process crash)
// back to `todo`.
//
// `rebuild()` lets the host call back when the agent list changes
// (create / patch / delete / reset). The new slot set is computed
// from a fresh agent snapshot; in-flight slots that still match an
// agent id keep going (no work is killed).

import type {
  AgentLoopRunner,
  AgentLoopRunnerRequest,
  PluginLogger,
  TenantDbHandle,
} from "@tianshu/plugin-sdk";
import { claimNextTask, getTask, updateTask, type Task } from "../db/tasks.js";

/**
 * After this many failed runs in a row, the pool stops re-queueing
 * the task and parks it in `stalled` for the user to deal with.
 * Matches the closed-source predecessor's MAX_ATTEMPTS.
 */
export const MAX_ATTEMPTS = 3;

/** What a single slot promises to do with one claimed task.
 *  Resolves with the task's terminal state — usually `done`, but a
 *  worker may legitimately mark a task `stalled` if it gives up. */
export interface WorkerHandle {
  /** Stable id of the underlying `worker_agents` row. */
  agentId: string;
  /** Display label for the kanban sidebar / status endpoint. */
  name: string;
  /** Runtime kind (`echo`, `llm`, ...). Used for `worker_role`
   *  fallback so legacy task pinning keeps working. */
  kind: string;
  run(task: Task): Promise<TerminalUpdate>;
}

export interface TerminalUpdate {
  status: "done" | "stalled" | "aborted";
  resultSummary?: string | null;
  resultFiles?: string[];
}

/** Snapshot row the pool needs about each worker_agents entry.
 *  Re-declared structurally so the pool doesn't depend on either
 *  the host's row type or the workboard plugin's local view. */
export interface AgentSpec {
  id: string;
  kind: string;
  name: string;
}

export type WorkerHandleFactory = (agent: AgentSpec) => WorkerHandle | null;

export interface WorkerPoolDeps {
  db: TenantDbHandle;
  log: PluginLogger;
  /** Notifies subscribers (chat shell) that a task changed. */
  broadcast(type: string, payload: unknown): void;
  /**
   * Optional inbox sink. When the task being completed has a
   * `parentSessionId` (typically a chat session whose LLM called
   * `task_create`), the pool drops a one-line `task_done` /
   * `task_stalled` message into that session's inbox so the
   * asking agent picks up the result on its next turn.
   *
   * Optional because a tenant can disable the inbox capability
   * (or the inbox plugin can fail-open) without breaking pool
   * operation — we just skip the notification.
   */
  notifyParentSession?: (
    parentSessionId: string,
    message: { kind: "task_done" | "task_stalled"; text: string; meta?: Record<string, unknown> },
  ) => void;
  /** Initial set of agent specs. Replace later via `rebuild`. */
  agents: AgentSpec[];
  /** Returns a `WorkerHandle` for an agent, or null if the kind
   *  isn't supported (e.g. an LLM agent on a build that hasn't
   *  shipped that runtime yet). Null kinds are skipped quietly. */
  factory: WorkerHandleFactory;
  /** Optional fallback poll interval in ms. The pool is
   *  primarily event-driven (`nudge` on every write path), but a
   *  cheap periodic drain catches tasks that became eligible
   *  through a code path that forgot to nudge — plus anything
   *  triggered outside the workboard plugin (direct DB writes,
   *  cron jobs). 0 disables. Default 15_000. */
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 15_000;

export class WorkerPool {
  private nudgeTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  /** agentId → "in-flight task id" (or undefined = idle). */
  private busy = new Map<string, string>();
  private workers: WorkerHandle[] = [];
  private stopped = false;

  constructor(private deps: WorkerPoolDeps) {
    this.workers = this.buildHandles(deps.agents);
  }

  /** Drain orphaned in_progress rows + kick off processing. */
  start(): void {
    this.recoverOrphaned();
    this.nudge();
    // Fallback periodic drain. The pool is primarily event-driven,
    // but a cheap interval catches tasks that became eligible
    // through a code path that forgot to call onTaskWrite() (e.g.
    // a worker outside this plugin marking its predecessor done).
    // The work itself is `claimNextTask` which is a single SQLite
    // SELECT — it costs effectively nothing when the queue is
    // empty, so we don't need to be clever about scheduling.
    const poll = this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (poll > 0) {
      this.pollTimer = setInterval(() => {
        if (!this.stopped) this.nudge();
      }, poll);
      // Don't keep the process alive just for the poll timer.
      this.pollTimer.unref?.();
    }
  }

  /** Mark the pool stopped. Any work already in flight finishes;
   *  no further claims happen. */
  stop(): void {
    this.stopped = true;
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Replace the agent set (host calls this after worker_agents
   *  rows change). In-flight agents that survive the swap keep
   *  draining their current task; agents that vanished are
   *  abandoned (their in-flight task will end and just not be
   *  re-claimed). */
  rebuild(agents: AgentSpec[]): void {
    if (this.stopped) return;
    const next = this.buildHandles(agents);
    // Drop busy entries whose agent no longer exists, so a future
    // resurrection of the same id starts clean.
    const survivingIds = new Set(next.map((w) => w.agentId));
    for (const id of [...this.busy.keys()]) {
      if (!survivingIds.has(id)) this.busy.delete(id);
    }
    this.workers = next;
    this.deps.log.info("workboard: rebuilt pool", {
      workerCount: next.length,
      agents: next.map((w) => ({ id: w.agentId, kind: w.kind })),
    });
    this.nudge();
  }

  /** Snapshot for the admin page + `GET /workers/status`. */
  status(): { workers: { agentId: string; name: string; kind: string; busy: boolean }[]; running: string[] } {
    return {
      workers: this.workers.map((w) => ({
        agentId: w.agentId,
        name: w.name,
        kind: w.kind,
        busy: this.busy.has(w.agentId),
      })),
      running: [...this.busy.values()],
    };
  }

  /** Schedule one drain pass on the next tick. Called from the
   *  REST handler / agent tool every time a new task lands. */
  nudge(): void {
    if (this.stopped) return;
    if (this.nudgeTimer) return; // coalesce multiple nudges
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      void this.drain();
    }, 0);
  }

  // ─── internals ─────────────────────────────────────────

  private buildHandles(agents: AgentSpec[]): WorkerHandle[] {
    const out: WorkerHandle[] = [];
    for (const a of agents) {
      const handle = this.deps.factory(a);
      if (!handle) {
        this.deps.log.info("workboard: skipping agent (kind unsupported)", {
          agentId: a.id,
          kind: a.kind,
          name: a.name,
        });
        continue;
      }
      out.push(handle);
    }
    return out;
  }

  private async drain(): Promise<void> {
    if (this.stopped) return;

    for (const worker of this.workers) {
      if (this.busy.has(worker.agentId)) continue;
      const claimed = claimNextTask(this.deps.db, {
        workerAgentId: worker.agentId,
        workerRole: worker.kind,
      });
      if (!claimed) continue;

      this.busy.set(worker.agentId, claimed.id);
      this.deps.broadcast("workboard.task", {
        kind: "claimed",
        taskId: claimed.id,
        workerAgentId: worker.agentId,
        workerName: worker.name,
      });
      this.deps.log.info("workboard: claimed task", {
        taskId: claimed.id,
        agentId: worker.agentId,
        worker: worker.name,
        title: claimed.title,
      });

      // Run the worker async so we don't block the drain loop.
      void this.runOne(worker, claimed).finally(() => {
        this.busy.delete(worker.agentId);
        // After one completion there might be more tasks waiting —
        // re-nudge so the pool keeps draining.
        if (!this.stopped) this.nudge();
      });
    }
  }

  private async runOne(worker: WorkerHandle, task: Task): Promise<void> {
    let update: TerminalUpdate;
    try {
      update = await worker.run(task);
    } catch (err) {
      this.deps.log.error("workboard: worker threw", {
        taskId: task.id,
        agentId: worker.agentId,
        worker: worker.name,
        err: err instanceof Error ? err.message : String(err),
      });
      update = {
        status: "stalled",
        resultSummary: `Worker error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (this.stopped) return;

    const now = Date.now();
    if (update.status === "done") {
      // Success: clear the failure trail and reset the attempt
      // counter so future re-runs (e.g. a follow-up edit + manual
      // re-queue) start clean. Also drop the `stalled` label —
      // a manual retry that succeeds shouldn't leave the warning
      // badge stuck on the card.
      const fresh = getTask(this.deps.db, task.id) ?? task;
      const cleanedLabels = fresh.labels.filter((l) => l !== "stalled");
      updateTask(this.deps.db, task.id, {
        status: "done",
        resultSummary: update.resultSummary ?? null,
        resultFiles: update.resultFiles ?? [],
        failureReason: null,
        labels: cleanedLabels,
        attempts: 0,
        endedAt: now,
      });
    } else {
      // Failure (`stalled` / `aborted` from agent-loop, or a worker
      // exception). Bump attempts and decide whether to re-queue
      // automatically or surface the failure.
      //
      // Failure stays in the `ready` status throughout — the task
      // never leaves the kanban's ready column. Once attempts
      // crosses MAX_ATTEMPTS we stamp a `stalled` LABEL, which
      // takes the row out of the pool's claim filter (see
      // POOL_SKIP_LABELS in db/tasks.ts) without hiding it from
      // the user. Mirrors the closed-source predecessor.
      //
      // We re-read the row to get the up-to-date attempts count —
      // the task came in with the value at claim time, but
      // intervening user edits could have changed it (e.g. user
      // PATCHed back to ready and reset attempts).
      const fresh = getTask(this.deps.db, task.id) ?? task;
      const nextAttempts = (fresh.attempts ?? 0) + 1;
      const reason =
        update.resultSummary ?? `worker ${update.status} without summary`;
      const giveUp = nextAttempts >= MAX_ATTEMPTS;
      const baseLabels = fresh.labels.filter((l) => l !== "stalled");
      const nextLabels = giveUp ? [...baseLabels, "stalled"] : baseLabels;
      updateTask(this.deps.db, task.id, {
        status: "ready",
        // Keep the result_summary clean for `done` only; failures
        // live in `failure_reason` so the UI can render a warning
        // chip without cluttering successful summaries.
        resultSummary: null,
        resultFiles: update.resultFiles ?? [],
        failureReason: reason,
        attempts: nextAttempts,
        labels: nextLabels,
        // Keep session_id pointing at the most recent run — the
        // user / chat agent uses it to inspect the failure
        // transcript via task_get_history. Clearing started_at
        // is fine because the next claim will re-stamp it; the
        // session stays linked even across retries (a fresh run
        // overwrites with its own session_id at claim time).
        startedAt: null,
        // Stamp ended_at on the give-up case so the timeline shows
        // when the task was parked.
        endedAt: giveUp ? now : null,
      });
    }
    this.deps.broadcast("workboard.task", {
      kind: "completed",
      taskId: task.id,
      workerAgentId: worker.agentId,
      workerName: worker.name,
      status: update.status,
    });
    this.deps.log.info("workboard: task completed", {
      taskId: task.id,
      agentId: worker.agentId,
      worker: worker.name,
      status: update.status,
    });

    // Drop a system-level note into the asking session's inbox.
    // Done case is fire-and-forget good news; stalled is only
    // emitted on FINAL stall (attempts hit MAX_ATTEMPTS), not on
    // every retry — we don't want the agent to react to
    // intermediate failures the pool will retry on its own.
    //
    // We re-read the task because `update*` calls above may have
    // mutated labels/attempts and we want the truthful end-state
    // to base the giveUp decision on.
    if (this.deps.notifyParentSession && task.parentSessionId) {
      try {
        const finalRow = getTask(this.deps.db, task.id);
        const labels = finalRow?.labels ?? [];
        const stalledNow = labels.includes("stalled");
        if (update.status === "done") {
          this.deps.notifyParentSession(task.parentSessionId, {
            kind: "task_done",
            text:
              `Task "${task.title}" finished. Summary: ${update.resultSummary ?? "(none)"}` +
              (update.resultFiles && update.resultFiles.length > 0
                ? `\nFiles: ${update.resultFiles.join(", ")}`
                : ""),
            meta: {
              taskId: task.id,
              workerAgentId: worker.agentId,
              files: update.resultFiles ?? [],
            },
          });
        } else if (stalledNow) {
          this.deps.notifyParentSession(task.parentSessionId, {
            kind: "task_stalled",
            text:
              `Task "${task.title}" stalled after ${MAX_ATTEMPTS} attempts. ` +
              `Last error: ${update.resultSummary ?? "(no summary)"}`,
            meta: {
              taskId: task.id,
              workerAgentId: worker.agentId,
              attempts: finalRow?.attempts ?? null,
            },
          });
        }
        // intermediate retries (status!=done && !stalledNow) — silent
      } catch (err) {
        // notifyParentSession is best-effort; a failure must not
        // break the pool. Log and continue.
        this.deps.log.warn("workboard: notifyParentSession failed", {
          taskId: task.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // After a failure that goes back to ready, kick the pool so
    // another slot can pick it up (or the same slot after another
    // task) without waiting for the timer.
    if (update.status !== "done" && !this.stopped) this.nudge();
  }

  private recoverOrphaned(): void {
    // Any task left in `in_progress` when this pool boots is by
    // definition orphaned: the previous host process died (crash,
    // restart, dev-time `touch index.ts`) while a worker was
    // mid-run, and there's no in-memory busy slot to inherit.
    //
    // We treat it like a stall — bump attempts, stamp a failure
    // reason, and put the row back in the ready column. Without
    // bumping, a flapping host could claim the same task 100
    // times before noticing nothing was making progress; with the
    // bump, after MAX_ATTEMPTS the row gets the `stalled` label
    // and the user has to clear it explicitly to retry.
    //
    // session_id is intentionally NOT cleared here: the previous
    // transcript is still useful for debugging "why did this
    // crash?". The next claim overwrites session_id anyway, so
    // the row only ever points at the most recent run.
    const orphans = this.deps.db
      .prepare<
        [],
        { id: string; attempts: number | null; labels: string }
      >(
        `SELECT id, attempts, labels FROM tasks WHERE status = 'in_progress'`,
      )
      .all();
    if (orphans.length === 0) return;
    const update = this.deps.db.prepare(
      `UPDATE tasks
         SET status = 'ready',
             started_at = NULL,
             attempts = ?,
             failure_reason = ?,
             labels = ?
       WHERE id = ?`,
    );
    for (const row of orphans) {
      const nextAttempts = (row.attempts ?? 0) + 1;
      const giveUp = nextAttempts >= MAX_ATTEMPTS;
      // Parse labels (TEXT JSON column). On a parse failure fall
      // back to []: the task will surface as ready/un-stalled,
      // which is recoverable, vs. a sql error which would
      // crash boot.
      let labels: string[] = [];
      try {
        const parsed = JSON.parse(row.labels);
        if (Array.isArray(parsed)) {
          labels = parsed.filter((l): l is string => typeof l === "string");
        }
      } catch {
        labels = [];
      }
      const baseLabels = labels.filter((l) => l !== "stalled");
      const nextLabels = giveUp ? [...baseLabels, "stalled"] : baseLabels;
      update.run(
        nextAttempts,
        "reclaimed after host restart (worker did not finish)",
        JSON.stringify(nextLabels),
        row.id,
      );
    }
    this.deps.log.info("workboard: reclaimed orphaned in_progress tasks", {
      count: orphans.length,
    });
  }
}

/** Echo worker — useful as a v0.2 demo and a regression test bed. */
export class EchoWorker implements WorkerHandle {
  readonly kind = "echo";

  /** Default 30s; tests pass a smaller value. */
  constructor(
    public readonly agentId: string,
    public readonly name: string,
    private opts: { delayMs?: number; signal?: AbortSignal } = {},
  ) {}

  async run(task: Task): Promise<TerminalUpdate> {
    const ms = this.opts.delayMs ?? 30_000;
    await sleep(ms, this.opts.signal);
    return {
      status: "done",
      resultSummary: `Echo worker reflected: "${task.title}"`,
    };
  }
}

/**
 * LLM worker. Delegates the heavy lifting (model call, tool loop,
 * session persistence, timeouts) to the host's `host.agentLoop`
 * capability — this class just translates between the workboard's
 * Task shape and the runner's request/result shape.
 *
 * Per-agent overrides come from the `worker_agents` row that
 * spawned this handle (system prompt, model, allowed tools/skills).
 * Plugin-wide timeouts come from `plugins.workboard.config.llm.*`.
 */
export interface LLMWorkerConfig {
  agentId: string;
  name: string;
  /** ownerUserId of the task we'll run. The runner needs a userId
   *  to scope tool contexts and the worker session row. */
  defaultUserId: string;
  systemPrompt?: string | null;
  modelId?: string | null;
  toolsAllow?: string[] | null;
  skillsAllow?: string[] | null;
  timeouts?: AgentLoopRunnerRequest["timeouts"];
  runner: AgentLoopRunner;
  log: PluginLogger;
  /** DB handle for stamping `tasks.session_id` early so the
   *  Execution tab can tail an in-progress conversation. */
  db: TenantDbHandle;
}

/**
 * Workboard task-management tools that the host (chat) needs but a
 * worker has no business calling. A worker is meant to *do* a task,
 * not create / move / delete / list other tasks. Without this
 * deny-list a worker can confuse `task_complete` with
 * `task_create` and end up dropping a phantom todo on the board
 * (we caught this on the LangGraph T1 run).
 *
 * `task_complete` is the legitimate exit signal so it stays.
 */
const WORKER_DENY_TOOLS = new Set<string>([
  "task_list",
  "task_create",
  "task_update",
  "task_move",
  "task_delete",
  // History is for the orchestrator/user explaining a task,
  // not for the worker introspecting its peers.
  "task_get_history",
]);

/**
 * Tools that the worker MUST have available, no matter what the
 * user configured per-agent. `task_complete` is the only legitimate
 * exit signal a worker has — if the user trims it out of
 * `toolsAllow`, the worker can't tell the orchestrator it's done
 * and the run will time out / be killed for stalling, even on a
 * perfectly-completed task. So we force-inject it here at the pool
 * boundary, after the user's allow-list has been applied.
 *
 * Keep this list small; anything in here is something the worker
 * runtime depends on for control-flow correctness, NOT something
 * an agent designer might want to choose.
 */
const WORKER_REQUIRED_TOOLS = ["task_complete"] as const;

/**
 * Combine the user-supplied `toolsAllow` (per-agent allow-list) with
 * the worker-wide deny-list and required-list above.
 *
 *   - cfg.toolsAllow == null → "all tools". The runner sees an
 *     undefined allow-list (= no narrowing) and `toolsDeny` does the
 *     scrubbing. task_complete is automatically in the all-tools
 *     set, so we don't need to inject it here.
 *   - cfg.toolsAllow is a list → strip the deny set from it AND
 *     ensure the required-set is present, so the user can't
 *     accidentally lock the worker out of its own exit hatch.
 *
 * NOTE: the deny set is enforced again inside `agent-loop.ts` so the
 * pool agent and the loop are belt-and-braces protected.
 */
export function effectiveToolsAllow(
  cfgToolsAllow: string[] | null | undefined,
): string[] | undefined {
  if (!cfgToolsAllow) return undefined;
  const filtered = cfgToolsAllow.filter((t) => !WORKER_DENY_TOOLS.has(t));
  // Force-inject required tools the user may have omitted. We add
  // rather than replace so the rest of their curated allow-list
  // stays intact.
  for (const t of WORKER_REQUIRED_TOOLS) {
    if (!filtered.includes(t)) filtered.push(t);
  }
  return filtered;
}

export class LLMWorker implements WorkerHandle {
  readonly kind = "llm";
  readonly agentId: string;
  readonly name: string;

  constructor(private readonly cfg: LLMWorkerConfig) {
    this.agentId = cfg.agentId;
    this.name = cfg.name;
  }

  async run(task: Task): Promise<TerminalUpdate> {
    const userId = task.ownerUserId || this.cfg.defaultUserId;
    // Retry semantics:
    //   - First attempt (attempts=0)               → fresh session,
    //                                                  full task brief.
    //   - Retry with prior session_id present       → resume that
    //                                                  session and
    //                                                  send a short
    //                                                  retry nudge
    //                                                  instead of
    //                                                  re-pasting the
    //                                                  whole task.
    //   - Retry without prior session_id (rare:
    //     legacy task or DB inconsistency)          → fall back to
    //                                                  fresh session.
    const isRetry = (task.attempts ?? 0) > 0 && Boolean(task.sessionId);
    const initialUserMessage = isRetry
      ? buildRetryPrompt(task)
      : buildInitialPrompt(task);
    const result = await this.cfg.runner.run({
      userId,
      initialUserMessage,
      systemPrompt: this.cfg.systemPrompt ?? undefined,
      modelId: this.cfg.modelId ?? undefined,
      toolsAllow: effectiveToolsAllow(this.cfg.toolsAllow),
      toolsDeny: Array.from(WORKER_DENY_TOOLS),
      skillsAllow: this.cfg.skillsAllow ?? undefined,
      sessionTitle: task.title,
      workerRole: this.kind,
      timeouts: this.cfg.timeouts,
      // Resume the prior conversation when retrying so the LLM
      // sees its own earlier work + tool results, doesn't waste
      // a full re-research cycle, and — critically for the user
      // — the kanban Execution dialog shows one continuous
      // transcript across attempts instead of N independent
      // session windows.
      resumeSessionId: isRetry ? task.sessionId ?? undefined : undefined,
      // Stamp the session id on the task row as soon as the host
      // creates the session, not when the run terminates. The
      // kanban Execution tab tails this in-progress conversation
      // via /tasks/:id/history; without an early stamp the tab
      // can't find a session id until the LLM finishes.
      onSessionStart: (sessionId) => {
        try {
          updateTask(this.cfg.db, task.id, { sessionId });
        } catch (err) {
          this.cfg.log.warn("workboard: stamp sessionId on task failed", {
            taskId: task.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    this.cfg.log.info("llm worker terminal", {
      agentId: this.agentId,
      taskId: task.id,
      status: result.status,
      reason: result.reason,
      sessionId: result.sessionId,
      turns: result.turns,
    });

    if (result.status === "done") {
      return {
        status: "done",
        resultSummary: result.summary,
        resultFiles: result.files,
      };
    }
    if (result.status === "aborted") {
      return {
        status: "aborted",
        resultSummary: result.summary || "aborted",
      };
    }
    // stalled / error → stalled (keeps task on the kanban so the
    // user can see the failure and decide whether to retry).
    return {
      status: "stalled",
      resultSummary:
        `[${result.reason}] ${result.summary}`.slice(0, 800) ||
        "worker stalled",
    };
  }
}

function buildInitialPrompt(task: Task): string {
  const lines = [`Execute the task: "${task.title}".`];
  if (task.description && task.description.trim()) {
    lines.push("", `Details:`, task.description.trim());
  }
  lines.push(
    "",
    `When you finish, call the \`task_complete\` tool with a one-line ` +
      `\`summary\` of what you produced and (optional) a list of \`files\` ` +
      `you wrote. Don't reply with prose alone — the orchestrator only sees ` +
      `the summary you pass to task_complete.`,
  );
  return lines.join("\n");
}

/**
 * Prompt used when a task is being retried in a resumed session.
 *
 * The LLM already sees its prior turns + tool results in context,
 * so we only nudge it about the missing exit signal. We also tell
 * it the attempt count so it can decide "finalize now" vs. "keep
 * digging" — if attempts is high, that's a hint to wrap up.
 *
 * Why we don't repeat the full task brief: the original prompt is
 * still at the top of the resumed transcript. Repeating it would
 * just inflate context and risk the LLM treating it as a fresh
 * task, undoing whatever progress was already made.
 */
function buildRetryPrompt(task: Task): string {
  const reasonNote = task.failureReason
    ? `Last attempt didn't finish cleanly. Reason recorded: ${task.failureReason.slice(0, 200)}\n`
    : "Last attempt didn't finish cleanly.\n";
  return [
    `(retry attempt ${(task.attempts ?? 0) + 1} of ${MAX_ATTEMPTS} on the same task)`,
    "",
    reasonNote,
    `Continue from where you left off. If the work is actually done, ` +
      `call \`task_complete\` with a one-line summary now — the ` +
      `orchestrator only counts a task as finished when you call ` +
      `that tool.`,
  ].join("\n");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
