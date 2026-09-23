// Migration 014 — index for recursive CTE chain walk.
//
// `getPathToRoot` now uses a recursive CTE that walks the
// parent_id chain from leaf to root:
//
//   WITH RECURSIVE ancestors AS (
//     SELECT ... FROM messages WHERE session_id = ? AND id = ?
//     UNION ALL
//     SELECT ... FROM messages m JOIN ancestors a ON m.id = a.parent_id ...
//   )
//
// The CTE join (`m.id = a.parent_id WHERE m.session_id = ?`)
// needs an efficient lookup by (session_id, id). The existing
// PRIMARY KEY on `id` is a TEXT PK — SQLite's rowid alias doesn't
// apply, so the PK lookup is a B-tree scan on `id` alone.
// Adding a composite index lets the CTE walk in O(branch_length)
// with a single index probe per step.

import type { Database } from "better-sqlite3";

export const ID = "014-message-chain-walk-index";

export function up(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_sid_id
      ON messages(session_id, id);
  `);
}
