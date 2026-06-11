// SQL-level access to the `tasks` table.
//
// The schema lives in `packages/server/src/core/migrations/001-initial.ts`
// (ADR-0002 §6) — workboard is the first feature that actually reads
// and writes it. This module is the single chokepoint between the
// rest of the plugin and the database, so future schema tweaks
// (e.g. adding a `labels` column) only have to update one file.
//
// All functions take an explicit tenant-scoped `db` handle
// (`PluginContext.db`). They never look up the handle themselves —
// the activator passes it in. That keeps tests easy: just spin up an
// in-memory better-sqlite3, run the migration, point this code at it.

import type { TenantDbHandle } from "@tianshu/plugin-sdk";

/**
 * Task lifecycle. Four states (was five before migration 005).
 *
 *   ready       — in the queue, eligible for a worker (deps done,
 *                 attempts < MAX_ATTEMPTS). Newly-created tasks land
 *                 here. Failed runs come back here too with
 *                 `attempts++` and a `failureReason`.
 *   in_progress — a worker has claimed it.
 *   done        — worker called task_complete, summary recorded.
 *   stalled     — final graveyard. A task only ends up here after
 *                 the worker pool has retried it MAX_ATTEMPTS times
 *                 without a `done`. The user must intervene
 *                 (PATCH back to ready / edit description / delete).
 *
 * Renamed in 005:
 *   `todo` → `ready`           (semantics-driven rename)
 *   `aborted` → folded into `ready` (failure_reason carries why)
 */
export type TaskStatus = "ready" | "in_progress" | "done" | "stalled";

/** Display-only — UI renders columns in this order. `stalled` lives
 *  outside the default set since it's the final-failure column the
 *  user only opens via the "show archived" toggle. */
export const VISIBLE_STATUSES: TaskStatus[] = [
  "ready",
  "in_progress",
  "done",
  "stalled",
];

export interface Task {
  id: string;
  projectSlug: string;
  ownerUserId: string;
  workerRole: string | null;
  /** Structured replacement for `workerRole` (N+6.2). When set, the
   *  pool dispatches to the matching `worker_agents` row regardless
   *  of `workerRole`. Both fields coexist for one release; the pool
   *  prefers `workerAgentId`. */
  workerAgentId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  resultSummary: string | null;
  /** Workspace paths (relative to the per-user home). */
  resultFiles: string[];
  sessionId: string | null;
  /** Task ids that must reach status='done' before this task is
   *  eligible for a worker. Owner-scoped: ids must belong to the
   *  same user. Empty array = no prerequisites. */
  dependsOn: string[];
  /** Last failure reason; populated when the worker pool put a
   *  task back into `ready` after a failed run, or stamped onto a
   *  task that ended up in the final `stalled` graveyard. Null on
   *  fresh tasks and on successful runs. */
  failureReason: string | null;
  /** How many times the worker pool has run this task without
   *  reaching `done`. Reset to 0 on success. The pool stops
   *  re-queueing after MAX_ATTEMPTS — task moves to `stalled`. */
  attempts: number;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

interface TaskRow {
  id: string;
  project_slug: string;
  owner_user_id: string;
  worker_role: string | null;
  worker_agent_id: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  result_summary: string | null;
  result_files: string | null;
  session_id: string | null;
  depends_on: string | null;
  failure_reason: string | null;
  attempts: number;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    // Older / hand-written rows may have non-JSON content; treat as
    // empty rather than blow up the list endpoint.
    return [];
  }
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectSlug: row.project_slug,
    ownerUserId: row.owner_user_id,
    workerRole: row.worker_role,
    workerAgentId: row.worker_agent_id,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    priority: row.priority,
    resultSummary: row.result_summary,
    resultFiles: parseStringArray(row.result_files),
    sessionId: row.session_id,
    dependsOn: parseStringArray(row.depends_on),
    failureReason: row.failure_reason,
    attempts: row.attempts ?? 0,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export interface CreateTaskInput {
  ownerUserId: string;
  title: string;
  description?: string | null;
  projectSlug?: string;
  workerRole?: string | null;
  /** Pin the task to a specific worker agent (host DB id). When
   *  set, the pool routes here instead of doing a role match. */
  workerAgentId?: string | null;
  priority?: number;
  /** Task ids that must reach status='done' first. Caller is
   *  responsible for filtering to ids belonging to the same owner;
   *  the route layer does that today. */
  dependsOn?: string[];
}

const STATUS_VALUES = new Set<TaskStatus>([
  "ready",
  "in_progress",
  "done",
  "stalled",
]);

export function isTaskStatus(s: string): s is TaskStatus {
  return STATUS_VALUES.has(s as TaskStatus);
}

/** Insert a fresh `ready` task. Caller supplies the id (UUID). */
export function createTask(
  db: TenantDbHandle,
  id: string,
  input: CreateTaskInput,
): Task {
  const now = Date.now();
  const project = (input.projectSlug ?? "inbox").trim() || "inbox";
  const role = input.workerRole?.trim() ? input.workerRole.trim() : null;
  const agentId =
    input.workerAgentId?.trim() ? input.workerAgentId.trim() : null;
  const priority = Number.isFinite(input.priority) ? Number(input.priority) : 0;
  const dependsOn = sanitiseDependsOn(input.dependsOn, id);
  db.prepare(
    `INSERT INTO tasks (
       id, project_slug, owner_user_id, worker_role, worker_agent_id,
       title, description, status, priority,
       result_summary, result_files, session_id, depends_on,
       failure_reason, attempts,
       created_at, started_at, ended_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, NULL, NULL, NULL, ?, NULL, 0, ?, NULL, NULL)`,
  ).run(
    id,
    project,
    input.ownerUserId,
    role,
    agentId,
    input.title.trim(),
    input.description?.trim() || null,
    priority,
    JSON.stringify(dependsOn),
    now,
  );
  const row = db
    .prepare<[string], TaskRow>(`SELECT * FROM tasks WHERE id = ?`)
    .get(id);
  if (!row) throw new Error(`createTask: row ${id} vanished`);
  return rowToTask(row);
}

export interface ListTasksOpts {
  /** Filter by owner. v0 always passes the requesting user; the host
   *  treats a tenant as a single trust domain (ADR-0001) so other
   *  users in the same tenant could be allowed later, but for v0 we
   *  scope the UI to "my tasks". */
  ownerUserId?: string;
  /** Filter by project slug; null means "any project". */
  projectSlug?: string | null;
  /** Filter by status; default returns the four visible columns. */
  statuses?: TaskStatus[];
  /** Hard cap on rows. Default 500. The board is per-user — no one
   *  reasonably has more than a few hundred open tasks. */
  limit?: number;
}

export function listTasks(db: TenantDbHandle, opts: ListTasksOpts = {}): Task[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.ownerUserId) {
    where.push("owner_user_id = ?");
    params.push(opts.ownerUserId);
  }

  if (opts.projectSlug !== undefined && opts.projectSlug !== null) {
    where.push("project_slug = ?");
    params.push(opts.projectSlug);
  }

  const statuses = opts.statuses && opts.statuses.length > 0
    ? opts.statuses
    : VISIBLE_STATUSES;
  where.push(`status IN (${statuses.map(() => "?").join(",")})`);
  params.push(...statuses);

  const limit = Math.max(1, Math.min(opts.limit ?? 500, 2000));
  const sql =
    `SELECT * FROM tasks WHERE ${where.join(" AND ")}
     ORDER BY priority DESC, created_at ASC
     LIMIT ?`;
  params.push(limit);

  const rows = db.prepare<unknown[], TaskRow>(sql).all(...params);
  return rows.map(rowToTask);
}

export function getTask(db: TenantDbHandle, id: string): Task | null {
  const row = db
    .prepare<[string], TaskRow>(`SELECT * FROM tasks WHERE id = ?`)
    .get(id);
  return row ? rowToTask(row) : null;
}

export interface UpdateTaskPatch {
  title?: string;
  description?: string | null;
  projectSlug?: string;
  priority?: number;
  workerRole?: string | null;
  workerAgentId?: string | null;
  status?: TaskStatus;
  resultSummary?: string | null;
  resultFiles?: string[];
  sessionId?: string | null;
  /** Replace the dependency list. Caller is responsible for vetting
   *  ownership; the workboard route layer does that. Pass [] to
   *  clear. */
  dependsOn?: string[];
  failureReason?: string | null;
  attempts?: number;
  startedAt?: number | null;
  endedAt?: number | null;
}

/** Patch a task. Status transitions are validated by the caller —
 *  this function trusts whatever it gets. Returns the updated row,
 *  or null if the id doesn't exist. */
export function updateTask(
  db: TenantDbHandle,
  id: string,
  patch: UpdateTaskPatch,
): Task | null {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.title !== undefined) {
    sets.push("title = ?");
    params.push(patch.title.trim());
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    params.push(patch.description?.trim() || null);
  }
  if (patch.projectSlug !== undefined) {
    sets.push("project_slug = ?");
    params.push(patch.projectSlug.trim() || "inbox");
  }
  if (patch.priority !== undefined) {
    sets.push("priority = ?");
    params.push(Number(patch.priority));
  }
  if (patch.workerRole !== undefined) {
    sets.push("worker_role = ?");
    params.push(patch.workerRole?.trim() ? patch.workerRole.trim() : null);
  }
  if (patch.workerAgentId !== undefined) {
    sets.push("worker_agent_id = ?");
    params.push(
      patch.workerAgentId?.trim() ? patch.workerAgentId.trim() : null,
    );
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.resultSummary !== undefined) {
    sets.push("result_summary = ?");
    params.push(patch.resultSummary?.trim() || null);
  }
  if (patch.resultFiles !== undefined) {
    sets.push("result_files = ?");
    params.push(JSON.stringify(patch.resultFiles));
  }
  if (patch.sessionId !== undefined) {
    sets.push("session_id = ?");
    params.push(patch.sessionId);
  }
  if (patch.dependsOn !== undefined) {
    sets.push("depends_on = ?");
    params.push(JSON.stringify(sanitiseDependsOn(patch.dependsOn, id)));
  }
  if (patch.failureReason !== undefined) {
    sets.push("failure_reason = ?");
    params.push(patch.failureReason);
  }
  if (patch.attempts !== undefined) {
    sets.push("attempts = ?");
    params.push(Number(patch.attempts));
  }
  if (patch.startedAt !== undefined) {
    sets.push("started_at = ?");
    params.push(patch.startedAt);
  }
  if (patch.endedAt !== undefined) {
    sets.push("ended_at = ?");
    params.push(patch.endedAt);
  }

  if (sets.length === 0) return getTask(db, id);

  params.push(id);
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getTask(db, id);
}

export function deleteTask(db: TenantDbHandle, id: string): boolean {
  const before = getTask(db, id);
  if (!before) return false;
  db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
  return true;
}

export interface ProjectSummary {
  projectSlug: string;
  ready: number;
  inProgress: number;
  done: number;
  stalled: number;
  total: number;
}

/** Group counts by project slug, scoped to one owner. Used by the
 *  admin page's project filter dropdown. */
export function listProjects(
  db: TenantDbHandle,
  ownerUserId: string,
): ProjectSummary[] {
  const rows = db
    .prepare<[string], { project_slug: string; status: string; count: number }>(
      `SELECT project_slug, status, COUNT(*) AS count
       FROM tasks
       WHERE owner_user_id = ?
         AND status IN ('ready','in_progress','done','stalled')
       GROUP BY project_slug, status
       ORDER BY project_slug ASC`,
    )
    .all(ownerUserId);

  const byProject = new Map<string, ProjectSummary>();
  for (const row of rows) {
    let entry = byProject.get(row.project_slug);
    if (!entry) {
      entry = {
        projectSlug: row.project_slug,
        ready: 0,
        inProgress: 0,
        done: 0,
        stalled: 0,
        total: 0,
      };
      byProject.set(row.project_slug, entry);
    }
    if (row.status === "ready") entry.ready = row.count;
    else if (row.status === "in_progress") entry.inProgress = row.count;
    else if (row.status === "done") entry.done = row.count;
    else if (row.status === "stalled") entry.stalled = row.count;
    entry.total += row.count;
  }
  return [...byProject.values()];
}

/**
 * Atomically claim one `ready` task, flipping it to `in_progress`
 * and stamping `started_at`. Returns null if the board is empty
 * (or all eligible tasks are blocked by unfinished dependencies).
 *
 * The claim is atomic in SQLite by virtue of running inside one
 * statement (`UPDATE ... WHERE id = (SELECT ...)`), then re-reading
 * the updated row. SQLite's serialised writer makes a "two workers
 * grab the same row" race impossible.
 *
 * Dependency check: we walk eligible candidates in priority order
 * and skip any whose `depends_on` contains an id whose row is not
 * yet `done`. The check happens in JS rather than SQL because the
 * column is JSON-encoded; in practice the eligible set is tiny so
 * this is fine.
 */
export function claimNextTask(
  db: TenantDbHandle,
  opts: {
    workerRole?: string | null;
    /** When set, only claim tasks whose `worker_agent_id` matches
     *  this id, OR are unpinned and whose `worker_role` matches
     *  the legacy role (so a worker covers both old and new
     *  pinning surfaces). */
    workerAgentId?: string | null;
    sessionId?: string | null;
  } = {},
): Task | null {
  const role = opts.workerRole ?? null;
  const agentId = opts.workerAgentId ?? null;
  const sessionId = opts.sessionId ?? null;
  const now = Date.now();

  // Selection rules:
  //   * worker pinned to an agent  →  rows pinned to the same
  //     agent, OR rows with no agent pin and matching/empty role
  //   * worker not pinned (legacy)  →  rows with no agent pin and
  //     matching/empty role
  // Either case rejects rows that are pinned to a *different*
  // agent — the host DB owns the agent identity, so a wrong-agent
  // claim would silently misroute work.
  const eligible = (() => {
    if (agentId) {
      return db
        .prepare<[string, string], TaskRow>(
          `SELECT * FROM tasks
           WHERE status = 'ready'
             AND ( worker_agent_id = ?
                   OR (worker_agent_id IS NULL
                       AND (worker_role IS NULL OR worker_role = ?)))
           ORDER BY priority DESC, created_at ASC
           LIMIT 50`,
        )
        .all(agentId, role ?? "");
    }
    if (role) {
      return db
        .prepare<[string], TaskRow>(
          `SELECT * FROM tasks
           WHERE status = 'ready'
             AND worker_agent_id IS NULL
             AND (worker_role IS NULL OR worker_role = ?)
           ORDER BY priority DESC, created_at ASC
           LIMIT 50`,
        )
        .all(role);
    }
    return db
      .prepare<[], TaskRow>(
        `SELECT * FROM tasks
         WHERE status = 'ready'
           AND worker_agent_id IS NULL
         ORDER BY priority DESC, created_at ASC
         LIMIT 50`,
      )
      .all();
  })();

  for (const row of eligible) {
    const candidate = rowToTask(row);
    if (!isEligible(db, candidate)) continue;

    const result = db
      .prepare<[number, string | null, string], { changes?: number }>(
        `UPDATE tasks
         SET status = 'in_progress', started_at = ?, session_id = ?
         WHERE id = ? AND status = 'ready'`,
      )
      .run(now, sessionId, candidate.id) as { changes: number };
    if (!result.changes) continue;

    return getTask(db, candidate.id);
  }
  return null;
}

/** Returns true if every dependency of `task` is in status='done'.
 *  An empty `dependsOn` is always eligible. */
export function isEligible(db: TenantDbHandle, task: Task): boolean {
  if (task.dependsOn.length === 0) return true;
  const placeholders = task.dependsOn.map(() => "?").join(",");
  const rows = db
    .prepare<unknown[], { id: string; status: string }>(
      `SELECT id, status FROM tasks WHERE id IN (${placeholders})`,
    )
    .all(...task.dependsOn);
  // Missing rows count as unsatisfied — a deleted prerequisite
  // doesn't auto-resolve. (Owner can re-point with task_update.)
  if (rows.length !== task.dependsOn.length) return false;
  return rows.every((r) => r.status === "done");
}

/** Trim, dedupe, and refuse self-references. */
function sanitiseDependsOn(
  raw: string[] | undefined,
  selfId: string,
): string[] {
  if (!raw || raw.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== "string") continue;
    const id = candidate.trim();
    if (!id || id === selfId || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
