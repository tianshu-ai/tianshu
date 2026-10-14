// Cron plugin — the poll loop.
//
// Every 60s: find jobs whose next_run has passed, fire each, then
// advance (cron → recompute next_run; once → clear it so it's done).
// Mirrors the old Tianshu scheduler-loop; adapted to plugin deps.
//
// Two action types:
//   - message: enqueue a system-note into target session(s). Supports
//     multi-channel delivery via payload.channels (e.g. ["webchat",
//     "wechat"]). Falls back to payload.sessionId for backward compat.
//   - task: insert a `ready` task into the shared tasks table so the
//     workboard pool picks it up.

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
  /**
   * Resolve session IDs for the given channel names and user.
   * "webchat" → user's most-recently-active webchat session.
   * "wechat" / "feishu" / etc → most-recent channel session.
   * Returns a map: channelName → sessionId (or undefined if none).
   */
  resolveChannelSessions?(userId: string, channels: string[]): Map<string, string | undefined>;
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

    const firedAt = formatFiredAt(now, job.tz);

    if (job.actionType === "message") {
      await this.fireMessage(job, firedAt);
    } else if (job.actionType === "task") {
      this.fireTask(job, now, firedAt);
    }
  }

  private async fireMessage(job: ScheduledJob, firedAt: string): Promise<void> {
    const p = job.payload as {
      sessionId?: string;
      message?: string;
      channels?: string[];
    };
    if (!this.deps.inbox) {
      this.deps.log.warn?.(`[cron] message job ${job.id} skipped — host.sessionInbox unavailable`);
      return;
    }
    const userMsg = String(p.message || `[Scheduled reminder] ${job.title}`);
    const text = `[System] Triggered at: ${firedAt} | Job: "${job.title}" (${job.scheduleType === "cron" ? `cron: ${job.cronExpr}` : "once"})\n\n${userMsg}`;
    const inboxMsg = {
      kind: "system_note" as const,
      text,
      meta: { source: "cron", jobId: job.id, title: job.title, firedAt },
    };

    // Multi-channel delivery: resolve each channel to a session and
    // enqueue. Falls back to the legacy single-sessionId path.
    if (p.channels?.length && this.deps.resolveChannelSessions) {
      const resolved = this.deps.resolveChannelSessions(job.userId, p.channels);
      let delivered = 0;
      for (const ch of p.channels) {
        const sid = resolved.get(ch);
        if (sid) {
          await this.deps.inbox.enqueue(sid, inboxMsg);
          delivered++;
          this.deps.log.info?.(`[cron] job "${job.title}" delivered to ${ch} (${sid})`);
        } else {
          this.deps.log.warn?.(`[cron] job "${job.title}" — no session found for channel "${ch}", skipped`);
        }
      }
      if (delivered === 0) {
        this.deps.log.warn?.(`[cron] message job ${job.id} — no channels resolved, nothing delivered`);
      }
      return;
    }

    // Legacy single-session fallback.
    const sessionId = p.sessionId;
    if (!sessionId) {
      this.deps.log.warn?.(`[cron] message job ${job.id} has no payload.sessionId and no channels — skipped`);
      return;
    }
    await this.deps.inbox.enqueue(sessionId, inboxMsg);
  }

  private fireTask(job: ScheduledJob, now: number, firedAt: string): void {
    const p = job.payload as {
      title?: string;
      description?: string;
      priority?: number;
      projectSlug?: string;
      ownerUserId?: string;
      /** Worker slug under _tenant/config/workers/<slug>/ — the pool
       *  claims a task by this (tasks.worker_agent_id). Leaving it
       *  unset makes an unpinned task any enabled worker can grab. */
      workerAgentId?: string;
      /** Legacy kind-based column (tasks.worker_role), kept for
       *  back-compat; the pool prefers worker_agent_id. */
      workerRole?: string;
      /** Session to notify when the task finishes. Set to the
       *  creating chat session so scheduled tasks report back
       *  (task_done / intervention) just like task_create does. */
      sessionId?: string;
      /** Channels for multi-channel completion notification.
       *  Inherited from the cron job’s payload.channels. */
      channels?: string[];
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
    const workerAgentId = p.workerAgentId?.trim() || null;
    const workerRole = p.workerRole?.trim() || null;
    // Parent session = the chat that scheduled the task. The worker
    // pool notifies it on completion (task_done / intervention), so
    // scheduled tasks report back into that chat. Null = fire-and-
    // forget (no completion message anywhere).
    const parentSessionId = p.sessionId?.trim() || null;
    const id = `task-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    // Mirror workboard's createTask column set so the pool recognises
    // the row. Crucially includes worker_agent_id (the slug the pool
    // claims on) — without it the task sits unpinned/unclaimed — and
    // parent_session_id so completion notifications route back. We
    // also seed depends_on / labels to empty JSON so the row is
    // complete regardless of column defaults.
    const description = p.description
      ? `[Triggered at: ${firedAt}]\n\n${p.description}`
      : `[Triggered at: ${firedAt}]`;
    // Inherit notify_channels from the cron job's payload.channels.
    // Falls back to ["webchat"] if no channels specified (so
    // scheduled tasks always have an explicit delivery target).
    const notifyChannels = Array.isArray(p.channels) && p.channels.length > 0
      ? JSON.stringify(p.channels)
      : JSON.stringify(["webchat"]);
    this.deps.db
      .prepare(
        `INSERT INTO tasks
           (id, project_slug, owner_user_id, worker_role, worker_agent_id,
            title, description, status, priority,
            depends_on, labels, parent_session_id, created_at,
            notify_channels)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, '[]', '[]', ?, ?, ?)`,
      )
      .run(
        id,
        p.projectSlug || "inbox",
        owner,
        workerRole,
        workerAgentId,
        p.title || job.title,
        description,
        typeof p.priority === "number" ? p.priority : 0,
        parentSessionId,
        now,
        notifyChannels,
      );
    this.deps.log.info?.(`[cron] task job ${job.id} created task ${id}`, {
      workerAgentId,
      workerRole,
      parentSessionId,
    });
  }
}

function errMeta(err: unknown): { err: string } {
  return { err: err instanceof Error ? err.message : String(err) };
}

/**
 * Format the fired-at timestamp in the job's timezone (or UTC).
 * Example: "2026-08-24 21:00:00 (Asia/Shanghai)"
 */
function formatFiredAt(now: number, tz?: string | null): string {
  const d = new Date(now);
  try {
    const formatted = d.toLocaleString("sv-SE", {
      timeZone: tz || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    return `${formatted} (${tz || "UTC"})`;
  } catch {
    return `${d.toISOString()} (UTC)`;
  }
}
