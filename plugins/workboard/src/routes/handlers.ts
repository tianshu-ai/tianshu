// HTTP route handlers for the workboard admin + chat-shell panel.
//
// Routes are mounted at `/api/p/workboard/*` by the host (see
// manifest.contributes.apiRoutes). Every handler reads the calling
// user's id from `req.ctx.userId` (set by the host's auth middleware)
// and scopes reads/writes to that user — workboard rows are
// per-owner inside a tenant (ADR-0002 §6 owner_user_id).
//
// We deliberately keep the JSON shape close to the underlying Task
// type, so the React panel can decode by hand without a generated
// client. Error envelopes are { error: "<code>" } for parity with
// the rest of the open-source repo's plugin routes.

import { randomUUID } from "node:crypto";
import type { Request } from "express";
import type {
  PluginRouteHandler,
  TenantDbHandle,
  PluginLogger,
} from "@tianshu/plugin-sdk";
import {
  createTask,
  deleteTask,
  getTask,
  listProjects,
  listTasks,
  updateTask,
  isTaskStatus,
  type ProjectSummary,
  type Task,
  type TaskStatus,
} from "../db/tasks.js";
import {
  createUserWorkerAgent,
  deleteWorkerAgent,
  getWorkerAgent,
  listWorkerAgents,
  resetBuiltinAgent,
  updateWorkerAgent,
  type SeedAgentSpec,
  type WorkerAgent,
} from "../db/agents.js";
import { readSessionHistory } from "../db/session-history.js";

/**
 * Validate that a task's worker assignment can actually be picked
 * up by some live worker, before we let it land in the DB.
 *
 * Without this check a task could be created against an agent the
 * user disabled (or that never existed), or with a worker_role no
 * enabled agent matches — the pool would silently never claim
 * it. The user sees a forever-`ready` card with no explanation.
 *
 * Returns null when the assignment is fine (or absent), and an
 * `{ code, message }` envelope when it isn't. Caller maps that
 * to a 400 + JSON.
 *
 * Rules:
 *   - workerAgentId set: must exist for this tenant AND be enabled.
 *     If both are set, workerRole is ignored (the pool uses agent
 *     pinning when present), so we don't enforce role-match here.
 *   - workerRole set, workerAgentId absent: at least one enabled
 *     agent in this tenant must have `kind === workerRole`.
 *   - both absent: any enabled agent (regardless of role) can pick
 *     the task up. The pool only fails closed if there are zero
 *     enabled agents at all — we surface that case as a warning,
 *     not an error, since the user can fix it later by enabling
 *     a worker.
 */
export function validateAssignableWorker(
  agents: WorkerAgent[],
  args: { workerAgentId: string | null; workerRole: string | null },
): { code: string; message: string } | null {
  const { workerAgentId, workerRole } = args;
  if (workerAgentId) {
    const target = agents.find((a) => a.id === workerAgentId);
    if (!target) {
      return {
        code: "agent_not_found",
        message: `Worker agent ${workerAgentId} doesn't exist in this tenant.`,
      };
    }
    if (!target.enabled) {
      return {
        code: "agent_disabled",
        message: `Worker agent "${target.name}" is disabled. Enable it under Settings → Plugins → Worker agents, or pick another agent.`,
      };
    }
    return null;
  }
  if (workerRole) {
    const candidates = agents.filter(
      (a) => a.enabled && a.kind === workerRole,
    );
    if (candidates.length === 0) {
      return {
        code: "no_enabled_worker_for_role",
        message: `No enabled worker has kind="${workerRole}". Either enable an existing worker of that kind or pick a different role.`,
      };
    }
    return null;
  }
  return null;
}
import type { WorkerPool } from "../worker/pool.js";

/** Optional fields a worker kind can store on its agents. Every
 *  kind always exposes `name` + `description`; the rest opt in.
 *  The same set is used by the UI to decide which form rows to
 *  render and by the REST handlers to reject fields a kind
 *  hasn't opted into (so no stray system prompt sneaks onto an
 *  echo agent). */
export type WorkerKindField =
  | "description"
  | "modelId"
  | "systemPrompt"
  | "toolsAllow"
  | "skills";

export interface WorkerKindDef {
  id: string;
  displayName: string;
  description?: string;
  /** Default true. When false, hidden from the "new agent" picker;
   *  used for demo runtimes that should only ever exist as seeds. */
  userCreatable?: boolean;
  /** Which optional fields this kind exposes in CRUD. `name` is
   *  always allowed and isn't listed here. Default for backwards
   *  compat is the full set ("description", "modelId",
   *  "systemPrompt", "toolsAllow", "skills") so existing UI
   *  doesn't lose anything; future kinds tighten the list. */
  fields?: WorkerKindField[];
}

/**
 * Maximum number of tasks accepted in a single batch create / delete
 * request. Picked to be generous for human-driven UI cases ("select
 * 30 cards, delete") while still bounding the worst case for the
 * single-statement assignable-worker validation pass.
 */
const BATCH_LIMIT = 100;

const ALL_FIELDS: WorkerKindField[] = [
  "description",
  "modelId",
  "systemPrompt",
  "toolsAllow",
  "skills",
];

function allowedFieldsFor(
  kind: string,
  defs: WorkerKindDef[],
): Set<WorkerKindField> {
  const def = defs.find((k) => k.id === kind);
  return new Set(def?.fields ?? ALL_FIELDS);
}

export interface RoutesDeps {
  db: TenantDbHandle;
  tenantId: string;
  log: PluginLogger;
  pool: WorkerPool;
  /** Notify the worker pool that a task changed. */
  onTaskWrite(): void;
  /** Notify the worker pool that the agent set changed. */
  onAgentsWrite(): void;
  /** Workboard-internal kind catalogue. Surfaced to the admin UI
   *  so the picker only offers kinds the runtime can staff. */
  workerKinds: WorkerKindDef[];
  /** Seed specs the plugin shipped, indexed by builtin_key, for
   *  the reset endpoint. */
  seedsByKey: Map<string, SeedAgentSpec>;
}

function userIdFromReq(req: Request): string | null {
  const ctx = (req as { ctx?: { userId?: string } }).ctx;
  return ctx?.userId ?? null;
}

/** Coerce Express's `req.params[name]` (typed `string | string[]` in
 *  v5) to a plain string. We never declare array-shape route params,
 *  so the array branch is impossible at runtime.
 */
function stringParam(req: Request, name: string): string {
  const raw = req.params[name];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && raw.length > 0) return String(raw[0]);
  return "";
}

function taskJson(t: Task): Record<string, unknown> {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    project: t.projectSlug,
    workerRole: t.workerRole,
    workerAgentId: t.workerAgentId,
    status: t.status,
    priority: t.priority,
    resultSummary: t.resultSummary,
    resultFiles: t.resultFiles,
    sessionId: t.sessionId,
    dependsOn: t.dependsOn,
    labels: t.labels,
    failureReason: t.failureReason,
    attempts: t.attempts,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
  };
}

/** Reduce caller-supplied dependsOn to ids that actually belong to
 *  the same owner. Silently drops the rest — simpler than rejecting
 *  the whole request just because one id is bogus. */
function filterOwnedDeps(
  db: typeof deps_unused_marker.db,
  ownerUserId: string,
  raw: unknown,
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((x): x is string => typeof x === "string" && x.length > 0);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare<unknown[], { id: string }>(
      `SELECT id FROM tasks WHERE owner_user_id = ? AND id IN (${placeholders})`,
    )
    .all(ownerUserId, ...ids);
  return rows.map((r) => r.id);
}

/** Compile-time-only marker so we can reuse the deps.db type without
 *  importing the SDK type into a free function above. */
const deps_unused_marker: { db: import("@tianshu/plugin-sdk").TenantDbHandle } = null as never;

function projectsJson(rows: ProjectSummary[]): Record<string, unknown>[] {
  return rows.map((p) => ({
    project: p.projectSlug,
    ready: p.ready,
    inProgress: p.inProgress,
    done: p.done,
    total: p.total,
  }));
}

export function buildRoutes(deps: RoutesDeps): Record<string, PluginRouteHandler> {
  const listTasksHandler: PluginRouteHandler = (req, res) => {
    const userId = userIdFromReq(req);
    if (!userId) {
      res.status(401).json({ error: "no_user" });
      return;
    }

    const project = typeof req.query.project === "string" ? req.query.project : undefined;
    const includeAborted = req.query.include_aborted === "1";
    const statusParam = typeof req.query.status === "string" ? req.query.status : undefined;

    let statuses: TaskStatus[] | undefined;
    if (statusParam) {
      statuses = [];
      for (const s of statusParam.split(",")) {
        const trimmed = s.trim();
        if (!trimmed) continue;
        if (!isTaskStatus(trimmed)) {
          res.status(400).json({ error: "bad_status", status: trimmed });
          return;
        }
        statuses.push(trimmed);
      }
    } else if (includeAborted) {
      statuses = ["ready", "in_progress", "done"];
    }

    const rows = listTasks(deps.db, {
      ownerUserId: userId,
      projectSlug: project ?? null,
      statuses,
    });
    res.json({ tasks: rows.map(taskJson) });
  };

  /**
   * Try to create one task on behalf of `userId`. Returns either
   * `{ ok: true, task }` or `{ ok: false, error, status }` so the
   * batch handler can aggregate results without short-circuiting.
   *
   * `agents` is passed in instead of being fetched per-row so a
   * 100-task batch only hits the DB once for the worker list.
   */
  const createOne = (
    userId: string,
    body: Record<string, unknown>,
    agents: ReturnType<typeof listWorkerAgents>,
  ): {
    ok: boolean;
    task?: ReturnType<typeof taskJson>;
    error?: string;
    status?: number;
    [k: string]: unknown;
  } => {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return { ok: false, error: "title_required", status: 400 };
    if (title.length > 200)
      return { ok: false, error: "title_too_long", status: 400 };

    let initialStatus: TaskStatus | null = null;
    if (typeof body.status === "string") {
      if (!isTaskStatus(body.status)) {
        return {
          ok: false,
          error: "bad_status",
          status: 400,
          received: body.status,
        };
      }
      initialStatus = body.status;
    }
    const description =
      typeof body.description === "string" ? body.description : null;
    const project =
      typeof body.project === "string" ? body.project : undefined;
    const priority = typeof body.priority === "number" ? body.priority : 0;
    const workerRole =
      typeof body.workerRole === "string" ? body.workerRole : null;
    const workerAgentId =
      typeof body.workerAgentId === "string" ? body.workerAgentId : null;

    const assignErr = validateAssignableWorker(agents, {
      workerAgentId,
      workerRole,
    });
    if (assignErr) return { ok: false, ...assignErr, status: 400 };

    const dependsOn = filterOwnedDeps(
      deps.db,
      userId,
      (body as { dependsOn?: unknown }).dependsOn,
    );
    const labelsArg = Array.isArray((body as { labels?: unknown }).labels)
      ? ((body as { labels: unknown[] }).labels.filter(
          (l): l is string => typeof l === "string",
        ) as string[])
      : undefined;

    let task = createTask(deps.db, randomUUID(), {
      ownerUserId: userId,
      title,
      description,
      projectSlug: project,
      priority,
      workerRole,
      workerAgentId,
      dependsOn,
      labels: labelsArg,
    });
    // Optional second-step patch when caller pre-selected a non-`ready`
    // status (e.g. user added a card directly into the In-progress
    // column). Done in-process so the create + status flip land
    // atomically from the client's perspective.
    if (initialStatus && initialStatus !== "ready") {
      const now = Date.now();
      const patch: Parameters<typeof updateTask>[2] = { status: initialStatus };
      if (initialStatus === "in_progress") patch.startedAt = now;
      if (initialStatus === "done") {
        patch.endedAt = now;
      }
      const after = updateTask(deps.db, task.id, patch);
      if (after) task = after;
    }
    return { ok: true, task: taskJson(task) };
  };

  /**
   * POST /tasks  — batch create.
   *
   * Accepts either:
   *   - `{ tasks: TaskInput[] }`         (preferred, batch shape)
   *   - `TaskInput`                       (legacy single-task body — wrapped
   *                                        into a 1-element batch internally)
   *
   * Always responds with `{ results: BatchResult[] }` whose order
   * matches the input. Each result is either
   *   `{ ok: true, task }`
   * or
   *   `{ ok: false, error, ...details }`
   *
   * Per-item failures do NOT abort the batch — good rows still
   * land. The HTTP status is 201 if at least one task was created,
   * 400 if every row failed.
   *
   * The single-task wrapping is here so existing clients (the
   * react panel + the chat-shell) keep working without a flag
   * day; new callers should send the batch shape.
   */
  const createTaskHandler: PluginRouteHandler = (req, res) => {
    const userId = userIdFromReq(req);
    if (!userId) {
      res.status(401).json({ error: "no_user" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const inputs: Record<string, unknown>[] = Array.isArray(body.tasks)
      ? (body.tasks as Record<string, unknown>[])
      : [body];
    if (inputs.length === 0) {
      res.status(400).json({ error: "tasks_empty" });
      return;
    }
    if (inputs.length > BATCH_LIMIT) {
      res
        .status(400)
        .json({ error: "batch_too_large", limit: BATCH_LIMIT });
      return;
    }
    // Cache the agent list once for the whole batch.
    const agents = listWorkerAgents(deps.db, deps.tenantId);
    let anyOk = false;
    const results = inputs.map((input) => {
      if (!input || typeof input !== "object") {
        return { ok: false, error: "task_input_not_object" };
      }
      const r = createOne(userId, input, agents);
      if (r.ok) anyOk = true;
      // Strip the internal `status` hint before sending — clients
      // get a flat envelope per row.
      const { status: _ignored, ...rest } = r;
      return rest;
    });
    if (anyOk) deps.onTaskWrite();
    res.status(anyOk ? 201 : 400).json({ results });
  };

  const patchTaskHandler: PluginRouteHandler = (req, res) => {
    const userId = userIdFromReq(req);
    if (!userId) {
      res.status(401).json({ error: "no_user" });
      return;
    }
    const id = stringParam(req, "id");
    if (!id) {
      res.status(400).json({ error: "id_required" });
      return;
    }
    const before = getTask(deps.db, id);
    if (!before) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (before.ownerUserId !== userId) {
      res.status(403).json({ error: "not_yours" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<typeof updateTask>[2] = {};

    if (typeof body.title === "string") patch.title = body.title;
    if (body.description === null || typeof body.description === "string") {
      patch.description = body.description as string | null;
    }
    if (typeof body.project === "string") patch.projectSlug = body.project;
    if (typeof body.priority === "number") patch.priority = body.priority;
    if (body.workerRole === null || typeof body.workerRole === "string") {
      patch.workerRole = body.workerRole as string | null;
    }
    if (
      body.workerAgentId === null ||
      typeof body.workerAgentId === "string"
    ) {
      patch.workerAgentId = body.workerAgentId as string | null;
    }

    // If the patch touches the assignment surface, validate the new
    // (post-patch) target. Falling through to the pool with a stale
    // assignment would silently park the task in `ready` after a
    // re-queue. Use the patched values where present, otherwise the
    // current row's values — we don't want to spuriously fail when
    // the user is patching only e.g. priority and the agent assigned
    // long ago has since been disabled (different bug to surface).
    const touchesAssignment =
      patch.workerAgentId !== undefined || patch.workerRole !== undefined;
    if (touchesAssignment) {
      const nextAgentId =
        patch.workerAgentId !== undefined
          ? patch.workerAgentId
          : before.workerAgentId;
      const nextRole =
        patch.workerRole !== undefined ? patch.workerRole : before.workerRole;
      const assignErr = validateAssignableWorker(
        listWorkerAgents(deps.db, deps.tenantId),
        { workerAgentId: nextAgentId, workerRole: nextRole },
      );
      if (assignErr) {
        res.status(400).json(assignErr);
        return;
      }
    }
    if (typeof body.status === "string") {
      if (!isTaskStatus(body.status)) {
        res.status(400).json({ error: "bad_status", status: body.status });
        return;
      }
      patch.status = body.status;
      const now = Date.now();
      if (body.status === "in_progress" && !before.startedAt) {
        patch.startedAt = now;
      }
      if (body.status === "done") {
        patch.endedAt = now;
      }
      if (body.status === "ready") {
        patch.startedAt = null;
        patch.endedAt = null;
        patch.resultSummary = null;
      }
    }
    if (
      typeof body.resultSummary === "string" ||
      body.resultSummary === null
    ) {
      patch.resultSummary = body.resultSummary as string | null;
    }
    if (Array.isArray(body.dependsOn) || body.dependsOn === null) {
      const filtered = filterOwnedDeps(
        deps.db,
        userId,
        body.dependsOn ?? [],
      );
      if (filtered !== undefined) {
        patch.dependsOn = filtered.filter((depId) => depId !== id);
      }
    }
    if (Array.isArray(body.labels)) {
      patch.labels = (body.labels as unknown[]).filter(
        (l): l is string => typeof l === "string",
      );
    }
    if (typeof body.attempts === "number" && Number.isFinite(body.attempts)) {
      // Allow the user to reset the retry counter ("Retry" button
      // on the stalled-label chip). We don't need a stricter
      // contract — attempts is informational; if a client sets a
      // weird value the worker pool just keeps incrementing from
      // there.
      patch.attempts = body.attempts;
    }
    if (
      typeof body.failureReason === "string" ||
      body.failureReason === null
    ) {
      patch.failureReason = body.failureReason as string | null;
    }

    const after = updateTask(deps.db, id, patch);
    // If the patch removed a pool-skip label (e.g. user cleared
    // 'stalled' to retry), nudge so the pool re-considers the row
    // even though status didn't change.
    if (after && patch.labels !== undefined) {
      const wasSkipped = before.labels.some((l) =>
        ["stalled", "draft"].includes(l),
      );
      const stillSkipped = after.labels.some((l) =>
        ["stalled", "draft"].includes(l),
      );
      if (wasSkipped && !stillSkipped && after.status === "ready") {
        deps.onTaskWrite();
      }
    }
    // Nudge the pool whenever the patch could change task
    // eligibility for ANY downstream worker:
    //   - status → 'ready'  : this task itself just became eligible.
    //   - status → 'done'   : downstream tasks that depend on this
    //                         one may now be unblocked.
    // Forgetting the second case is the bug Yu hit: T1–T3 manually
    // patched to 'done' didn't release T4, which kept the chain
    // wedged until a manual workers/restart.
    if (after && after.status !== before.status) {
      if (after.status === "ready" || after.status === "done") {
        deps.onTaskWrite();
      }
    }
    res.json({ task: after ? taskJson(after) : null });
  };

  /**
   * GET /tasks/:id/history
   *
   * Returns the worker session transcript for the task's most
   * recent run (`tasks.session_id`). The kanban Execution tab and
   * the chat-side `task_get_history` agent tool both consume this.
   *
   * Auth: same as listTasks — you can only see history for tasks
   * you own. A task without `session_id` (never claimed) returns
   * `{ entries: [] }` rather than 404 so the UI can still render
   * an "hasn't run yet" empty state without an error toast.
   */
  const taskHistoryHandler: PluginRouteHandler = (req, res) => {
    const userId = userIdFromReq(req);
    if (!userId) {
      res.status(401).json({ error: "no_user" });
      return;
    }
    const id = stringParam(req, "id");
    if (!id) {
      res.status(400).json({ error: "id_required" });
      return;
    }
    const task = getTask(deps.db, id);
    if (!task) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (task.ownerUserId !== userId) {
      res.status(403).json({ error: "not_yours" });
      return;
    }
    const sessionId = task.sessionId;
    if (!sessionId) {
      res.json({
        sessionId: null,
        entries: [],
        attempts: task.attempts,
        failureReason: task.failureReason,
      });
      return;
    }
    const entries = readSessionHistory(deps.db, sessionId);
    res.json({
      sessionId,
      entries,
      attempts: task.attempts,
      failureReason: task.failureReason,
    });
  };

  /**
   * Try to delete one task on behalf of `userId`. Returns a per-row
   * result envelope so the batch handler can aggregate.
   */
  const deleteOne = (
    userId: string,
    id: unknown,
  ): { ok: boolean; id?: string; error?: string } => {
    if (typeof id !== "string" || !id.trim()) {
      return { ok: false, error: "id_required" };
    }
    const before = getTask(deps.db, id);
    if (!before) return { ok: false, id, error: "not_found" };
    if (before.ownerUserId !== userId)
      return { ok: false, id, error: "not_yours" };
    deleteTask(deps.db, id);
    return { ok: true, id };
  };

  /**
   * POST /tasks/delete  — batch delete.
   *
   * Body: `{ ids: string[] }`. Always responds with
   * `{ results: { ok, id, error? }[] }` whose order matches the
   * input.
   *
   * We use POST + a side path instead of `DELETE /tasks` because
   * not every HTTP intermediary forwards a request body on DELETE,
   * and we want the contract to be unambiguous.
   *
   * Per-item failures do not abort the batch. The HTTP status is
   * 200 if any row was deleted, 400 if every row failed (most
   * commonly: ids belonged to someone else, or were unknown).
   */
  const deleteTaskHandler: PluginRouteHandler = (req, res) => {
    const userId = userIdFromReq(req);
    if (!userId) {
      res.status(401).json({ error: "no_user" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(body.ids) ? (body.ids as unknown[]) : null;
    if (!ids) {
      res.status(400).json({ error: "ids_required" });
      return;
    }
    if (ids.length === 0) {
      res.status(400).json({ error: "ids_empty" });
      return;
    }
    if (ids.length > BATCH_LIMIT) {
      res
        .status(400)
        .json({ error: "batch_too_large", limit: BATCH_LIMIT });
      return;
    }
    let anyOk = false;
    const results = ids.map((id) => {
      const r = deleteOne(userId, id);
      if (r.ok) anyOk = true;
      return r;
    });
    if (anyOk) deps.onTaskWrite();
    res.status(anyOk ? 200 : 400).json({ results });
  };

  const listProjectsHandler: PluginRouteHandler = (req, res) => {
    const userId = userIdFromReq(req);
    if (!userId) {
      res.status(401).json({ error: "no_user" });
      return;
    }
    res.json({ projects: projectsJson(listProjects(deps.db, userId)) });
  };

  const workerStatusHandler: PluginRouteHandler = (_req, res) => {
    res.json(deps.pool.status());
  };

  const workerRestartHandler: PluginRouteHandler = (_req, res) => {
    deps.pool.nudge();
    res.json({ ok: true });
  };

  // ─── Worker agents (N+6.2 v2: plugin-owned) ───────────────────

  const listAgentsHandler: PluginRouteHandler = (_req, res) => {
    res.json({
      agents: listWorkerAgents(deps.db, deps.tenantId),
      kinds: deps.workerKinds,
    });
  };

  const createAgentHandler: PluginRouteHandler = (req, res) => {
    const userId = userIdFromReq(req);
    if (!userId) {
      res.status(401).json({ error: "no_user" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = typeof body.kind === "string" ? body.kind.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!kind) {
      res.status(400).json({ error: "kind_required" });
      return;
    }
    if (!name) {
      res.status(400).json({ error: "name_required" });
      return;
    }
    if (name.length > 80) {
      res.status(400).json({ error: "name_too_long" });
      return;
    }
    const def = deps.workerKinds.find((k) => k.id === kind);
    if (!def) {
      res.status(400).json({ error: "unknown_kind", kind });
      return;
    }
    if (def.userCreatable === false) {
      res.status(400).json({ error: "kind_not_user_creatable", kind });
      return;
    }

    const allow = allowedFieldsFor(kind, deps.workerKinds);
    // Reject fields the kind didn't opt into so an echo agent
    // can't accidentally carry an llm-shaped systemPrompt.
    const stray = ALL_FIELDS.find(
      (f) => !allow.has(f) && (body as Record<string, unknown>)[f] !== undefined,
    );
    if (stray) {
      res.status(400).json({
        error: "field_not_allowed_for_kind",
        kind,
        field: stray,
      });
      return;
    }
    const description =
      allow.has("description") && typeof body.description === "string"
        ? body.description
        : null;
    const modelId =
      allow.has("modelId") && typeof body.modelId === "string"
        ? body.modelId
        : null;
    const systemPrompt =
      allow.has("systemPrompt") && typeof body.systemPrompt === "string"
        ? body.systemPrompt
        : null;
    const toolsAllow =
      allow.has("toolsAllow") && Array.isArray(body.toolsAllow)
        ? body.toolsAllow.filter((x): x is string => typeof x === "string")
        : null;
    const skills =
      allow.has("skills") && Array.isArray(body.skills)
        ? body.skills.filter((x): x is string => typeof x === "string")
        : null;

    const agent = createUserWorkerAgent(deps.db, deps.tenantId, {
      kind,
      name,
      description,
      modelId,
      systemPrompt,
      toolsAllow,
      skills,
      ownerUserId: userId,
    });
    deps.onAgentsWrite();
    res.status(201).json({ agent });
  };

  const patchAgentHandler: PluginRouteHandler = (req, res) => {
    const userId = userIdFromReq(req);
    if (!userId) {
      res.status(401).json({ error: "no_user" });
      return;
    }
    const id = stringParam(req, "id");
    if (!id) {
      res.status(400).json({ error: "id_required" });
      return;
    }
    const before = getWorkerAgent(deps.db, deps.tenantId, id);
    if (!before) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<typeof updateWorkerAgent>[3] = {};
    const allow = allowedFieldsFor(before.kind, deps.workerKinds);
    const stray = ALL_FIELDS.find(
      (f) => !allow.has(f) && body[f] !== undefined,
    );
    if (stray) {
      res.status(400).json({
        error: "field_not_allowed_for_kind",
        kind: before.kind,
        field: stray,
      });
      return;
    }
    if (typeof body.name === "string") patch.name = body.name;
    if (allow.has("description") && "description" in body) {
      patch.description =
        typeof body.description === "string" ? body.description : null;
    }
    if (allow.has("modelId") && "modelId" in body) {
      patch.modelId = typeof body.modelId === "string" ? body.modelId : null;
    }
    if (allow.has("systemPrompt") && "systemPrompt" in body) {
      patch.systemPrompt =
        typeof body.systemPrompt === "string" ? body.systemPrompt : null;
    }
    if (allow.has("toolsAllow") && "toolsAllow" in body) {
      patch.toolsAllow = Array.isArray(body.toolsAllow)
        ? body.toolsAllow.filter((x): x is string => typeof x === "string")
        : null;
    }
    if (allow.has("skills") && "skills" in body) {
      patch.skills = Array.isArray(body.skills)
        ? body.skills.filter((x): x is string => typeof x === "string")
        : null;
    }
    if (typeof body.enabled === "boolean") {
      patch.enabled = body.enabled;
    }
    const after = updateWorkerAgent(deps.db, deps.tenantId, id, patch);
    deps.onAgentsWrite();
    res.json({ agent: after });
  };

  const deleteAgentHandler: PluginRouteHandler = (req, res) => {
    const id = stringParam(req, "id");
    if (!id) {
      res.status(400).json({ error: "id_required" });
      return;
    }
    const before = getWorkerAgent(deps.db, deps.tenantId, id);
    if (!before) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (before.source === "builtin") {
      res.status(400).json({ error: "cannot_delete_builtin" });
      return;
    }
    deleteWorkerAgent(deps.db, deps.tenantId, id);
    deps.onAgentsWrite();
    res.status(204).end();
  };

  const resetAgentHandler: PluginRouteHandler = (req, res) => {
    const id = stringParam(req, "id");
    if (!id) {
      res.status(400).json({ error: "id_required" });
      return;
    }
    const before = getWorkerAgent(deps.db, deps.tenantId, id);
    if (!before) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (before.source !== "builtin" || !before.builtinKey) {
      res.status(400).json({ error: "not_a_builtin_agent" });
      return;
    }
    const after = resetBuiltinAgent(
      deps.db,
      deps.tenantId,
      id,
      deps.seedsByKey,
    );
    if (!after) {
      res.status(400).json({ error: "seed_not_found" });
      return;
    }
    deps.onAgentsWrite();
    res.json({ agent: after });
  };

  return {
    listTasks: listTasksHandler,
    createTask: createTaskHandler,
    patchTask: patchTaskHandler,
    taskHistory: taskHistoryHandler,
    deleteTask: deleteTaskHandler,
    listProjects: listProjectsHandler,
    workerStatus: workerStatusHandler,
    workerRestart: workerRestartHandler,
    listAgents: listAgentsHandler,
    createAgent: createAgentHandler,
    patchAgent: patchAgentHandler,
    deleteAgent: deleteAgentHandler,
    resetAgent: resetAgentHandler,
  };
}
