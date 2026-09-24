// Migration 016 — rewrite pi-0.85-era `role='toolResult'` rows to `role='tool'`.
//
// Symptom: after upgrading to pi 0.85 the tool chips in the browser
// transcript stayed stuck at "running…" for every session loaded from
// history. Live turns were fine — the chip flipped to done as soon
// as the assistant reply finished — but a page refresh reverted them
// all to running.
//
// Root cause: pi 0.85's SqliteStorage.entryToRow wrote the tool-
// result rows using entry.message.role verbatim ("toolResult" from
// pi-ai's ToolResultMessage). Tianshu's schema and the browser
// (mergeToolTurns.ts) use `role === "tool"` for the column. Old
// SqliteSessionStorage.parseMessage happened to normalize the column
// value on write — the new SqliteStorage skipped that normalisation.
//
// Fix in code: entryToRow now maps `toolResult` → `tool` before
// INSERT (see packages/server/src/chat/sqlite-storage.ts). This
// migration back-fills the same normalisation for rows that were
// already written under the old (wrong) column value. Pure metadata
// update — `content` (the full pi-ai message JSON, including the
// original `role: "toolResult"`) stays untouched, so re-hydration
// via parseMessage/toWire remains correct.

import type Database from "better-sqlite3";

export const ID = "016-toolresult-to-tool";

export function up(db: Database.Database): void {
  db.exec(`
    UPDATE messages
       SET role = 'tool'
     WHERE role = 'toolResult'
       AND entry_type = 'message';
  `);
}
