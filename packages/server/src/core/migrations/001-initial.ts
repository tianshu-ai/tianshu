// v0 schema for a per-tenant SQLite database.
//
// This is the schema PR #20 lays down. It deliberately includes columns
// that are not yet read or written by any feature code (workers,
// session.kind/worker_role/project_slug/parent_id) — see ADR-0001 §6 and
// ADR-0002 §5/§6. Putting them here at v0 means future PRs can wire
// behaviour without DB migrations on every step.

import type { Database } from "better-sqlite3";

export const ID = "001-initial";

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE users (
      id           TEXT PRIMARY KEY,
      external_id  TEXT NOT NULL,
      provider     TEXT NOT NULL,
      display_name TEXT,
      created_at   INTEGER NOT NULL,
      UNIQUE(provider, external_id)
    );

    CREATE TABLE sessions (
      id                TEXT PRIMARY KEY,
      user_id           TEXT NOT NULL REFERENCES users(id),
      parent_id         TEXT REFERENCES sessions(id),
      status            TEXT NOT NULL,                       -- active|compacted|archived
      kind              TEXT NOT NULL DEFAULT 'user',        -- user|worker|system
      worker_role       TEXT,                                -- e.g. 'qianliyan'; null for kind='user'
      title             TEXT,
      project_slug      TEXT,
      compacted_summary TEXT,
      created_at        INTEGER NOT NULL,
      ended_at          INTEGER
    );
    CREATE INDEX idx_sessions_user_active ON sessions(user_id, status);
    CREATE INDEX idx_sessions_user_kind   ON sessions(user_id, kind);

    CREATE TABLE messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      role        TEXT NOT NULL,                             -- user|assistant|tool|system
      content     TEXT NOT NULL,                             -- JSON
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX idx_messages_session_time ON messages(session_id, created_at);

    CREATE TABLE tasks (
      id              TEXT PRIMARY KEY,
      project_slug    TEXT NOT NULL,
      owner_user_id   TEXT NOT NULL REFERENCES users(id),
      worker_role     TEXT,
      title           TEXT NOT NULL,
      description     TEXT,
      status          TEXT NOT NULL,                          -- todo|in_progress|done|stalled|aborted
      priority        INTEGER NOT NULL DEFAULT 0,
      result_summary  TEXT,
      result_files    TEXT,                                   -- JSON array of /workspace paths
      session_id      TEXT REFERENCES sessions(id),
      created_at      INTEGER NOT NULL,
      started_at      INTEGER,
      ended_at        INTEGER
    );
    CREATE INDEX idx_tasks_status_priority ON tasks(status, priority DESC);
    CREATE INDEX idx_tasks_project         ON tasks(project_slug);
    CREATE INDEX idx_tasks_owner           ON tasks(owner_user_id);
  `);
}
