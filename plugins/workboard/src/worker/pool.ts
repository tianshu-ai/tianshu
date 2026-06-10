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

import type { PluginLogger, TenantDbHandle } from "@tianshu/plugin-sdk";
import { claimNextTask, updateTask, type Task } from "../db/tasks.js";

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
  /** Initial set of agent specs. Replace later via `rebuild`. */
  agents: AgentSpec[];
  /** Returns a `WorkerHandle` for an agent, or null if the kind
   *  isn't supported (e.g. an LLM agent on a build that hasn't
   *  shipped that runtime yet). Null kinds are skipped quietly. */
  factory: WorkerHandleFactory;
}

export class WorkerPool {
  private nudgeTimer: NodeJS.Timeout | null = null;
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
  }

  /** Mark the pool stopped. Any work already in flight finishes;
   *  no further claims happen. */
  stop(): void {
    this.stopped = true;
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
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
      this.deps.log.error("workboard: worker threw — marking stalled", {
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
    updateTask(this.deps.db, task.id, {
      status: update.status,
      resultSummary: update.resultSummary ?? null,
      resultFiles: update.resultFiles ?? [],
      endedAt: now,
    });
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
  }

  private recoverOrphaned(): void {
    const result = this.deps.db
      .prepare(
        `UPDATE tasks
         SET status = 'todo',
             started_at = NULL,
             session_id = NULL
         WHERE status = 'in_progress'`,
      )
      .run() as { changes: number };
    if (result.changes > 0) {
      this.deps.log.info("workboard: reclaimed orphaned in_progress tasks", {
        count: result.changes,
      });
    }
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
