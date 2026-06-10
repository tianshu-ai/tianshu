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
} from "../db/agents.js";
import type { WorkerPool } from "../worker/pool.js";

export interface WorkerKindDef {
  id: string;
  displayName: string;
  description?: string;
  /** Default true. When false, hidden from the "new agent" picker;
   *  used for demo runtimes that should only ever exist as seeds. */
  userCreatable?: boolean;
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
    status: t.status,
    priority: t.priority,
    resultSummary: t.resultSummary,
    resultFiles: t.resultFiles,
    sessionId: t.sessionId,
    dependsOn: t.dependsOn,
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
    todo: p.todo,
    inProgress: p.inProgress,
    done: p.done,
    stalled: p.stalled,
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
      statuses = ["todo", "in_progress", "done", "stalled", "aborted"];
    }

    const rows = listTasks(deps.db, {
      ownerUserId: userId,
      projectSlug: project ?? null,
      statuses,
    });
    res.json({ tasks: rows.map(taskJson) });
  };

  const createTaskHandler: PluginRouteHandler = (req, res) => {
    const userId = userIdFromReq(req);
    if (!userId) {
      res.status(401).json({ error: "no_user" });
      return;
    }
    const body = (req.body ?? {}) as {
      title?: unknown;
      description?: unknown;
      project?: unknown;
      priority?: unknown;
      workerRole?: unknown;
      workerAgentId?: unknown;
      status?: unknown;
    };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      res.status(400).json({ error: "title_required" });
      return;
    }
    if (title.length > 200) {
      res.status(400).json({ error: "title_too_long" });
      return;
    }
    let initialStatus: TaskStatus | null = null;
    if (typeof body.status === "string") {
      if (!isTaskStatus(body.status)) {
        res.status(400).json({ error: "bad_status", status: body.status });
        return;
      }
      initialStatus = body.status;
    }
    const description = typeof body.description === "string" ? body.description : null;
    const project = typeof body.project === "string" ? body.project : undefined;
    const priority = typeof body.priority === "number" ? body.priority : 0;
    const workerRole = typeof body.workerRole === "string" ? body.workerRole : null;
    const workerAgentId =
      typeof body.workerAgentId === "string" ? body.workerAgentId : null;
    const dependsOn = filterOwnedDeps(
      deps.db,
      userId,
      (body as { dependsOn?: unknown }).dependsOn,
    );

    let task = createTask(deps.db, randomUUID(), {
      ownerUserId: userId,
      title,
      description,
      projectSlug: project,
      priority,
      workerRole,
      workerAgentId,
      dependsOn,
    });
    // Optional second-step patch when caller pre-selected a non-`todo`
    // status (e.g. user added a card directly into the In-progress
    // column). Done in-process so the create + status flip land
    // atomically from the client's perspective.
    if (initialStatus && initialStatus !== "todo") {
      const now = Date.now();
      const patch: Parameters<typeof updateTask>[2] = { status: initialStatus };
      if (initialStatus === "in_progress") patch.startedAt = now;
      if (
        initialStatus === "done" ||
        initialStatus === "stalled" ||
        initialStatus === "aborted"
      ) {
        patch.endedAt = now;
      }
      const after = updateTask(deps.db, task.id, patch);
      if (after) task = after;
    }
    deps.onTaskWrite();
    res.status(201).json({ task: taskJson(task) });
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
      if (
        body.status === "done" ||
        body.status === "stalled" ||
        body.status === "aborted"
      ) {
        patch.endedAt = now;
      }
      if (body.status === "todo") {
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

    const after = updateTask(deps.db, id, patch);
    if (after && after.status === "todo" && before.status !== "todo") {
      deps.onTaskWrite();
    }
    res.json({ task: after ? taskJson(after) : null });
  };

  const deleteTaskHandler: PluginRouteHandler = (req, res) => {
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
    deleteTask(deps.db, id);
    res.status(204).end();
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

    const description =
      typeof body.description === "string" ? body.description : null;
    const modelId = typeof body.modelId === "string" ? body.modelId : null;
    const systemPrompt =
      typeof body.systemPrompt === "string" ? body.systemPrompt : null;
    const toolsAllow = Array.isArray(body.toolsAllow)
      ? body.toolsAllow.filter((x): x is string => typeof x === "string")
      : null;
    const skills = Array.isArray(body.skills)
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
    if (typeof body.name === "string") patch.name = body.name;
    if ("description" in body) {
      patch.description =
        typeof body.description === "string" ? body.description : null;
    }
    if ("modelId" in body) {
      patch.modelId = typeof body.modelId === "string" ? body.modelId : null;
    }
    if ("systemPrompt" in body) {
      patch.systemPrompt =
        typeof body.systemPrompt === "string" ? body.systemPrompt : null;
    }
    if ("toolsAllow" in body) {
      patch.toolsAllow = Array.isArray(body.toolsAllow)
        ? body.toolsAllow.filter((x): x is string => typeof x === "string")
        : null;
    }
    if ("skills" in body) {
      patch.skills = Array.isArray(body.skills)
        ? body.skills.filter((x): x is string => typeof x === "string")
        : null;
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
