// Migration 018 — rebuild turn_number to exclude legacy fork-seed rows.
//
// Motivation. Migration 017 back-filled turn_number using a
// self-contained SYSTEM_INJECTED_USER_PREFIXES list of only
// ["[plugin-system]", "[system note]"]. After 017 shipped we noticed
// legacy `compactSession` (compact.ts) seeds every forked session
// with a `role='user'` row whose first text chunk starts with
// `[Conversation summary — generated at <ISO>]\n\n...`. Those rows
// aren't real user turns — they're system-generated summaries that
// happen to have role='user' for the LLM's benefit — but 017's
// stricter rule counted them, so every forked session's `turn_number`
// is off by one (fork-seed sits at turn 1, real turn 1 sits at 2, etc).
//
// Fix in code: `real-user-turn.ts::SYSTEM_INJECTED_USER_PREFIXES`
// now includes the fork-seed prefix, so new rows and fresh sessions
// get the right turn from insert time. This migration re-scans every
// session and rewrites turn_number using the updated list. Only rows
// whose turn number would move (i.e. anything at or after a fork-seed
// row) get updated; rows in un-forked sessions stay untouched.
//
// Safe to replay: turn_number is idempotent for a fixed prefix list,
// and the list here is frozen (see the note on 017).

import type Database from "better-sqlite3";

export const ID = "018-turn-number-fork-seed";

interface Row {
  id: string;
  session_id: string;
  role: string;
  content: string;
  entry_type: string;
  turn_number: number | null;
}

// Frozen prefix list — the state of the world as of migration 018.
// If real-user-turn.ts grows another entry later, add another
// migration; do NOT append here.
const SYSTEM_INJECTED_USER_PREFIXES = [
  "[plugin-system]",
  "[system note]",
  "[Conversation summary — generated at",
];

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
  const sessions = db
    .prepare<[], { id: string }>(`SELECT id FROM sessions`)
    .all();

  const readRows = db.prepare<[string], Row>(
    `SELECT id, session_id, role, content, entry_type, turn_number
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
        // Only write when the value actually changes. Cheap check
        // against the row's stored turn_number keeps this migration
        // fast on the common case (un-forked sessions where 017 was
        // already correct).
        if (row.turn_number !== turn) {
          updateTurn.run(turn, row.id);
        }
      }
    }
  });
  run();
}
