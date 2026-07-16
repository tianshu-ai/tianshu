// Cron plugin server entry (ADR-0002 / ADR-0004).
//
// What activate() does:
//   1. Ensures the `cron_jobs` table in the tenant's shared SQLite
//      handle (`ctx.db`). Physical multi-tenancy means no tenant_id
//      column is needed — the whole DB is this tenant's. The handle
//      is host-owned; we never close it.
//   2. Starts a SchedulerLoop (60s tick + one immediate tick so a
//      job already due at boot doesn't wait a full minute). On each
//      fire the loop advances the schedule (cron → next slot; once →
//      done) BEFORE running the action, so a slow/failing action
//      can't re-fire on the next tick.
//   3. Exposes one agent tool, `schedule` (list / create / update /
//      delete). `message` jobs default to the caller's own session
//      (ctx.sessionId); `task` jobs default to the first tenant user
//      as owner.
//   4. Exposes REST routes (GET/POST/PUT/DELETE /schedules) so the
//      CalendarPanel can render + manage jobs, mounted under
//      `/api/p/cron/*`. Every mutation broadcasts `cron:schedule_changed`
//      so open tabs refresh live.
//
// The old closed-source scheduler's `channel` action type is dropped
// for v1 — reach an external chat by scheduling a `message` job on a
// channel-bound session instead.

import type {
  PluginContext,
  PluginServerExports,
  PluginServerModule,
  SessionInboxCapability,
  PluginRouteHandler,
} from "@tianshu-ai/plugin-sdk";
import type { Request, Response } from "express";
import { SchedulerLoop } from "./loop.js";
import { buildScheduleTool } from "./tools.js";
import {
  ensureSchema,
  createJob,
  listJobs,
  updateJob,
  deleteJob,
  type Db,
  type ScheduleType,
  type ScheduledActionType,
} from "./scheduler.js";

interface ActiveState {
  loop: SchedulerLoop;
  log: PluginContext["log"];
}

let active: ActiveState | null = null;

/** First tenant user, used as the fallback owner for `task` jobs
 *  that don't carry an explicit ownerUserId. */
function firstUserId(db: Db): string | undefined {
  const row = db
    .prepare(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`)
    .get() as { id: string } | undefined;
  return row?.id;
}

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    ensureSchema(ctx.db);

    // Per-tenant config:
    //   plugins.cron.config.defaultTz : IANA tz for cron jobs whose
    //     caller omits one (falls back to host local time if unset).
    const cfg = (ctx.pluginConfig ?? {}) as { defaultTz?: string };
    const defaultTz =
      typeof cfg.defaultTz === "string" && cfg.defaultTz.trim()
        ? cfg.defaultTz.trim()
        : undefined;

    // host.sessionInbox delivers `message` jobs into a chat session.
    // Optional: if the host doesn't expose it, message jobs are
    // skipped with a warning (task jobs still work).
    const inbox = ctx.capabilities.get<SessionInboxCapability>(
      "host.sessionInbox",
    );
    if (!inbox) {
      ctx.log.warn(
        "host.sessionInbox capability missing — `message` jobs will be skipped",
      );
    }

    const loop = new SchedulerLoop({
      db: ctx.db,
      log: ctx.log,
      inbox,
      fallbackOwnerUserId: firstUserId(ctx.db),
      onChanged: () => ctx.broadcast("schedule_changed", {}),
    });
    loop.start();

    active = { loop, log: ctx.log };
    ctx.log.info("cron activated", { defaultTz: defaultTz ?? "host-local" });

    const scheduleTool = buildScheduleTool({
      db: ctx.db,
      defaultTz,
      // `message` jobs default to the session the tool was called
      // from, so "remind me in 5 minutes" lands back in this chat.
      resolveDefaultSessionId: (toolCtx) => toolCtx.sessionId,
      // Broadcast so any open CalendarPanel refreshes the moment the
      // agent creates/updates/deletes a job (not just on reload).
      onChanged: () => ctx.broadcast("schedule_changed", {}),
    });

    const routes = buildCronRoutes({
      db: ctx.db,
      broadcast: () => ctx.broadcast("schedule_changed", {}),
      defaultTz,
    });

    return {
      tools: { ScheduleTool: scheduleTool },
      routes,
    };
  },

  async deactivate() {
    active?.loop.stop();
    active?.log.info("cron deactivated");
    active = null;
  },
};

// ─── REST routes (mounted under /api/p/cron/*) ──────────────────
//
// The CalendarPanel reads GET /schedules and manages jobs through
// POST/PUT/DELETE. All tenant-scoped via ctx.db (the route handlers
// close over the per-tenant handle captured at activate time).

interface RouteDeps {
  db: Db;
  broadcast: () => void;
  defaultTz?: string;
}

/** Current user id, set by the host's auth middleware on `req.ctx`.
 *  Every route is user-scoped; a request without it is rejected
 *  rather than allowed to touch another user's jobs. */
function userIdFromReq(req: Request): string {
  const ctx = (req as { ctx?: { userId?: string } }).ctx;
  return ctx?.userId ?? "";
}

function buildCronRoutes(
  deps: RouteDeps,
): Record<string, PluginRouteHandler> {
  const { db, broadcast } = deps;

  const listHandler: PluginRouteHandler = (req: Request, res: Response) => {
    const userId = userIdFromReq(req);
    if (!userId) {
      res.status(401).json({ error: "no user context" });
      return;
    }
    res.json({ jobs: listJobs(db, userId) });
  };

  const createHandler: PluginRouteHandler = (req: Request, res: Response) => {
    const userId = userIdFromReq(req);
    if (!userId) {
      res.status(401).json({ error: "no user context" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof b.title === "string" ? b.title : "";
    const scheduleType = b.scheduleType as ScheduleType | undefined;
    const actionType = b.actionType as ScheduledActionType | undefined;
    if (!title || !scheduleType || !actionType) {
      res.status(400).json({ error: "title, scheduleType, actionType are required" });
      return;
    }
    if (scheduleType !== "once" && scheduleType !== "cron") {
      res.status(400).json({ error: "scheduleType must be 'once' or 'cron'" });
      return;
    }
    if (actionType !== "message" && actionType !== "task") {
      res.status(400).json({ error: "actionType must be 'message' or 'task'" });
      return;
    }
    const job = createJob(db, {
      userId,
      title,
      scheduleType,
      cronExpr: typeof b.cronExpr === "string" ? b.cronExpr : null,
      tz: typeof b.tz === "string" ? b.tz : (deps.defaultTz ?? null),
      runAt: typeof b.runAt === "number" ? b.runAt : null,
      actionType,
      payload: (b.payload as Record<string, unknown>) ?? {},
    });
    broadcast();
    res.status(201).json({ job });
  };

  const updateHandler: PluginRouteHandler = (req: Request, res: Response) => {
    const userId = userIdFromReq(req);
    if (!userId) {
      res.status(401).json({ error: "no user context" });
      return;
    }
    const id = String(req.params.id ?? "");
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    const ok = updateJob(db, id, userId, (req.body ?? {}) as never);
    if (!ok) {
      res.status(404).json({ error: "job not found" });
      return;
    }
    broadcast();
    res.json({ ok: true });
  };

  const deleteHandler: PluginRouteHandler = (req: Request, res: Response) => {
    const userId = userIdFromReq(req);
    if (!userId) {
      res.status(401).json({ error: "no user context" });
      return;
    }
    const id = String(req.params.id ?? "");
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    const ok = deleteJob(db, id, userId);
    if (!ok) {
      res.status(404).json({ error: "job not found" });
      return;
    }
    broadcast();
    res.json({ ok: true });
  };

  return {
    listSchedules: listHandler,
    createSchedule: createHandler,
    updateSchedule: updateHandler,
    deleteSchedule: deleteHandler,
  };
}

export const activate = plugin.activate.bind(plugin);
export const deactivate = plugin.deactivate?.bind(plugin);
export default plugin;
