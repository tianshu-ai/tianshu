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

import type { TenantDbHandle } from "@tianshu-ai/plugin-sdk";

/**
 * Task lifecycle — only three states.
 *
 *   ready       — in the queue, eligible for a worker (deps done,
 *                 not labelled `awaiting-intervention` / `stalled`
 *                 / `draft`). Newly-created tasks land here, and
 *                 so do tasks the main agent revived via
 *                 task_continue / task_retry_fresh.
 *   in_progress — a worker has claimed it.
 *   done        — task_complete, or main agent called task_abort.
 *
 * Failure modes are expressed via labels instead of a separate
 * status column (mirrors the closed-source predecessor):
 *
 *   labels: ['awaiting-intervention']  the worker run failed or
 *                        timed out; the pool stamped a reason
 *                        and notified the parent session. The
 *                        pool will NOT pick the task up again
 *                        until the main agent clears the label
 *                        (via task_continue / task_retry_fresh /
 *                        task_abort). 008 introduced this.
 *   labels: ['stalled']  legacy label. Treated identically to
 *                        awaiting-intervention by the pool's
 *                        skip filter. Existing rows from before
 *                        008 keep working.
 *   labels: ['draft']    not ready for the pool yet; pool skips.
 *
 * Migration history:
 *   003 added the entry tree.
 *   005 renamed `todo` → `ready`, folded `aborted` into `ready`.
 *   006 turned the `stalled` STATUS into a `stalled` LABEL.
 *   008 added timeout_ms / intervention_reason / intervention_at
 *       and introduced the `awaiting-intervention` label that
 *       replaces the auto-retry loop with main-agent dispatch.
 */
export type TaskStatus = "ready" | "in_progress" | "done";

/** Display-only — the kanban shows exactly these three columns. */
export const VISIBLE_STATUSES: TaskStatus[] = [
  "ready",
  "in_progress",
  "done",
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
  /** Counter only. Bumped on every fresh claim. Doesn't drive
   *  any policy after the 008 intervention model — the pool no
   *  longer auto-retries; failures route to the parent agent
   *  via the `awaiting-intervention` label. Kept here so the UI
   *  / inbox can show "3rd time we tried this" if it wants. */
  attempts: number;
  /** Free-form labels. Three are reserved by the worker pool
   *  (see `POOL_SKIP_LABELS`):
   *    - `awaiting-intervention` — stamped by the pool on any
   *      worker failure or watchdog timeout. The main (parent)
   *      session is notified; the pool will not claim the task
   *      again until the label is cleared (task_continue /
   *      task_retry_fresh / task_abort do this).
   *    - `stalled` — legacy alias kept for backwards-compat with
   *      pre-008 rows + tools that still set it. Same skip
   *      semantics as awaiting-intervention.
   *    - `draft`   — user-set; same skip semantics. "Not ready
   *      yet, don't pick up."
   *  Anything else is user metadata; the UI renders verbatim. */
  labels: string[];
  /** Soft per-task budget in ms. Pool watchdog cancels the
   *  worker if it's still running at started_at + timeout_ms,
   *  and routes the task to intervention with a timeout reason.
   *  Default 600_000 (10 minutes); main agent extends via
   *  task_extend_timeout. */
  timeoutMs: number;
  /** Free-text reason populated when the pool stamps
   *  `awaiting-intervention`. Cleared when the label is cleared
   *  (i.e. on the next fresh claim). NULL on healthy rows. */
  interventionReason: string | null;
  /** ms timestamp the row entered awaiting-intervention. NULL
   *  on healthy rows. */
  interventionAt: number | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /**
   * Session that asked for this task (typically a chat session
   * whose LLM called `task_create`). Used by the worker pool's
   * terminal hook to drop a task_done / task_stalled message into
   * that session's inbox. NULL for tasks created outside an LLM
   * call (kanban add button, REST API, sync from external).
   */
  parentSessionId: string | null;
}

/** Labels that take the row out of pool consideration even when
 *  status='ready'. Mirrors the closed-source predecessor.
 *
 *  Order matters for diagnostics only — the pool checks
 *  membership, not order. `awaiting-intervention` first because
 *  it's the post-008 default failure label. */
export const POOL_SKIP_LABELS: readonly string[] = [
  "awaiting-intervention",
  "stalled",
  "draft",
];

/** The single canonical failure label used by the post-008 pool.
 *  Tools that revive a task should clear this. */
export const INTERVENTION_LABEL = "awaiting-intervention";

/** Default per-task watchdog budget. 10 minutes felt like the
 *  shortest interval where "slow but making progress" wouldn't
 *  trip the watchdog and "stuck on a dead model call" would. */
export const DEFAULT_TASK_TIMEOUT_MS = 600_000;

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
  labels: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  parent_session_id: string | null;
  timeout_ms: number | null;
  intervention_reason: string | null;
  intervention_at: number | null;
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
    labels: parseStringArray(row.labels),
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    parentSessionId: row.parent_session_id,
    timeoutMs: row.timeout_ms ?? DEFAULT_TASK_TIMEOUT_MS,
    interventionReason: row.intervention_reason,
    interventionAt: row.intervention_at,
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
  /** Free-form labels (deduped + trimmed). The reserved labels
   *  `awaiting-intervention` / `stalled` / `draft` keep the task
   *  out of the pool's claim filter (see POOL_SKIP_LABELS). */
  labels?: string[];
  /** Session that asked for this task. Stamped on every row that
   *  was created from inside an LLM tool call so the worker pool
   *  can later notify it. */
  parentSessionId?: string | null;
  /** Optional override for the per-task watchdog budget. Bigger
   *  jobs (long research, full website generation) can ask for
   *  more time up front rather than relying on the main agent
   *  to extend on the fly. Falls back to DEFAULT_TASK_TIMEOUT_MS. */
  timeoutMs?: number | null;
}

function sanitiseLabels(input: string[] | undefined): string[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    out.add(trimmed);
  }
  return [...out];
}

const STATUS_VALUES = new Set<TaskStatus>([
  "ready",
  "in_progress",
  "done",
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
  const labels = sanitiseLabels(input.labels);
  const timeoutMs =
    typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
      ? Math.max(1000, Math.floor(input.timeoutMs))
      : DEFAULT_TASK_TIMEOUT_MS;
  db.prepare(
    `INSERT INTO tasks (
       id, project_slug, owner_user_id, worker_role, worker_agent_id,
       title, description, status, priority,
       result_summary, result_files, session_id, depends_on,
       failure_reason, attempts, labels,
       created_at, started_at, ended_at,
       parent_session_id, timeout_ms,
       intervention_reason, intervention_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, NULL, NULL, NULL, ?, NULL, 0, ?, ?, NULL, NULL, ?, ?, NULL, NULL)`,
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
    JSON.stringify(labels),
    now,
    input.parentSessionId ?? null,
    timeoutMs,
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
  /** Replace the labels list. Pass [] to clear. The pool's reserved
   *  labels (`awaiting-intervention`, `stalled`, `draft`) follow
   *  the same rules as everything else here — sanitised, deduped. */
  labels?: string[];
  startedAt?: number | null;
  endedAt?: number | null;
  /** Bump or shrink the watchdog budget. Used by
   *  `task_extend_timeout`. */
  timeoutMs?: number;
  /** Free-text reason; pass `null` to clear (used when reviving
   *  a task via task_continue / task_retry_fresh). */
  interventionReason?: string | null;
  interventionAt?: number | null;
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
  if (patch.labels !== undefined) {
    sets.push("labels = ?");
    params.push(JSON.stringify(sanitiseLabels(patch.labels)));
  }
  if (patch.startedAt !== undefined) {
    sets.push("started_at = ?");
    params.push(patch.startedAt);
  }
  if (patch.endedAt !== undefined) {
    sets.push("ended_at = ?");
    params.push(patch.endedAt);
  }
  if (patch.timeoutMs !== undefined) {
    sets.push("timeout_ms = ?");
    params.push(
      Number.isFinite(patch.timeoutMs)
        ? Math.max(1000, Math.floor(patch.timeoutMs))
        : DEFAULT_TASK_TIMEOUT_MS,
    );
  }
  if (patch.interventionReason !== undefined) {
    sets.push("intervention_reason = ?");
    params.push(patch.interventionReason);
  }
  if (patch.interventionAt !== undefined) {
    sets.push("intervention_at = ?");
    params.push(patch.interventionAt);
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
         AND status IN ('ready','in_progress','done')
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
        total: 0,
      };
      byProject.set(row.project_slug, entry);
    }
    if (row.status === "ready") entry.ready = row.count;
    else if (row.status === "in_progress") entry.inProgress = row.count;
    else if (row.status === "done") entry.done = row.count;
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

    // Claim atomically. The UPDATE has THREE jobs:
    //   1. flip status ready → in_progress
    //   2. stamp started_at + session_id + worker_agent_id so the
    //      board surfaces "who is doing what"
    //   3. enforce "one task in flight per worker" — the
    //      `NOT EXISTS` subclause refuses the claim if this
    //      worker (or, for an unpinned worker, any task this
    //      worker would consider its own) is already running
    //      another task. This is the source of truth; the pool's
    //      in-memory `busy` map is just an optimisation, and
    //      survives rebuild() / disable+enable cycles where the
    //      memory state could otherwise drift.
    //
    // The subquery uses the same agent-vs-role logic as the
    // SELECT above: with `agentId` set we check rows pinned to
    // this exact agent; without an agent we fall back to any
    // in_progress row matching this role.
    const claimSql = agentId
      ? `UPDATE tasks
           SET status = 'in_progress',
               started_at = ?,
               session_id = ?,
               worker_agent_id = ?
         WHERE id = ? AND status = 'ready'
           AND NOT EXISTS (
             SELECT 1 FROM tasks AS busy
             WHERE busy.status = 'in_progress'
               AND busy.worker_agent_id = ?
           )`
      : `UPDATE tasks
           SET status = 'in_progress',
               started_at = ?,
               session_id = ?
         WHERE id = ? AND status = 'ready'
           AND NOT EXISTS (
             SELECT 1 FROM tasks AS busy
             WHERE busy.status = 'in_progress'
               AND busy.worker_role = ?
               AND busy.worker_agent_id IS NULL
           )`;
    const result = (
      agentId
        ? db
            .prepare(claimSql)
            .run(now, sessionId, agentId, candidate.id, agentId)
        : db.prepare(claimSql).run(now, sessionId, candidate.id, role ?? "")
    ) as { changes: number };
    if (!result.changes) continue;

    return getTask(db, candidate.id);
  }
  return null;
}

/**
 * Whether the pool may claim this task right now.
 *
 * Three checks, all must pass:
 *   1. status === 'ready' — caller pre-filters but we double-check
 *      since `isEligible` is also called from the chat-side
 *      `task_create`/`task_update` tools to compute the
 *      "blocked" hint shown to the agent.
 *   2. labels don't include any pool-skip label (`stalled`,
 *      `draft`). These are the user's "don't pick this up yet"
 *      signal.
 *   3. every dependency is in status='done'. Missing rows count
 *      as unsatisfied — a deleted prerequisite doesn't
 *      auto-resolve. (Owner can re-point with task_update.)
 */
export function isEligible(db: TenantDbHandle, task: Task): boolean {
  if (task.status !== "ready") return false;
  if (task.labels.some((l) => POOL_SKIP_LABELS.includes(l))) return false;
  if (task.dependsOn.length === 0) return true;
  const placeholders = task.dependsOn.map(() => "?").join(",");
  const rows = db
    .prepare<unknown[], { id: string; status: string }>(
      `SELECT id, status FROM tasks WHERE id IN (${placeholders})`,
    )
    .all(...task.dependsOn);
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
