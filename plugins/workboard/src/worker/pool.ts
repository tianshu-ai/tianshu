// In-memory worker pool.
//
// v0.2 ships a single role: `echo`. When a task lands on the board:
//   1. The plugin's task-creation path nudges the pool.
//   2. The pool claims one ready task per nudge (atomic UPDATE — see
//      `claimNextTask` in db/tasks.ts).
//   3. After a configurable delay (default 30s) the worker writes a
//      tiny `result_summary`, flips status to `done`, and broadcasts
//      a `workboard.task` WS event so the UI updates without polling.
//
// Why not a full polling loop? `tasks` writes always happen through
// this plugin's REST + agent-tool surface, so we have a clean event
// hook on the write side — no need to scan the DB on a timer.
// Restart-recovery is handled separately (see `recoverInProgress` at
// the bottom): on plugin activation we flip orphaned `in_progress`
// rows back to `todo`, then nudge once.
//
// Real worker roles (qianliyan / luban / xihe / nvwa, ADR-0002 §1)
// land in N+6.2. The interface here is shaped so the only thing
// that changes is `WorkerHandle.run()`: today it's a 30s sleep,
// tomorrow it boots a worker session and waits for completion.

import type { PluginLogger, TenantDbHandle } from "@tianshu/plugin-sdk";
import { claimNextTask, updateTask, type Task } from "../db/tasks.js";

/** What a single worker promises to do with one claimed task.
 *  Resolves with the task's terminal state — usually `done`, but a
 *  worker may legitimately mark a task `stalled` if it gives up. */
export interface WorkerHandle {
  role: string;
  run(task: Task): Promise<TerminalUpdate>;
}

export interface TerminalUpdate {
  status: "done" | "stalled" | "aborted";
  resultSummary?: string | null;
  resultFiles?: string[];
}

export interface WorkerPoolDeps {
  db: TenantDbHandle;
  log: PluginLogger;
  /** Notifies subscribers (chat shell) that a task changed. */
  broadcast(type: string, payload: unknown): void;
  /** Workers in the pool. v0.2 has one entry: the echo worker. */
  workers: WorkerHandle[];
}

export class WorkerPool {
  private nudgeTimer: NodeJS.Timeout | null = null;
  private busy = new Set<string>();
  private stopped = false;

  constructor(private deps: WorkerPoolDeps) {}

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

  /** Snapshot for the admin page + `GET /workers/status`. */
  status(): { workers: { role: string; busy: boolean }[]; running: string[] } {
    return {
      workers: this.deps.workers.map((w) => ({
        role: w.role,
        busy: [...this.busy].some((tid) => tid.startsWith(`${w.role}:`)),
      })),
      running: [...this.busy].map((entry) => entry.split(":", 2)[1]),
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

  private async drain(): Promise<void> {
    if (this.stopped) return;

    for (const worker of this.deps.workers) {
      if ([...this.busy].some((entry) => entry.startsWith(`${worker.role}:`))) {
        // Worker is already on a task. v0.2 is single-task-per-role
        // because the echo worker is the whole game; richer
        // concurrency belongs to N+6.2+.
        continue;
      }
      const claimed = claimNextTask(this.deps.db, { workerRole: worker.role });
      if (!claimed) continue;

      const key = `${worker.role}:${claimed.id}`;
      this.busy.add(key);
      this.deps.broadcast("workboard.task", {
        kind: "claimed",
        taskId: claimed.id,
        workerRole: worker.role,
      });
      this.deps.log.info("workboard: claimed task", {
        taskId: claimed.id,
        worker: worker.role,
        title: claimed.title,
      });

      // Run the worker async so we don't block the drain loop.
      void this.runOne(worker, claimed).finally(() => {
        this.busy.delete(key);
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
        worker: worker.role,
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
      workerRole: worker.role,
      status: update.status,
    });
    this.deps.log.info("workboard: task completed", {
      taskId: task.id,
      worker: worker.role,
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
  readonly role = "echo";

  /** Default 30s; tests pass a smaller value. */
  constructor(private opts: { delayMs?: number; signal?: AbortSignal } = {}) {}

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
