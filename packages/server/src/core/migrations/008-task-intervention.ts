// Migration 008 — task intervention model.
//
// Replaces the auto-retry-up-to-MAX_ATTEMPTS loop with an
// "awaiting-intervention" model: any failure (worker error,
// stream tear, no_completion) parks the task in ready+
// awaiting-intervention label and asks the parent (main) agent
// what to do next. The pool no longer re-queues automatically.
//
// New columns on `tasks`:
//
//   timeout_ms          INTEGER NOT NULL DEFAULT 600000
//     Per-task budget. The worker pool starts a soft watchdog at
//     `started_at + timeout_ms`; on overrun it cancels the
//     worker run and routes to intervention. Main agent can
//     extend by calling task_extend_timeout. Default 10 minutes
//     matches the previous unspoken "if it hasn't finished by
//     now, something's wrong" behaviour.
//
//   intervention_reason TEXT
//     Free-text human-readable description of why the task is
//     awaiting intervention. Populated when the pool stamps the
//     `awaiting-intervention` label; cleared on a fresh claim.
//     Examples: "worker stream terminated mid tool call",
//     "worker timed out after 10m / extend or abort?",
//     "worker called task_complete with status=stalled".
//
//   intervention_at     INTEGER
//     ms timestamp the row entered the intervention state. Used
//     by the UI to surface "stuck for 5 min" badges and by the
//     pool to decide whether the row is fresh enough to retry
//     automatically (it never is — but having the timestamp lets
//     us add expiry policies later without another migration).
//
// All three columns are nullable / defaulted, so the migration
// is backwards-compatible: existing rows just get the defaults.
//
// We do NOT drop the `attempts` column. It's still useful as a
// read-only counter ("how many times has main agent reset this")
// and the pool still increments it on every fresh claim. The
// behaviour change is that `attempts >= MAX_ATTEMPTS` no longer
// triggers anything.

import type { Database } from "better-sqlite3";

export const ID = "008-task-intervention";

function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all();
  return cols.some((c) => c.name === column);
}

export function up(db: Database): void {
  if (!hasColumn(db, "tasks", "timeout_ms")) {
    db.exec(
      `ALTER TABLE tasks ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 600000`,
    );
  }
  if (!hasColumn(db, "tasks", "intervention_reason")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN intervention_reason TEXT`);
  }
  if (!hasColumn(db, "tasks", "intervention_at")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN intervention_at INTEGER`);
  }
}
