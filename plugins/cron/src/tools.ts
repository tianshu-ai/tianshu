// Cron plugin — the agent-facing `schedule` tool.
//
// One tool, four actions (list / create / update / delete). Ported
// from the old Tianshu schedule tool; the `channel` action type is
// dropped for v1 (reach external chats with a `message` job on a
// channel-bound session). Timezone is first-class so recurring jobs
// fire at the user's wall-clock time regardless of server tz.

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";
import {
  type Db,
  createJob,
  deleteJob,
  isValidCron,
  listJobs,
  updateJob,
} from "./scheduler.js";

/** List the worker slugs registered in this tenant, read straight
 *  from the filesystem source of truth
 *  (`_tenant/config/workers/<slug>/`) that the workboard pool uses to
 *  claim tasks. Mirrors workboard's path resolution: the caller may
 *  pass the tenant root or its workspace dir. Returns [] if the dir
 *  is absent or unreadable (treated as "no workers"). */
function listWorkerSlugs(tenantHomeDir: string): string[] {
  const candidates = [
    path.join(tenantHomeDir, "workspace", "_tenant", "config", "workers"),
    path.join(tenantHomeDir, "_tenant", "config", "workers"),
  ];
  const root = candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (!root) return [];
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

interface ToolReturn {
  ok: boolean;
  text: string;
  data?: unknown;
}

export interface CronToolDeps {
  db: Db;
  /** Default tz for cron jobs when the caller omits one (host local
   *  if unset). */
  defaultTz?: string;
  /** Resolve the session to target for `message` jobs when the caller
   *  doesn't pass one — normally the caller's own session. */
  resolveDefaultSessionId?(ctx: AgentToolContext): string | undefined;
  /** Fired after any create/update/delete so the host can broadcast
   *  `schedule_changed` and open CalendarPanels refresh live. Without
   *  this, agent-created jobs only show up after a manual reload
   *  (the REST routes broadcast, but the tool path didn't). */
  onChanged?(): void;
}

const DESCRIPTION = `Create and manage scheduled / recurring jobs. Jobs fire automatically at the specified time.

Actions:
- list: view all scheduled jobs
- create: create a new job
- update: patch a job (enable/disable, change schedule/payload)
- delete: remove a job

schedule_type:
- once: run one time. Use delay_minutes (relative, e.g. 5 = "in 5 min") OR run_at (absolute Unix ms).
- cron: recurring. Pass cron_expr ("m h dom mon dow", e.g. "0 9 * * 1-5" = weekdays 09:00). Optional tz (IANA, e.g. "Asia/Shanghai"); defaults to the tenant/host timezone.

action_type:
- message: enqueue a note into a chat session when it fires. payload: { message, sessionId? }. sessionId defaults to the current session.
- task: drop a ready task on the workboard for a worker. payload: { title, description?, priority?, projectSlug?, workerAgentId }. workerAgentId is REQUIRED — it's the worker slug that runs the task (e.g. "opencoder", "llm-default"). List valid slugs with tenant_config_list({path:"workers"}) and pick one before creating the job. Scheduled tasks must be pinned to a worker (no unattended unpinned tasks).

Cron examples: "0 9 * * 1-5" (weekdays 9am), "30 14 * * *" (daily 2:30pm), "0 0 1 * *" (1st of month), "*/15 * * * *" (every 15 min).

Create examples:
  {"action":"create","title":"Remind in 5m","schedule_type":"once","delay_minutes":5,"action_type":"message","payload":{"message":"Time's up!"}}
  {"action":"create","title":"Daily standup","schedule_type":"cron","cron_expr":"0 9 * * 1-5","tz":"Asia/Shanghai","action_type":"message","payload":{"message":"Standup time — report yesterday + today."}}
  {"action":"create","title":"Weekly report","schedule_type":"cron","cron_expr":"0 17 * * 5","action_type":"task","payload":{"title":"Generate weekly report","description":"Summarise this week's finished tasks into a PDF","priority":1}}`;

export function buildScheduleTool(deps: CronToolDeps): AgentTool {
  return {
    schema: {
      name: "schedule",
      description: DESCRIPTION,
      parameters: Type.Object({
        action: Type.String({ description: "list | create | update | delete" }),
        id: Type.Optional(Type.String({ description: "Job id (update/delete)" })),
        title: Type.Optional(Type.String({ description: "Job title" })),
        schedule_type: Type.Optional(Type.String({ description: "once | cron" })),
        cron_expr: Type.Optional(
          Type.String({ description: "Cron expression (cron type)" }),
        ),
        tz: Type.Optional(
          Type.String({ description: "IANA timezone for cron_expr, e.g. Asia/Shanghai" }),
        ),
        run_at: Type.Optional(
          Type.Number({ description: "Absolute Unix ms (once type). Prefer delay_minutes." }),
        ),
        delay_minutes: Type.Optional(
          Type.Number({ description: "Minutes from now (once type) — for relative delays." }),
        ),
        action_type: Type.Optional(Type.String({ description: "message | task" })),
        payload: Type.Optional(
          Type.Object(
            {},
            {
              additionalProperties: true,
              description:
                "message: {message, sessionId?}. task: {title, description?, priority?, projectSlug?, workerAgentId}. workerAgentId is REQUIRED for task jobs (the worker slug to run it).",
            },
          ),
        ),
        enabled: Type.Optional(Type.Boolean({ description: "Enable/disable (update)" })),
      }),
    },
    execute: (raw, ctx: AgentToolContext): ToolReturn => {
      const p = raw as Record<string, any>;
      try {
        // Every action is scoped to the calling user. A tool call
        // without a userId (shouldn't happen inside an agent loop)
        // is refused rather than silently touching another user's
        // jobs or writing an unowned row.
        const userId = ctx.userId;
        if (!userId) {
          return { ok: false, text: "no user context — cannot manage schedules" };
        }
        switch (p.action) {
          case "list":
            return doList(deps.db, userId);
          case "create": {
            const r = doCreate(deps, ctx, userId, p);
            if (r.ok) deps.onChanged?.();
            return r;
          }
          case "update": {
            const r = doUpdate(deps.db, ctx, userId, p);
            if (r.ok) deps.onChanged?.();
            return r;
          }
          case "delete": {
            if (!p.id) return { ok: false, text: "id is required" };
            const ok = deleteJob(deps.db, p.id, userId);
            if (ok) deps.onChanged?.();
            return ok
              ? { ok: true, text: "✅ Job deleted" }
              : { ok: false, text: "Job not found" };
          }
          default:
            return {
              ok: false,
              text: `Unknown action: ${p.action}. Use list | create | update | delete`,
            };
        }
      } catch (e) {
        return { ok: false, text: `Error: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}

function doList(db: Db, userId: string): ToolReturn {
  const jobs = listJobs(db, userId);
  if (jobs.length === 0) return { ok: true, text: "No scheduled jobs." };
  const lines = jobs.map((j) => {
    const sched =
      j.scheduleType === "cron"
        ? `cron: ${j.cronExpr}${j.tz ? ` (${j.tz})` : ""}`
        : `once: ${j.runAt ? new Date(j.runAt).toISOString() : "—"}`;
    const status = j.enabled ? "✅" : "⏸️";
    const next = j.nextRun ? new Date(j.nextRun).toISOString() : "—";
    return `${status} ${j.title} | ${sched} | ${j.actionType} | next: ${next} | id: ${j.id}`;
  });
  return { ok: true, text: lines.join("\n"), data: jobs };
}

function doCreate(
  deps: CronToolDeps,
  ctx: AgentToolContext,
  userId: string,
  p: Record<string, any>,
): ToolReturn {
  if (!p.title || !p.schedule_type || !p.action_type) {
    return { ok: false, text: "title, schedule_type, action_type are required" };
  }
  if (p.action_type !== "message" && p.action_type !== "task") {
    return { ok: false, text: "action_type must be 'message' or 'task'" };
  }
  // A scheduled task MUST be assigned to a specific, EXISTING worker.
  // Unpinned tasks sit in Ready hoping some worker grabs them, and a
  // bogus slug pins to a worker that never claims it — both leave an
  // unattended job stuck forever. So require the slug and verify it
  // against the tenant's registered workers up front.
  if (p.action_type === "task") {
    const wid =
      typeof p.payload?.workerAgentId === "string"
        ? p.payload.workerAgentId.trim()
        : "";
    if (!wid) {
      return {
        ok: false,
        text: "task jobs must set payload.workerAgentId (the worker slug that runs it). List available slugs with tenant_config_list({ path: \"workers\" }) and pass one, e.g. payload:{ workerAgentId: \"opencoder\" }.",
      };
    }
    const slugs = listWorkerSlugs(ctx.tenantHomeDir);
    if (!slugs.includes(wid)) {
      return {
        ok: false,
        text:
          slugs.length > 0
            ? `worker "${wid}" doesn't exist in this tenant. Available workers: ${slugs
                .map((s) => `"${s}"`)
                .join(", ")}. Pass one of these as payload.workerAgentId.`
            : `worker "${wid}" doesn't exist — this tenant has no workers registered. Create one first (tenant_config_list({ path: "workers" }) shows the current set).`,
      };
    }
  }

  let runAt: number | null = null;
  let cronExpr: string | null = null;
  const tz: string | null = p.tz ?? deps.defaultTz ?? null;

  if (p.schedule_type === "once") {
    if (typeof p.delay_minutes === "number") {
      runAt = Date.now() + Math.round(p.delay_minutes * 60_000);
    } else if (typeof p.run_at === "number") {
      runAt = p.run_at;
    }
    if (!runAt) return { ok: false, text: "run_at or delay_minutes required for once" };
    if (runAt <= Date.now())
      return { ok: false, text: "time must be in the future (use delay_minutes)" };
  } else if (p.schedule_type === "cron") {
    if (!p.cron_expr) return { ok: false, text: "cron_expr required for cron" };
    if (!isValidCron(p.cron_expr, tz))
      return { ok: false, text: `invalid cron expression: ${p.cron_expr}` };
    cronExpr = p.cron_expr;
  } else {
    return { ok: false, text: "schedule_type must be 'once' or 'cron'" };
  }

  const payload: Record<string, unknown> = { ...(p.payload ?? {}) };
  // Both action types default to the caller's own session:
  //  - message: where the reminder is delivered.
  //  - task:    the parent session the worker notifies when the
  //    task finishes (task_done / intervention), so scheduled
  //    tasks report back into this chat just like task_create does.
  if (!payload.sessionId) {
    const sid = deps.resolveDefaultSessionId?.(ctx);
    if (sid) payload.sessionId = sid;
  }

  const job = createJob(deps.db, {
    userId,
    title: p.title,
    scheduleType: p.schedule_type,
    cronExpr,
    tz,
    runAt,
    actionType: p.action_type,
    payload,
  });
  return {
    ok: true,
    text: `✅ Scheduled "${job.title}" [id: ${job.id}] — next: ${
      job.nextRun ? new Date(job.nextRun).toISOString() : "—"
    }`,
    data: { id: job.id, nextRun: job.nextRun },
  };
}

function doUpdate(
  db: Db,
  ctx: AgentToolContext,
  userId: string,
  p: Record<string, any>,
): ToolReturn {
  if (!p.id) return { ok: false, text: "id is required" };
  // If the update re-pins the worker, verify the new slug exists
  // (same guard as create) so an update can't strand a task on a
  // non-existent worker.
  if (typeof p.payload?.workerAgentId === "string") {
    const wid = p.payload.workerAgentId.trim();
    if (wid) {
      const slugs = listWorkerSlugs(ctx.tenantHomeDir);
      if (!slugs.includes(wid)) {
        return {
          ok: false,
          text:
            slugs.length > 0
              ? `worker "${wid}" doesn't exist in this tenant. Available workers: ${slugs
                  .map((s) => `"${s}"`)
                  .join(", ")}.`
              : `worker "${wid}" doesn't exist — this tenant has no workers registered.`,
        };
      }
    }
  }
  const updates: Record<string, unknown> = {};
  if (p.title !== undefined) updates.title = p.title;
  if (p.cron_expr !== undefined) {
    if (p.cron_expr && !isValidCron(p.cron_expr, p.tz))
      return { ok: false, text: `invalid cron expression: ${p.cron_expr}` };
    updates.cronExpr = p.cron_expr;
  }
  if (p.tz !== undefined) updates.tz = p.tz;
  if (p.run_at !== undefined) updates.runAt = p.run_at;
  if (p.action_type !== undefined) updates.actionType = p.action_type;
  if (p.payload !== undefined) updates.payload = p.payload;
  if (p.enabled !== undefined) updates.enabled = p.enabled;
  return updateJob(db, p.id, userId, updates as never)
    ? { ok: true, text: "✅ Job updated" }
    : { ok: false, text: "Job not found (or no changes)" };
}
