// Migration 004 — rebuild every session's message chain into a
// strict linked list ordered by (created_at ASC, rowid ASC).
//
// Why this exists: migration 003 set up the chain correctly for
// legacy rows, but the first cut of N+6.4 had a bug in
// SqliteSessionStorage.appendEntry that left `sessions.leaf_id`
// pointing at the previous turn's leaf for every new row — so all
// entries written between N+6.4 deploy and the leaf-id fix landed
// share the SAME parent (a fan-out), and `getPathToRoot` only
// walked the most recent branch.
//
// `getPathToRoot` had a splice fallback that papered over this for
// reads, but the fan stayed in the DB. Rather than carry the
// fallback forever, this migration rewrites every parent_id to
// point at the predecessor row in chronological order. This is
// safe for already-chained sessions (we just re-write the same
// values) and idempotent in practice — re-running on a chain that
// is already correct is a no-op.
//
// We also re-stamp `sessions.leaf_id` to the chronologically last
// row in case it drifted: pi's harness reads leaf_id at run-start,
// so an out-of-date pointer would make new turns parent off the
// wrong row.

import type { Database } from "better-sqlite3";

export const ID = "004-rebuild-message-chain";

export function up(db: Database): void {
  const sessions = db
    .prepare<[], { id: string }>(`SELECT id FROM sessions`)
    .all();
  const selectMsgs = db.prepare<[string], { id: string }>(
    `SELECT id FROM messages
     WHERE session_id = ?
     ORDER BY created_at ASC, rowid ASC`,
  );
  const updateParent = db.prepare<[string | null, string], unknown>(
    `UPDATE messages SET parent_id = ? WHERE id = ?`,
  );
  const updateLeaf = db.prepare<[string | null, string], unknown>(
    `UPDATE sessions SET leaf_id = ? WHERE id = ?`,
  );

  for (const s of sessions) {
    const ids = selectMsgs.all(s.id);
    if (ids.length === 0) {
      // Session had no messages — clear leaf_id if it was somehow
      // set, otherwise nothing to do.
      updateLeaf.run(null, s.id);
      continue;
    }
    let prev: string | null = null;
    for (const row of ids) {
      // First row gets parent_id=NULL; every subsequent row points
      // at the row immediately before it in chronological order.
      updateParent.run(prev, row.id);
      prev = row.id;
    }
    updateLeaf.run(prev, s.id);
  }
}
