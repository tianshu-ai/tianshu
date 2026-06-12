// Migration 007 — session inbox + tasks.parent_session_id.
//
// Why we need this:
//   When a chat session calls `task_create` to delegate work to a
//   worker, the resulting kanban task has, until now, no link
//   back to *which* session asked for it. So when the worker
//   finishes (done) or fails (stalled), nobody can tell the
//   asking agent — the agent has to keep polling task_get_history
//   to find out.
//
//   Yu wants the OpenClaw model: when the worker terminates, drop
//   a message into the parent session's inbox. If that session
//   currently has an active turn running, the inbox dispatcher
//   forwards the message to `harness.followUp(...)`; if the
//   session is idle, the message sits in the inbox until the next
//   user turn flushes it as a system-note prefix.
//
// Schema:
//   tasks.parent_session_id  TEXT NULL
//     The session that asked for the task. NULL for tasks created
//     outside a chat session (kanban UI add button, REST API).
//
//   session_inbox
//     id                  TEXT  PRIMARY KEY
//     target_session_id   TEXT  NOT NULL
//     payload             TEXT  NOT NULL  (JSON; { kind, text, ...meta })
//     status              TEXT  NOT NULL  ('pending' | 'delivered')
//     created_at          INTEGER NOT NULL
//     delivered_at        INTEGER NULL
//
//   Index on (target_session_id, status, created_at) so the
//   pending-flush query (drainPending) is a single index seek.
//
// Idempotent: column / table presence is checked before the DDL.

import type { Database } from "better-sqlite3";

export const ID = "007-session-inbox";

function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all();
  return cols.some((c) => c.name === column);
}

function hasTable(db: Database, name: string): boolean {
  const row = db
    .prepare<[string], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    )
    .get(name);
  return Boolean(row);
}

export function up(db: Database): void {
  if (!hasColumn(db, "tasks", "parent_session_id")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN parent_session_id TEXT`);
  }

  if (!hasTable(db, "session_inbox")) {
    db.exec(`
      CREATE TABLE session_inbox (
        id                TEXT PRIMARY KEY,
        target_session_id TEXT NOT NULL,
        payload           TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'pending',
        created_at        INTEGER NOT NULL,
        delivered_at      INTEGER
      );
      CREATE INDEX idx_session_inbox_pending
        ON session_inbox(target_session_id, status, created_at);
    `);
  }
}
