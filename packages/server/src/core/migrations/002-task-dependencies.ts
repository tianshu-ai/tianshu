// Adds `tasks.depends_on` (JSON array of task ids) so the workboard
// plugin can model "task B is blocked until task A is done".
//
// Why a separate migration instead of folding into 001: the v0
// migration is already public — appending here keeps the historical
// record clean (anyone who set up a tenant on day-0 just runs 002 on
// the next boot). New tenants run both at once, same end state.
//
// The column is NOT NULL with a JSON-encoded empty array as default
// so the workboard read path can assume `JSON.parse(row.depends_on)`
// always succeeds.

import type { Database } from "better-sqlite3";

export const ID = "002-task-dependencies";

export function up(db: Database): void {
  // SQLite has no native JSON type, but the JSON1 extension treats
  // TEXT columns as JSON when used with json_*() functions. We don't
  // need that here — the workboard parses the column in JS — but the
  // shape mirrors `result_files` (also TEXT JSON-array, set in 001).
  db.exec(
    `ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'`,
  );
}
