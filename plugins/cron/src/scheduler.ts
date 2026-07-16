// Cron plugin — data layer.
//
// Ported from the old (closed-source) Tianshu scheduler, adapted to
// the new plugin architecture:
//   - The table lives in the tenant's shared SQLite handle (`ctx.db`),
//     which is already per-tenant (physical multi-tenancy), so no
//     tenant_id column / WHERE is needed the way the old single-DB
//     row-level design required.
//   - Next-run computation uses `croner` instead of the old hand-rolled
//     minute-by-minute matcher: correct timezone/DST handling + proper
//     cron syntax, zero-dependency, ESM.
//
// A job either runs `once` (absolute `run_at` ms) or on a `cron`
// schedule (`cron_expr` + `tz`). On each fire the loop recomputes
// `next_run` (cron) or clears it (once, so it never runs again).

import { Cron } from "croner";

/** A better-sqlite3-shaped handle. Structurally compatible with the
 *  SDK's `TenantDbHandle` (whose `run` returns `unknown`), so
 *  `ctx.db` can be passed straight in. The subset we use guarantees
 *  a `{ changes }` object at runtime (better-sqlite3); the two call
 *  sites that need it (`updateJob` / `deleteJob`) narrow locally. */
export interface Db {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

/** Runtime shape of better-sqlite3's `run()` result. */
interface RunResult {
  changes: number;
}

export type ScheduledActionType = "message" | "task";
export type ScheduleType = "once" | "cron";

export interface ScheduledJob {
  id: string;
  title: string;
  scheduleType: ScheduleType;
  cronExpr: string | null;
  /** IANA timezone for the cron expr (e.g. "Asia/Shanghai"). null =
   *  host local time. */
  tz: string | null;
  runAt: number | null;
  actionType: ScheduledActionType;
  payload: Record<string, unknown>;
  enabled: boolean;
  lastRun: number | null;
  nextRun: number | null;
  createdAt: number;
  updatedAt: number;
}

const SELECT_COLS = `
  id, title,
  schedule_type as scheduleType, cron_expr as cronExpr, tz,
  run_at as runAt, action_type as actionType, payload,
  enabled, last_run as lastRun, next_run as nextRun,
  created_at as createdAt, updated_at as updatedAt
`;

export function ensureSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      schedule_type TEXT NOT NULL DEFAULT 'once',
      cron_expr     TEXT,
      tz            TEXT,
      run_at        INTEGER,
      action_type   TEXT NOT NULL DEFAULT 'message',
      payload       TEXT NOT NULL DEFAULT '{}',
      enabled       INTEGER NOT NULL DEFAULT 1,
      last_run      INTEGER,
      next_run      INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cron_jobs_next ON cron_jobs(next_run);
  `);
}

function rowToJob(r: Record<string, unknown>): ScheduledJob {
  return {
    id: String(r.id),
    title: String(r.title),
    scheduleType: r.scheduleType as ScheduleType,
    cronExpr: (r.cronExpr as string | null) ?? null,
    tz: (r.tz as string | null) ?? null,
    runAt: (r.runAt as number | null) ?? null,
    actionType: r.actionType as ScheduledActionType,
    payload: safeParse(r.payload as string),
    enabled: !!r.enabled,
    lastRun: (r.lastRun as number | null) ?? null,
    nextRun: (r.nextRun as number | null) ?? null,
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
  };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

/**
 * Compute the next fire time (ms) at or after `after` for a cron
 * expression, in the given IANA timezone. Returns null when the
 * expression never fires again or is invalid.
 */
export function computeNextCron(
  expr: string,
  after: number,
  tz?: string | null,
): number | null {
  try {
    const c = new Cron(expr, tz ? { timezone: tz } : {});
    const next = c.nextRun(new Date(after));
    return next ? next.getTime() : null;
  } catch {
    return null;
  }
}

/** Validate a cron expression (used by the tool before persisting). */
export function isValidCron(expr: string, tz?: string | null): boolean {
  try {
    const c = new Cron(expr, tz ? { timezone: tz } : {});
    return c.nextRun() != null;
  } catch {
    return false;
  }
}

let idCounter = 0;
function newId(): string {
  idCounter = (idCounter + 1) % 1e6;
  return `job-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export function createJob(
  db: Db,
  opts: {
    title: string;
    scheduleType: ScheduleType;
    cronExpr?: string | null;
    tz?: string | null;
    runAt?: number | null;
    actionType: ScheduledActionType;
    payload: Record<string, unknown>;
  },
): ScheduledJob {
  const id = newId();
  const now = Date.now();
  const nextRun =
    opts.scheduleType === "once"
      ? (opts.runAt ?? null)
      : computeNextCron(opts.cronExpr ?? "", now, opts.tz);

  db.prepare(
    `INSERT INTO cron_jobs
       (id, title, schedule_type, cron_expr, tz, run_at, action_type, payload, enabled, next_run, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    id,
    opts.title,
    opts.scheduleType,
    opts.cronExpr ?? null,
    opts.tz ?? null,
    opts.runAt ?? null,
    opts.actionType,
    JSON.stringify(opts.payload ?? {}),
    nextRun,
    now,
    now,
  );

  return {
    id,
    title: opts.title,
    scheduleType: opts.scheduleType,
    cronExpr: opts.cronExpr ?? null,
    tz: opts.tz ?? null,
    runAt: opts.runAt ?? null,
    actionType: opts.actionType,
    payload: opts.payload ?? {},
    enabled: true,
    lastRun: null,
    nextRun,
    createdAt: now,
    updatedAt: now,
  };
}

export function listJobs(db: Db): ScheduledJob[] {
  const rows = db
    .prepare(`SELECT ${SELECT_COLS} FROM cron_jobs ORDER BY next_run ASC`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToJob);
}

export function getJob(db: Db, id: string): ScheduledJob | undefined {
  const r = db
    .prepare(`SELECT ${SELECT_COLS} FROM cron_jobs WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return r ? rowToJob(r) : undefined;
}

export function updateJob(
  db: Db,
  id: string,
  updates: Partial<
    Pick<
      ScheduledJob,
      | "title"
      | "cronExpr"
      | "tz"
      | "runAt"
      | "actionType"
      | "payload"
      | "enabled"
    >
  >,
): boolean {
  const fields: string[] = [];
  const values: unknown[] = [];
  const set = (col: string, v: unknown) => {
    fields.push(`${col} = ?`);
    values.push(v);
  };
  if (updates.title !== undefined) set("title", updates.title);
  if (updates.cronExpr !== undefined) set("cron_expr", updates.cronExpr);
  if (updates.tz !== undefined) set("tz", updates.tz);
  if (updates.runAt !== undefined) set("run_at", updates.runAt);
  if (updates.actionType !== undefined) set("action_type", updates.actionType);
  if (updates.payload !== undefined)
    set("payload", JSON.stringify(updates.payload));
  if (updates.enabled !== undefined) set("enabled", updates.enabled ? 1 : 0);
  if (fields.length === 0) return false;

  // Recompute next_run when the schedule shape changed.
  const cur = getJob(db, id);
  if (!cur) return false;
  const nextExpr = updates.cronExpr !== undefined ? updates.cronExpr : cur.cronExpr;
  const nextTz = updates.tz !== undefined ? updates.tz : cur.tz;
  const nextRunAt = updates.runAt !== undefined ? updates.runAt : cur.runAt;
  if (
    updates.cronExpr !== undefined ||
    updates.tz !== undefined ||
    updates.runAt !== undefined
  ) {
    const nextRun =
      cur.scheduleType === "cron"
        ? computeNextCron(nextExpr ?? "", Date.now(), nextTz)
        : (nextRunAt ?? null);
    set("next_run", nextRun);
  }

  set("updated_at", Date.now());
  values.push(id);
  const res = db
    .prepare(`UPDATE cron_jobs SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values) as RunResult;
  return res.changes > 0;
}

export function deleteJob(db: Db, id: string): boolean {
  const res = db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id) as RunResult;
  return res.changes > 0;
}

/**
 * Jobs that are due to run at `now`. The `created_at < now - 30s`
 * guard mirrors the old scheduler: it stops a job from firing in the
 * same tick it was created (e.g. a "once, delay 0" or a cron whose
 * first slot is this very minute).
 */
export function getDueJobs(db: Db, now: number): ScheduledJob[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM cron_jobs
       WHERE enabled = 1 AND next_run IS NOT NULL
         AND next_run <= ? AND created_at < ?`,
    )
    .all(now, now - 30_000) as Record<string, unknown>[];
  return rows.map(rowToJob);
}

export function markJobRun(
  db: Db,
  id: string,
  now: number,
  nextRun: number | null,
): void {
  db.prepare(
    `UPDATE cron_jobs SET last_run = ?, next_run = ?, updated_at = ? WHERE id = ?`,
  ).run(now, nextRun, now, id);
}
