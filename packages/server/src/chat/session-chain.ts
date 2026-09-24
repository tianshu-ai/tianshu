// Session fork-chain utilities.
//
// Legacy `compactSession` (compact.ts) forks a new session with
// `parent_id` pointing at the old one every time it compacts. The
// chain can be arbitrarily deep (one fork per compaction). New pi
// 0.87+ compaction writes a compaction entry into the same session
// — no fork — so new chains won't grow, but existing ones stay.
//
// The single invariant these helpers enforce:
//
//   Turn 1 = the first real user message ever sent in this channel
//   conversation, regardless of how many sessions / compactions /
//   forks sit between that message and the current active session.
//
// To satisfy that, turn_number must be **chain-absolute**: the root
// session (parent_id IS NULL) owns turns 1..K, and every fork that
// follows continues from K+1. resolveSessionChain + chainMaxTurn
// give callers the primitives to compute and query that.

import type { Database } from "better-sqlite3";

/**
 * Walk parent_id from `sessionId` up to the chain root (parent_id
 * IS NULL). Returns session ids in root-first order:
 * `[rootId, ..., sessionId]`.
 *
 * Cheap: one SELECT per hop; chains are shallow (typically 1-3).
 * Guards against cycles with a hard cap of 100 hops.
 */
export function resolveSessionChain(
  db: Database,
  sessionId: string,
): string[] {
  const chain: string[] = [];
  let current: string | null = sessionId;
  const MAX_DEPTH = 100;
  while (current && chain.length < MAX_DEPTH) {
    chain.push(current);
    const row = db
      .prepare<[string], { parent_id: string | null } | undefined>(
        `SELECT parent_id FROM sessions WHERE id = ?`,
      )
      .get(current);
    current = row?.parent_id ?? null;
  }
  // chain is [sessionId, parentId, grandparentId, ..., rootId].
  // Reverse to root-first order.
  chain.reverse();
  return chain;
}

/**
 * Return the maximum turn_number across the entire fork chain ending
 * at `sessionId`. Used by the storage insert path to continue the
 * chain-absolute counter when writing to a newly-forked session.
 *
 * Returns 0 when no turn_number exists yet (fresh chain).
 */
export function chainMaxTurn(
  db: Database,
  sessionId: string,
): number {
  const chain = resolveSessionChain(db, sessionId);
  if (chain.length === 0) return 0;
  // Single query over all sessions in the chain. The
  // idx_messages_session_turn index makes per-session MAX fast;
  // SQLite handles the IN(...) by probing the index per value.
  const placeholders = chain.map(() => "?").join(",");
  const row = db
    .prepare<string[], { max_turn: number | null }>(
      `SELECT MAX(turn_number) AS max_turn FROM messages
        WHERE session_id IN (${placeholders})`,
    )
    .get(...chain);
  return row?.max_turn ?? 0;
}
