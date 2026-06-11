// Migration 005 — rename `todo` → `ready`, fold `aborted` into
// `ready`, add `failure_reason` + `attempts` columns for the retry
// loop.
//
// Why:
//   - "todo" is what humans put on a kanban; this board feeds a
//     worker pool, so "ready" (ready-to-claim) is the accurate
//     semantics. Matches the design used by the closed-source
//     predecessor.
//   - "aborted" was a separate persistent state that we never
//     showed by default (UI archived it). After the
//     agent-frameworks-research run we found agents can
//     legitimately abort mid-flight (timeout, external cancel) —
//     the right action is to put the task back in the queue with
//     a failure note, not bury it.
//   - "stalled" survives, but only as the FINAL graveyard for
//     tasks that have failed `MAX_ATTEMPTS` times. Worker pool
//     puts a fresh failure back to `ready` and bumps `attempts`.
//
// `failure_reason` carries the last error string so the UI can
// render a "⚠️ failed N times: <reason>" badge on the card.
//
// Idempotent: re-running on already-migrated data is a no-op
// because the UPDATEs target only the obsolete status values and
// the ALTER TABLE adds use IF NOT EXISTS semantics via a column
// presence check.

import type { Database } from "better-sqlite3";

export const ID = "005-task-status-rename";

function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all();
  return cols.some((c) => c.name === column);
}

export function up(db: Database): void {
  // 1. Add new columns if they don't exist yet.
  if (!hasColumn(db, "tasks", "failure_reason")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN failure_reason TEXT`);
  }
  if (!hasColumn(db, "tasks", "attempts")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`);
  }

  // 2. Rename status values. `aborted` rows had no useful
  //    information beyond "the worker bailed", so we fold them
  //    into `ready` with a failure_reason so the user can see
  //    what happened. Tasks already at status='aborted' usually
  //    have a `result_summary` containing the abort reason; copy
  //    it across.
  db.exec(`
    UPDATE tasks
       SET status = 'ready'
     WHERE status = 'todo';
  `);
  db.exec(`
    UPDATE tasks
       SET status = 'ready',
           failure_reason = COALESCE(failure_reason, result_summary)
     WHERE status = 'aborted';
  `);

  // 3. NB: the index on `status` (idx_tasks_status_priority)
  //    keeps working unchanged — SQLite stores text values
  //    directly in the index, no rebuild needed when a few rows
  //    change.
}
