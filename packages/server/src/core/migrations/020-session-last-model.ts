// Migration 020 — session last_model_id.
//
// Persist the model the user last selected for each session so the
// idle-runner (background inbox turns) can use the same model instead
// of falling back to the tenant default. Without this, a notification
// response on a session whose user picked e.g. kimi-for-coding would
// silently use qwen3.8-max (the tenant default) and fail if that
// key is expired — while the user's chosen model works fine.

import type { Database } from "better-sqlite3";

export const ID = "020-session-last-model";

export function up(db: Database): void {
  db.exec(`
    ALTER TABLE sessions ADD COLUMN last_model_id TEXT DEFAULT NULL;
  `);
}
