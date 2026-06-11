// Migration 006 — turn the `stalled` task STATUS into a `stalled` LABEL.
//
// 005 made `stalled` the final-failure column. Yu cross-checked
// against the closed-source predecessor and pointed out it gets
// the model wrong: there, `stalled` (and `draft`, and short-term
// `failed`) are TAGS on otherwise-normal tasks, not separate
// columns. The kanban only ever shows ready/in-progress/done; a
// failed task lives in `ready` with a `stalled` label, and the
// scheduler skips ready+stalled rows when picking work.
//
// Why this matters: a 4th column ("Stalled") is hidden behind a
// toggle, so failed tasks vanish from the user's mental
// kanban. With a label, the failure stays visible in the same
// place the task already lives — UI can paint a ⚠️ badge.
//
// Schema:
//   - tasks.labels TEXT NOT NULL DEFAULT '[]'  (JSON array of strings)
//   - existing rows with status='stalled' → status='ready' + labels=['stalled']
//
// Idempotent. The column-presence check guards re-runs.

import type { Database } from "better-sqlite3";

export const ID = "006-task-labels";

function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all();
  return cols.some((c) => c.name === column);
}

export function up(db: Database): void {
  if (!hasColumn(db, "tasks", "labels")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'`);
  }

  // Existing stalled rows become ready+labels=['stalled']. Note we
  // overwrite labels rather than append because before this migration
  // the column didn't exist (default ''[]'' applied per row); a
  // user-stamped label would have been impossible.
  db.exec(`
    UPDATE tasks
       SET labels = '["stalled"]',
           status = 'ready'
     WHERE status = 'stalled';
  `);
}
