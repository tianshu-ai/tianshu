// Cron plugin — the poll loop.
//
// Every 60s: find jobs whose next_run has passed, fire each, then
// advance (cron → recompute next_run; once → clear it so it's done).
// Mirrors the old Tianshu scheduler-loop; adapted to plugin deps.
//
// Two action types (the old `channel` mode is dropped for v1 — reach
// external chats via a `message` job on a channel-bound session once
// that lands):
//   - message: enqueue a system-note into a target session's inbox
//     (host.sessionInbox). payload.sessionId + payload.message.
//   - task: insert a `ready` task into the shared tasks table so the
//     workboard pool picks it up. payload.{title,description,priority,
//     projectSlug,ownerUserId,workerRole}.

import type { SessionInboxCapability } from "@tianshu-ai/plugin-sdk";
import {
  type Db,
  type ScheduledJob,
  computeNextCron,
  getDueJobs,
  markJobRun,
} from "./scheduler.js";

export interface LoopDeps {
  db: Db;
  log: { info?(msg: string, meta?: unknown): void; warn?(msg: string, meta?: unknown): void };
  /** host.sessionInbox — used by `message` jobs. Optional: if absent,
   *  message jobs are skipped with a warning. */
  inbox?: SessionInboxCapability;
  /** Default owner user id for `task` jobs that don't carry one. */
  fallbackOwnerUserId?: string;
  /** Called after any job fires so the UI can refresh (optional). */
  onChanged?(): void;
}

const TICK_MS = 60_000;

export class SchedulerLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly deps: LoopDeps) {}

  start(): void {
    if (this.timer) return;
    // Fire an immediate tick so a job that's already due at boot
    // (server was down over its window) doesn't wait a full minute.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.deps.log.info?.("[cron] scheduler loop started (60s tick)");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    let due: ScheduledJob[];
    try {
      due = getDueJobs(this.deps.db, now);
    } catch (err) {
      this.deps.log.warn?.("[cron] getDueJobs failed", errMeta(err));
      return;
    }
    for (const job of due) {
      try {
        await this.fire(job, now);
      } catch (err) {
        this.deps.log.warn?.(`[cron] job "${job.title}" (${job.id}) failed`, errMeta(err));
      }
    }
    if (due.length && this.deps.onChanged) this.deps.onChanged();
  }

  private async fire(job: ScheduledJob, now: number): Promise<void> {
    // Advance schedule FIRST (so a slow/failing action doesn't cause a
    // re-fire on the next tick). cron → next slot; once → null (done).
    const nextRun =
      job.scheduleType === "cron" && job.cronExpr
        ? computeNextCron(job.cronExpr, now, job.tz)
        : null;
    markJobRun(this.deps.db, job.id, now, nextRun);

    this.deps.log.info?.(`[cron] firing "${job.title}"`, {
      id: job.id,
      actionType: job.actionType,
    });

    if (job.actionType === "message") {
      await this.fireMessage(job);
    } else if (job.actionType === "task") {
      this.fireTask(job, now);
    }
  }

  private async fireMessage(job: ScheduledJob): Promise<void> {
    const p = job.payload as { sessionId?: string; message?: string };
    const sessionId = p.sessionId;
    if (!sessionId) {
      this.deps.log.warn?.(`[cron] message job ${job.id} has no payload.sessionId — skipped`);
      return;
    }
    if (!this.deps.inbox) {
      this.deps.log.warn?.(`[cron] message job ${job.id} skipped — host.sessionInbox unavailable`);
      return;
    }
    const text = String(p.message || `[Scheduled reminder] ${job.title}`);
    await this.deps.inbox.enqueue(sessionId, {
      kind: "system_note",
      text,
      meta: { source: "cron", jobId: job.id, title: job.title },
    });
  }

  private fireTask(job: ScheduledJob, now: number): void {
    const p = job.payload as {
      title?: string;
      description?: string;
      priority?: number;
      projectSlug?: string;
      ownerUserId?: string;
      workerRole?: string;
    };
    // Owner precedence: an explicit payload.ownerUserId wins, then
    // the job's own owner (jobs are user-scoped), then the tenant
    // fallback. job.userId is the normal case now that jobs are
    // created with the calling user's id.
    const owner = p.ownerUserId || job.userId || this.deps.fallbackOwnerUserId;
    if (!owner) {
      this.deps.log.warn?.(`[cron] task job ${job.id} skipped — no ownerUserId`);
      return;
    }
    const id = `task-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.deps.db
      .prepare(
        `INSERT INTO tasks
           (id, project_slug, owner_user_id, worker_role, title, description, status, priority, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
      )
      .run(
        id,
        p.projectSlug || "inbox",
        owner,
        p.workerRole ?? null,
        p.title || job.title,
        p.description ?? null,
        typeof p.priority === "number" ? p.priority : 0,
        now,
      );
    this.deps.log.info?.(`[cron] task job ${job.id} created task ${id}`);
  }
}

function errMeta(err: unknown): { err: string } {
  return { err: err instanceof Error ? err.message : String(err) };
}
