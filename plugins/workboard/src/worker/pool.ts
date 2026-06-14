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
import {
  claimNextTask,
  getTask,
  updateTask,
  INTERVENTION_LABEL,
  type Task,
} from "../db/tasks.js";
import {
  WORKER_DENY_TOOLS as WORKER_DENY_TOOLS_LIST,
  WORKER_DENY_TOOLS_SET,
  WORKER_REQUIRED_TOOLS,
} from "./tool-policy.js";

/**
 * Legacy threshold from the auto-retry era. Migration 008 replaced
 * the auto-retry loop with main-agent intervention, so the pool no
 * longer consults this value to decide whether to give up. We keep
 * it exported (1) for the existing test that locks in the
 * "give up" behaviour against the old API, and (2) so external
 * callers depending on the symbol don't trip a build break in the
 * same release that ships the behaviour change. Any future use
 * site should treat "any failure" as the give-up condition.
 */
export const MAX_ATTEMPTS = 1;

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
  /**
   * Run the task. The pool passes a per-run AbortSignal so a
   * watchdog timeout (or future explicit-cancel paths) can
   * interrupt the worker mid-flight; honoring the signal is
   * best-effort — a worker that ignores it just keeps running
   * past the deadline, which costs the watchdog one extra
   * intervention and nothing else.
   */
  run(task: Task, signal: AbortSignal): Promise<TerminalUpdate>;
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
    message: {
      kind: "task_done" | "task_intervention_required";
      text: string;
      meta?: Record<string, unknown>;
    },
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
  private watchdogTimer: NodeJS.Timeout | null = null;
  /** agentId → "in-flight task id" (or undefined = idle). */
  private busy = new Map<string, string>();
  /** taskId → AbortController for the run. Lets the watchdog (or
   *  pool shutdown) cancel a worker mid-flight without scanning
   *  every WorkerHandle. */
  private runControllers = new Map<string, AbortController>();
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

    // Watchdog: every 5s scan in-flight tasks and cancel any
    // whose `started_at + timeout_ms` has passed. Cancelling the
    // AbortController causes the agent-loop runner to wind down,
    // returning a terminal `aborted` update; runOne's terminal
    // handler then routes the task into intervention with a
    // "timeout" reason. 5s polling is fine — the budget is in
    // minutes, and a few seconds of slop is invisible to humans.
    this.watchdogTimer = setInterval(() => {
      if (this.stopped) return;
      this.runWatchdog();
    }, 5_000);
    this.watchdogTimer.unref?.();
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
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    // Be polite: cancel every in-flight run so we don't keep
    // burning model tokens after a tenant disable.
    for (const ctl of this.runControllers.values()) {
      try {
        ctl.abort();
      } catch {
        // best-effort
      }
    }
    this.runControllers.clear();
  }

  /**
   * Cancel an in-flight run by task id. Returns true iff there
   * was a controller to abort. Used by `task_extend_timeout` is
   * NOT — that one just bumps the row's timeout_ms; the watchdog
   * picks the new value up on its next tick — but `task_abort`
   * uses it to interrupt a runaway worker.
   */
  cancelTaskRun(taskId: string): boolean {
    const ctl = this.runControllers.get(taskId);
    if (!ctl) return false;
    try {
      ctl.abort();
    } catch {
      // best-effort
    }
    return true;
  }

  /** Watchdog scan. Visible for testing. */
  runWatchdog(): void {
    const now = Date.now();
    for (const [taskId] of this.runControllers) {
      // Re-read the row each tick so a `task_extend_timeout` that
      // grew the budget mid-flight takes effect immediately.
      const fresh = getTask(this.deps.db, taskId);
      if (!fresh || !fresh.startedAt) continue;
      const deadline = fresh.startedAt + fresh.timeoutMs;
      if (now < deadline) continue;
      this.deps.log.warn("workboard: watchdog cancelling task", {
        taskId,
        startedAt: fresh.startedAt,
        timeoutMs: fresh.timeoutMs,
        overrunMs: now - deadline,
      });
      const ctl = this.runControllers.get(taskId);
      if (ctl) {
        try {
          // Mark the reason on the row BEFORE aborting so the
          // terminal handler in runOne (which writes the
          // intervention payload) sees "watchdog timeout" rather
          // than the bare "aborted" the agent-loop reports.
          updateTask(this.deps.db, taskId, {
            failureReason: `watchdog timeout (${Math.round(fresh.timeoutMs / 1000)}s budget exceeded by ${Math.round((now - deadline) / 1000)}s)`,
          });
        } catch (err) {
          this.deps.log.warn("workboard: watchdog stamp failed", {
            taskId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
        ctl.abort();
      }
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
    // Per-run AbortController. Two things can fire it:
    //   1. The watchdog (deadline = startedAt + timeout_ms).
    //   2. The pool stopping (`stop()` aborts every in-flight
    //      controller so workers don't keep burning model
    //      tokens past shutdown).
    // The controller lives in `runControllers` keyed by taskId
    // so the watchdog can reach it without holding a closure
    // reference.
    const ctl = new AbortController();
    this.runControllers.set(task.id, ctl);
    let update: TerminalUpdate;
    try {
      update = await worker.run(task, ctl.signal);
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
    } finally {
      this.runControllers.delete(task.id);
    }

    if (this.stopped) return;

    const now = Date.now();
    if (update.status === "done") {
      // Success: clear the failure trail and reset the attempt
      // counter so future re-runs (e.g. a follow-up edit + manual
      // re-queue) start clean. Also drop the intervention labels —
      // a manual retry that succeeds shouldn't leave the warning
      // badge stuck on the card.
      const fresh = getTask(this.deps.db, task.id) ?? task;
      const cleanedLabels = fresh.labels.filter(
        (l) => l !== INTERVENTION_LABEL && l !== "stalled",
      );
      updateTask(this.deps.db, task.id, {
        status: "done",
        resultSummary: update.resultSummary ?? null,
        resultFiles: update.resultFiles ?? [],
        failureReason: null,
        labels: cleanedLabels,
        attempts: 0,
        endedAt: now,
        interventionReason: null,
        interventionAt: null,
      });
    } else {
      // Failure (worker stalled / aborted, exception, or watchdog
      // timeout). Post-008 behaviour: do NOT auto-retry. Stamp
      // `awaiting-intervention`, write a structured reason, and
      // notify the parent session so the main agent decides
      // whether to continue (resume same session), retry fresh,
      // extend the timeout, or abort.
      //
      // We still bump `attempts` as a passive counter (it shows
      // up in the UI / inbox text), but it no longer drives any
      // policy.
      const fresh = getTask(this.deps.db, task.id) ?? task;
      const nextAttempts = (fresh.attempts ?? 0) + 1;
      const reason =
        update.resultSummary ?? `worker ${update.status} without summary`;
      const baseLabels = fresh.labels.filter(
        (l) => l !== INTERVENTION_LABEL && l !== "stalled",
      );
      const nextLabels = [...baseLabels, INTERVENTION_LABEL];
      updateTask(this.deps.db, task.id, {
        status: "ready",
        resultSummary: null,
        resultFiles: update.resultFiles ?? [],
        failureReason: reason,
        attempts: nextAttempts,
        labels: nextLabels,
        // Keep session_id pointing at the most recent run — the
        // chat agent uses it (via task_continue) to resume the
        // same conversation.
        startedAt: null,
        // Stamp ended_at so the timeline shows when the run
        // ended; task_continue / task_retry_fresh clears it on
        // re-queue.
        endedAt: now,
        interventionReason: reason,
        interventionAt: now,
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
    // Post-008: every non-`done` terminal update is an
    // intervention event — the pool no longer auto-retries. The
    // payload tells the main agent which task, why it failed, and
    // which tools are available to revive it.
    if (this.deps.notifyParentSession && task.parentSessionId) {
      try {
        const finalRow = getTask(this.deps.db, task.id) ?? task;
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
        } else {
          this.deps.notifyParentSession(task.parentSessionId, {
            kind: "task_intervention_required",
            text:
              `Task "${task.title}" needs your attention.\n` +
              `Reason: ${update.resultSummary ?? "(no summary)"}\n` +
              `Decide: task_continue (resume same session, optional hint), ` +
              `task_retry_fresh (start over with a new session, optional ` +
              `revised description), task_extend_timeout (give it more ` +
              `wall-clock time), or task_abort (mark done with a failure ` +
              `summary).`,
            meta: {
              taskId: task.id,
              workerAgentId: worker.agentId,
              workerKind: worker.kind,
              attempts: finalRow.attempts,
              sessionId: finalRow.sessionId,
              terminalStatus: update.status,
              interventionReason: finalRow.interventionReason,
              suggestedActions: [
                "task_continue",
                "task_retry_fresh",
                "task_extend_timeout",
                "task_abort",
              ],
            },
          });
        }
      } catch (err) {
        // notifyParentSession is best-effort; a failure must not
        // break the pool. Log and continue.
        this.deps.log.warn("workboard: notifyParentSession failed", {
          taskId: task.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // No automatic re-nudge on failure: the row is parked under
    // `awaiting-intervention` and the pool's claim filter skips it
    // until the main agent revives it explicitly. Nudging would
    // just spin one drain pass that finds nothing.
  }

  private recoverOrphaned(): void {
    // Any task left in `in_progress` when this pool boots is by
    // definition orphaned: the previous host process died (crash,
    // restart, dev-time `touch index.ts`) while a worker was
    // mid-run, and there's no in-memory busy slot to inherit.
    //
    // Post-008 we treat it the same way runtime failures get
    // treated: park in `ready` + `awaiting-intervention`, write
    // a reason, notify the parent session if any. The main agent
    // then decides task_continue / task_retry_fresh / task_abort.
    //
    // session_id is intentionally NOT cleared here: the previous
    // transcript is still useful for debugging "why did this
    // crash?" and main agent's task_continue resumes from it.
    const orphans = this.deps.db
      .prepare<
        [],
        {
          id: string;
          attempts: number | null;
          labels: string;
          parent_session_id: string | null;
          title: string;
        }
      >(
        `SELECT id, attempts, labels, parent_session_id, title
         FROM tasks WHERE status = 'in_progress'`,
      )
      .all();
    if (orphans.length === 0) return;
    const now = Date.now();
    const update = this.deps.db.prepare(
      `UPDATE tasks
         SET status = 'ready',
             started_at = NULL,
             ended_at = ?,
             attempts = ?,
             failure_reason = ?,
             labels = ?,
             intervention_reason = ?,
             intervention_at = ?
       WHERE id = ?`,
    );
    const reason = "reclaimed after host restart (worker did not finish)";
    for (const row of orphans) {
      const nextAttempts = (row.attempts ?? 0) + 1;
      let labels: string[] = [];
      try {
        const parsed = JSON.parse(row.labels);
        if (Array.isArray(parsed)) {
          labels = parsed.filter((l): l is string => typeof l === "string");
        }
      } catch {
        labels = [];
      }
      const baseLabels = labels.filter(
        (l) => l !== INTERVENTION_LABEL && l !== "stalled",
      );
      const nextLabels = [...baseLabels, INTERVENTION_LABEL];
      update.run(
        now,
        nextAttempts,
        reason,
        JSON.stringify(nextLabels),
        reason,
        now,
        row.id,
      );
      // Inbox-notify the parent so the main agent picks the
      // intervention up on its next turn rather than discovering
      // a stuck task days later.
      if (this.deps.notifyParentSession && row.parent_session_id) {
        try {
          this.deps.notifyParentSession(row.parent_session_id, {
            kind: "task_intervention_required",
            text:
              `Task "${row.title}" needs your attention.\n` +
              `Reason: ${reason}\n` +
              `Decide: task_continue / task_retry_fresh / ` +
              `task_extend_timeout / task_abort.`,
            meta: {
              taskId: row.id,
              attempts: nextAttempts,
              terminalStatus: "orphaned",
              suggestedActions: [
                "task_continue",
                "task_retry_fresh",
                "task_extend_timeout",
                "task_abort",
              ],
            },
          });
        } catch {
          // best-effort
        }
      }
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

  async run(task: Task, signal: AbortSignal): Promise<TerminalUpdate> {
    const ms = this.opts.delayMs ?? 30_000;
    // Two cancellation sources: the constructor-level signal
    // (tests use it to short-circuit a long sleep) and the
    // pool-supplied per-run signal (watchdog / shutdown). Either
    // wins.
    const merged = mergeAbortSignals(this.opts.signal, signal);
    try {
      await sleep(ms, merged);
    } catch (err) {
      // Aborted echo worker still returns a terminal update so the
      // pool can route to intervention rather than blowing up.
      return {
        status: "aborted",
        resultSummary: `Echo worker aborted: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return {
      status: "done",
      resultSummary: `Echo worker reflected: "${task.title}"`,
    };
  }
}

/** Merge an arbitrary number of AbortSignals into one. The result
 *  fires when any input fires. */
function mergeAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal {
  const ctl = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      ctl.abort();
      return ctl.signal;
    }
    s.addEventListener(
      "abort",
      () => {
        try {
          ctl.abort();
        } catch {
          // ignore
        }
      },
      { once: true },
    );
  }
  return ctl.signal;
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

// Deny / required sets live in `./tool-policy.ts` so server seeds,
// the runtime pool, and the admin UI all share the same list.
const WORKER_DENY_TOOLS = WORKER_DENY_TOOLS_SET;

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

  async run(task: Task, signal: AbortSignal): Promise<TerminalUpdate> {
    const userId = task.ownerUserId || this.cfg.defaultUserId;
    // Resume vs. fresh-start:
    //   - First time the row is seen (attempts=0) or no
    //     session_id captured yet  → fresh session, full brief.
    //   - attempts>0 with a session_id  → either main agent
    //     called task_continue (which set session_continuation_hint)
    //     or task_retry_fresh (which cleared session_id, so we
    //     don't enter this branch). Resume the prior session and
    //     pass a short nudge instead of re-pasting the brief.
    const shouldResume = (task.attempts ?? 0) > 0 && Boolean(task.sessionId);
    const initialUserMessage = shouldResume
      ? buildContinuationPrompt(task)
      : buildInitialPrompt(task);
    const result = await this.cfg.runner.run({
      userId,
      signal,
      initialUserMessage,
      systemPrompt: this.cfg.systemPrompt ?? undefined,
      modelId: this.cfg.modelId ?? undefined,
      toolsAllow: effectiveToolsAllow(this.cfg.toolsAllow),
      toolsDeny: [...WORKER_DENY_TOOLS_LIST],
      skillsAllow: this.cfg.skillsAllow ?? undefined,
      sessionTitle: task.title,
      workerRole: this.kind,
      // The fs migration uses the agent id as the directory slug
      // (see plugin/workboard/src/fs-worker-agents.ts:toWorkerAgent).
      // Forward it so tenant_config_write knows which workers/<slug>/
      // bundle this run owns.
      workerSlug: this.cfg.agentId,
      timeouts: this.cfg.timeouts,
      // Resume the prior conversation when continuing so the LLM
      // sees its own earlier work + tool results, doesn't waste
      // a full re-research cycle, and — critically for the user
      // — the kanban Execution dialog shows one continuous
      // transcript across attempts instead of N independent
      // session windows.
      resumeSessionId: shouldResume ? task.sessionId ?? undefined : undefined,
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
      // Distinguish three abort sources for the intervention text:
      //   1. watchdog stamped a `failureReason` before aborting
      //      — the row already carries the message; just echo
      //      something concise here.
      //   2. shutdown / explicit cancel without a reason — keep
      //      the runner's own summary.
      // Either way the row ends up in awaiting-intervention.
      const fresh = getTask(this.cfg.db, task.id);
      const watchdogReason = fresh?.failureReason;
      return {
        status: "aborted",
        resultSummary:
          watchdogReason ?? result.summary ?? "aborted",
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
 * Prompt used when the main agent revives a task via
 * task_continue and we resume the prior session. The LLM already
 * sees its earlier turns + tool results in context, so this is a
 * thin nudge — plus the optional hint the main agent attached.
 *
 * Why we don't repeat the full brief: it's at the top of the
 * resumed transcript. Repeating inflates context and risks the
 * worker treating it as a fresh task, undoing prior progress.
 */
function buildContinuationPrompt(task: Task): string {
  const reason = task.interventionReason ?? task.failureReason;
  const lines: string[] = [
    `(continuing from prior session; attempt #${(task.attempts ?? 0) + 1})`,
    "",
  ];
  if (reason) {
    lines.push(`The previous run did not finish cleanly. Recorded reason:`);
    lines.push(reason.slice(0, 400));
    lines.push("");
  }
  // The main agent may have appended a hint via task.description
  // before re-queueing (task_continue forwards the hint into a
  // dedicated marker block). Surface it loud and clear.
  const hint = extractContinuationHint(task.description);
  if (hint) {
    lines.push(`Operator note: ${hint}`);
    lines.push("");
  }
  lines.push(
    `Continue from where you left off. If the work is actually done, ` +
      `call \`task_complete\` with a one-line summary now — the ` +
      `orchestrator only counts a task as finished when you call ` +
      `that tool.`,
  );
  return lines.join("\n");
}

const CONTINUATION_HINT_BEGIN = "<!-- continuation-hint -->";
const CONTINUATION_HINT_END = "<!-- /continuation-hint -->";

export function extractContinuationHint(
  description: string | null | undefined,
): string | null {
  if (!description) return null;
  const start = description.lastIndexOf(CONTINUATION_HINT_BEGIN);
  if (start < 0) return null;
  const end = description.indexOf(CONTINUATION_HINT_END, start);
  if (end < 0) return null;
  return description
    .slice(start + CONTINUATION_HINT_BEGIN.length, end)
    .trim() || null;
}

export function appendContinuationHint(
  description: string | null | undefined,
  hint: string,
): string {
  // Wipe any previous hint marker so we don't accumulate stale
  // notes across multiple task_continue calls.
  const cleaned = stripContinuationHint(description ?? "");
  const block = `${CONTINUATION_HINT_BEGIN}\n${hint.trim()}\n${CONTINUATION_HINT_END}`;
  return cleaned ? `${cleaned.trimEnd()}\n\n${block}` : block;
}

export function stripContinuationHint(description: string): string {
  const start = description.lastIndexOf(CONTINUATION_HINT_BEGIN);
  if (start < 0) return description;
  const end = description.indexOf(CONTINUATION_HINT_END, start);
  if (end < 0) return description;
  return (
    description.slice(0, start) +
    description.slice(end + CONTINUATION_HINT_END.length)
  ).replace(/\n{3,}/g, "\n\n");
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
