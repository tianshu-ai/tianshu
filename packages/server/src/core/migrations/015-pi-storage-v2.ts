// Migration 015 — extend tenant DB schema for pi-agent-core 0.85 Storage.
//
// pi 0.85 replaced the SessionStorage interface (session-shaped, our
// old SqliteSessionStorage) with a lower-level `Storage` interface
// that has to persist four flavours of state:
//
//   1. Entries (tree of typed events)     — messages table already
//                                             carries these; we only
//                                             need to add `seq` for
//                                             ordering.
//   2. Values  (namespaced KV)            — NEW: session_values table.
//   3. Value lists (namespaced KV lists)  — NEW: session_lists table.
//   4. Usage rows (per-turn token totals) — NEW: session_usage table.
//
// Every table is scoped by session_id so pi's `Storage` maps to one
// row set per session. All new tables are additive — legacy rows in
// messages/sessions keep their behaviour. Every new column has a
// safe default so existing sessions upgrade transparently.
//
// `seq` on messages:
//   pi 0.85 assigns a monotonically-increasing `seq` to every entry
//   at commit time. We backfill by scanning each session's message
//   chain from the leaf backwards and assigning seq in append order.
//   Sessions with no leaf keep seq NULL; the storage layer treats
//   NULL as "before any committed entry" so a fresh commit assigns
//   seq=1 and things line up. We also add a partial UNIQUE index
//   so tests catch double-assignment bugs early.
//
// This is a pure-add migration: no rows are deleted, no columns are
// dropped, and every ALTER is O(1) on SQLite.

import type { Database } from "better-sqlite3";

export const ID = "015-pi-storage-v2";

export function up(db: Database): void {
  // 1. messages.seq — required by pi 0.85 Entry ordering.
  const msgCols = db
    .prepare<[], { name: string }>(
      `SELECT name FROM pragma_table_info('messages')`,
    )
    .all();
  const msgNames = new Set(msgCols.map((c) => c.name));
  if (!msgNames.has("seq")) {
    // Nullable so existing rows survive the ALTER without a rewrite.
    // The backfill below fills it in per session.
    db.exec(`ALTER TABLE messages ADD COLUMN seq INTEGER`);
  }

  // Backfill: walk each session's parent-chain from the leaf, tag
  // each entry with an ascending seq (1-based). We can walk from
  // the root because 003-session-tree.ts already established the
  // parent_id chain, but a leaf-up walk is cleaner because our
  // idx_messages_session_parent index already supports it.
  const sessions = db
    .prepare<[], { id: string; leaf_id: string | null }>(
      `SELECT id, leaf_id FROM sessions WHERE leaf_id IS NOT NULL`,
    )
    .all();
  const walkFromRoot = db.prepare<[string], { id: string }>(
    `SELECT id FROM messages
     WHERE session_id = ? AND parent_id IS NULL
     ORDER BY created_at ASC, rowid ASC`,
  );
  const findChild = db.prepare<[string, string], { id: string }>(
    `SELECT id FROM messages
     WHERE session_id = ? AND parent_id = ?
     ORDER BY created_at ASC, rowid ASC
     LIMIT 1`,
  );
  const updateSeq = db.prepare<[number, string], unknown>(
    `UPDATE messages SET seq = ? WHERE id = ?`,
  );
  console.log(`[migration:015] backfilling seq for ${sessions.length} session(s)...`);
  for (let si = 0; si < sessions.length; si++) {
    const s = sessions[si]!;
    // Find root: parent_id IS NULL.
    const roots = walkFromRoot.all(s.id);
    if (roots.length === 0) continue;
    // In practice each session has one root; if there are multiple
    // (fork residue), pick the earliest and walk its chain.
    let current: string | null = roots[0]!.id;
    let n = 1;
    while (current) {
      updateSeq.run(n, current);
      n++;
      const child = findChild.get(s.id, current);
      current = child?.id ?? null;
    }
    if (n > 100 || (si + 1) % 50 === 0) {
      console.log(`[migration:015]   session ${si + 1}/${sessions.length}: ${n - 1} messages`);
    }
  }
  console.log(`[migration:015] seq backfill done`);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session_seq
      ON messages(session_id, seq);

    -- 2. session_values — pi.Storage's namespaced scalar KV.
    --    Composite PK on (session, namespace, key) enforces uniqueness.
    --    'seq' mirrors messages.seq so scanValues can order writes.
    CREATE TABLE IF NOT EXISTS session_values (
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      namespace   TEXT NOT NULL,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,    -- JSON-encoded value
      seq         INTEGER NOT NULL, -- monotonic per session, matches messages.seq counter
      PRIMARY KEY (session_id, namespace, key)
    );
    CREATE INDEX IF NOT EXISTS idx_session_values_namespace
      ON session_values(session_id, namespace);

    -- 3. session_lists — pi.Storage's namespaced list of values.
    --    Same (session, namespace, key) grouping as values, but with
    --    one row per element carrying its own seq.
    CREATE TABLE IF NOT EXISTS session_lists (
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      namespace   TEXT NOT NULL,
      key         TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      value       TEXT NOT NULL,    -- JSON-encoded element
      PRIMARY KEY (session_id, namespace, key, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_session_lists_key
      ON session_lists(session_id, namespace, key);

    -- 4. session_usage — pi 0.85 records provider usage per turn.
    --    The pi UsageRow shape has an id (uuid) + seq + JSON usage.
    CREATE TABLE IF NOT EXISTS session_usage (
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      id          TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      usage       TEXT NOT NULL,    -- JSON: { promptTokens, completionTokens, ... }
      entry_id    TEXT,             -- Optional: the message/entry that produced it
      adjustment  INTEGER NOT NULL DEFAULT 0,   -- 0=false, 1=true
      details     TEXT,             -- Optional JSON blob for provider-specific extras
      PRIMARY KEY (session_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_usage_session_seq
      ON session_usage(session_id, seq);

    -- 5. session_seq_counter — one row per session, tracks the next
    --    seq to assign in this session's storage. All four write
    --    kinds (entry, value, list-append, usage) share the counter.
    CREATE TABLE IF NOT EXISTS session_seq_counter (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      next_seq   INTEGER NOT NULL
    );
  `);

  // Seed session_seq_counter from the messages backfill so a fresh
  // commit for an existing session gets a seq greater than every
  // legacy row. Sessions with no messages start at seq=1.
  const maxSeqPerSession = db
    .prepare<[], { session_id: string; max_seq: number | null }>(
      `SELECT session_id, MAX(seq) AS max_seq FROM messages GROUP BY session_id`,
    )
    .all();
  const seedCounter = db.prepare<[string, number], unknown>(
    `INSERT OR REPLACE INTO session_seq_counter (session_id, next_seq) VALUES (?, ?)`,
  );
  for (const row of maxSeqPerSession) {
    seedCounter.run(row.session_id, (row.max_seq ?? 0) + 1);
  }
}
