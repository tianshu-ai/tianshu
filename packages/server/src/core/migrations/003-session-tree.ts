// Migration 003 — extend sessions/messages so they can back
// pi-agent-core's `SessionStorage` interface.
//
// pi-agent-core models a session as a tree of typed entries:
//   message / compaction / thinking_level_change / model_change /
//   active_tools_change / label / session_name / custom / leaf / ...
//
// Our existing `messages` table only stored chat messages (and the
// `sessions.compacted_summary` column captured compaction
// out-of-band). To plug into pi's harness, we widen `messages`
// into a generic entry log:
//
//   * `entry_type`  — defaults to 'message' for legacy rows so the
//                     existing chat handler keeps reading them as
//                     plain messages.
//   * `entry_details` — JSON string for non-message entry payloads
//                     (e.g. compaction summary text + tokensBefore,
//                     or a label string). For role='assistant'/
//                     'user'/'tool' rows it stays NULL because the
//                     existing `content` column already carries
//                     the JSON.
//   * `parent_id` (on messages) — pi's session-tree fork/branch
//                     model: each entry references the entry it
//                     was appended after. Optional / nullable so
//                     existing rows don't need backfilling beyond
//                     a one-shot UPDATE that points each message
//                     at its predecessor in (session_id,
//                     created_at) order. Walking the chain
//                     reconstructs pi's tree.
//
// We also add `sessions.leaf_id` so the harness can record the
// active leaf without us having to scan messages every time.
//
// All columns are nullable so the migration is a pure add (no
// REWRITE OF EXISTING ROWS, no FK changes); SQLite ALTER TABLE
// can handle this in O(1).

import type { Database } from "better-sqlite3";

export const ID = "003-session-tree";

export function up(db: Database): void {
  // sessions.leaf_id — references messages(id) but NULL until the
  // first append happens after the migration.
  const sessionCols = db
    .prepare<[], { name: string }>(
      `SELECT name FROM pragma_table_info('sessions')`,
    )
    .all();
  const sessionNames = new Set(sessionCols.map((c) => c.name));
  if (!sessionNames.has("leaf_id")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN leaf_id TEXT`);
  }

  // messages.entry_type — default 'message' for legacy rows so the
  // chat handler's existing reads keep working unchanged.
  const msgCols = db
    .prepare<[], { name: string }>(
      `SELECT name FROM pragma_table_info('messages')`,
    )
    .all();
  const msgNames = new Set(msgCols.map((c) => c.name));
  if (!msgNames.has("entry_type")) {
    db.exec(`ALTER TABLE messages ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'message'`);
  }
  if (!msgNames.has("entry_details")) {
    db.exec(`ALTER TABLE messages ADD COLUMN entry_details TEXT`);
  }
  if (!msgNames.has("parent_id")) {
    db.exec(`ALTER TABLE messages ADD COLUMN parent_id TEXT`);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session_parent
      ON messages(session_id, parent_id);
    CREATE INDEX IF NOT EXISTS idx_messages_entry_type
      ON messages(session_id, entry_type);
  `);

  // Backfill parent_id for legacy rows so a session's leaf chain
  // forms a proper linked list. We walk each session's messages in
  // (created_at ASC, rowid ASC) order, threading parent_id from
  // the previous row's id. We also stamp sessions.leaf_id to the
  // last row so the harness can navigate without rescanning.
  const sessions = db
    .prepare<[], { id: string; leaf_id: string | null }>(
      `SELECT id, leaf_id FROM sessions`,
    )
    .all();
  const selectMsgs = db.prepare<[string], { id: string }>(
    `SELECT id FROM messages
     WHERE session_id = ? AND parent_id IS NULL
     ORDER BY created_at ASC, rowid ASC`,
  );
  const updateParent = db.prepare<[string, string], unknown>(
    `UPDATE messages SET parent_id = ? WHERE id = ?`,
  );
  const updateLeaf = db.prepare<[string, string], unknown>(
    `UPDATE sessions SET leaf_id = ? WHERE id = ?`,
  );
  for (const s of sessions) {
    if (s.leaf_id) continue;
    const ids = selectMsgs.all(s.id);
    let prev: string | null = null;
    for (const row of ids) {
      if (prev) updateParent.run(prev, row.id);
      prev = row.id;
    }
    if (prev) updateLeaf.run(prev, s.id);
  }
}
