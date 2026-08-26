// Migration 013 — user preferences table.
//
// Key-value store for per-user UI state that should persist across
// sessions/page reloads: selected board, panel positions, etc.
// Plugins write via a shared route; the key namespace is prefixed
// by plugin id (e.g. "board.selectedBoard", "wiki.lastTab").

import type { Database } from "better-sqlite3";

export const ID = "013-user-preferences";

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT NOT NULL,
      key     TEXT NOT NULL,
      value   TEXT,
      PRIMARY KEY (user_id, key)
    );
  `);
}
