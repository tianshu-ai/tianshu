// Migration 019 — rewrite turn_number to be chain-absolute.
//
// Migrations 017 + 018 computed turn_number per-session: each session
// started counting from 1 independently. Yu's invariant is stronger:
//
//   "Turn 1 = the first real message I ever sent in this channel,
//    regardless of how many sessions / compactions / forks sit
//    between that message and the current active session."
//
// Legacy compactSession (compact.ts) forks a new session each time
// it compacts, threading parent_id → old session. This migration
// groups sessions into fork chains (each chain rooted at a session
// with parent_id IS NULL), walks messages across the entire chain
// in chronological order, and assigns a single monotonic turn
// counter that spans every session in the chain.
//
// Non-forked sessions (the common case after pi 0.87+) have a chain
// of length 1 and their turn_number values don't change from 018.
//
// Safe to replay: turn_number is idempotent for a fixed prefix list
// and a fixed chain topology. Only rows whose value actually moves
// get written.

import type Database from "better-sqlite3";

export const ID = "019-turn-number-chain-absolute";

interface Row {
  id: string;
  session_id: string;
  role: string;
  content: string;
  entry_type: string;
  turn_number: number | null;
}

// Frozen prefix list — matches real-user-turn.ts as of this migration.
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
  // 1. Build chain groups. Each chain is identified by its root
  //    (parent_id IS NULL). Walk children → parent to find the root,
  //    then group sessions by root.
  const allSessions = db
    .prepare<[], { id: string; parent_id: string | null }>(
      `SELECT id, parent_id FROM sessions`,
    )
    .all();

  const parentMap = new Map<string, string | null>();
  for (const s of allSessions) parentMap.set(s.id, s.parent_id);

  function findRoot(id: string): string {
    let cur = id;
    let depth = 0;
    while (depth < 100) {
      const p = parentMap.get(cur);
      if (!p) return cur; // root
      cur = p;
      depth++;
    }
    return cur;
  }

  // Group by root → [session ids in chain, root-first order]
  const chainsByRoot = new Map<string, string[]>();
  for (const s of allSessions) {
    const root = findRoot(s.id);
    if (!chainsByRoot.has(root)) chainsByRoot.set(root, []);
    chainsByRoot.get(root)!.push(s.id);
  }

  // 2. For each chain, read ALL messages across every member session
  //    in chronological order, compute chain-absolute turn_number,
  //    and update rows that moved.
  const readRows = db.prepare<string[], Row>(
    // Dynamic placeholder count — built per chain below.
    // Placeholder query is re-prepared per chain for variable IN size.
    `SELECT 1`, // placeholder; actual query built per chain
  );
  void readRows; // unused; we prepare dynamically below

  const updateTurn = db.prepare<[number, string]>(
    `UPDATE messages SET turn_number = ? WHERE id = ?`,
  );

  const run = db.transaction(() => {
    for (const [, sessionIds] of chainsByRoot) {
      const placeholders = sessionIds.map(() => "?").join(",");
      const rows: Row[] = db
        .prepare<string[], Row>(
          `SELECT id, session_id, role, content, entry_type, turn_number
             FROM messages
            WHERE session_id IN (${placeholders})
            ORDER BY created_at, seq`,
        )
        .all(...sessionIds);

      let turn = 0;
      for (const row of rows) {
        if (isRealUserJson(row)) turn++;
        if (row.turn_number !== turn) {
          updateTurn.run(turn, row.id);
        }
      }
    }
  });
  run();
}
