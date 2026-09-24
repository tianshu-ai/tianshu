// Migration 017 — add `turn_number` to messages.
//
// Motivation. pi 0.85+'s branch-based compaction rewrites session
// history: after compaction, the model context is a summary + the
// retained tail, and the pre-compaction turns live only in the DB.
// The `recall_range(from_turn, to_turn)` host tool lets the agent
// pull those originals back — but for that to work the model needs
// stable, session-absolute turn numbers.
//
// Turn numbering rules (invariant).
//   1. Turn 1 starts at the session's first "real user JSON" row
//      (see isRealUserJson in sqlite-storage.ts; this excludes
//      plugin-notice / recovery-injected plain-text stubs written
//      under role='user').
//   2. Each subsequent real user JSON bumps the counter by one.
//   3. Every other entry (assistant / tool / compaction /
//      branch_summary / custom / plugin-notice) inherits the
//      current turn — i.e. the max turn_number already seen in
//      the session. Session-leading non-user entries get turn 0.
//   4. turn_number is session-absolute and immutable. It NEVER
//      changes as a result of compaction, branching, navigation,
//      or any later mutation. New branches share their ancestors'
//      turn numbers.
//
// Back-fill. Walk every session's messages in (created_at, seq)
// order and apply the same rules to every existing row. The scan
// is one pass per session; recall_range's existing walk already
// tolerates the full-session read, so the cost is comparable to
// a single recall call per session at migration time.

import type Database from "better-sqlite3";

export const ID = "017-turn-number";

interface Row {
  id: string;
  session_id: string;
  role: string;
  content: string;
  entry_type: string;
}

// Prefixes that mark a role='user' row as tianshu-injected system
// content rather than a real user turn. Kept inline (not imported
// from ../../chat/real-user-turn.js) because migrations must be
// self-contained — dropping a runtime dependency on chat/ keeps
// the migration replayable even if that module later refactors.
//
// If you add a new SYSTEM_INJECTED_USER_PREFIXES entry in
// real-user-turn.ts and want it retroactively applied to existing
// rows, add a follow-up migration that re-scans this same predicate
// with the updated list; do NOT edit this migration in place.
const SYSTEM_INJECTED_USER_PREFIXES = ["[plugin-system]", "[system note]"];

function firstTextOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const p of content) {
      if (
        p &&
        typeof p === "object" &&
        "type" in p &&
        (p as { type: string }).type === "text"
      ) {
        const t = (p as { text?: unknown }).text;
        if (typeof t === "string") return t;
      }
    }
  }
  return null;
}

function isRealUserJson(row: Row): boolean {
  if (row.entry_type !== "message") return false;
  if (row.role !== "user") return false;
  let j: { role?: unknown; content?: unknown };
  try {
    j = JSON.parse(row.content);
  } catch {
    return false;
  }
  if (!j || typeof j !== "object" || j.role !== "user") return false;
  const firstText = firstTextOf(j.content);
  if (firstText === null) return true;
  const head = firstText.trimStart();
  for (const prefix of SYSTEM_INJECTED_USER_PREFIXES) {
    if (head.startsWith(prefix)) return false;
  }
  return true;
}

export function up(db: Database.Database): void {
  // 1. Add the column (nullable so back-fill can proceed row-by-row).
  db.exec(`
    ALTER TABLE messages ADD COLUMN turn_number INTEGER;
    CREATE INDEX IF NOT EXISTS idx_messages_session_turn
      ON messages(session_id, turn_number);
  `);

  // 2. Back-fill in one transaction. Walk each session's rows in
  //    creation order; count real user JSON rows to derive turn.
  const sessions = db
    .prepare<[], { id: string }>(`SELECT id FROM sessions`)
    .all();

  const readRows = db.prepare<[string], Row>(
    `SELECT id, session_id, role, content, entry_type
       FROM messages
      WHERE session_id = ?
      ORDER BY created_at, seq`,
  );
  const updateTurn = db.prepare<[number, string]>(
    `UPDATE messages SET turn_number = ? WHERE id = ?`,
  );

  const run = db.transaction(() => {
    for (const s of sessions) {
      let turn = 0;
      for (const row of readRows.all(s.id)) {
        if (isRealUserJson(row)) turn++;
        updateTurn.run(turn, row.id);
      }
    }
  });
  run();
}
