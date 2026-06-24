// Migration 009 — record the app version each session was created
// under, so the boot-time tool-delta detector can tell the agent
// "you started this conversation in 0.3.20; we are on 0.3.21 now;
// these tools showed up in the gap."
//
// New column on `sessions`:
//
//   created_under_app_version  TEXT
//     The host's `package.json/version` at the time the session
//     was first opened (or, for sessions that pre-date this
//     migration, NULL). The boot-time detector compares this
//     value against each builtin tool's `manifest.tools[].since`
//     to compute the set of newly-available tools and pushes a
//     synthetic system note into the session inbox. After the
//     note is sent, the column is bumped to the current host
//     version so the same notification doesn't fire twice across
//     successive restarts on the same version.
//
//     v0 semantics: this is the *tianshu* app version (the
//     monorepo's `package.json/version`). v1 marketplace target:
//     re-interpret per-plugin (store JSON `{<plugin-id>: <ver>}`
//     and compare against `manifest.version`). The column stays;
//     only the consumer logic changes.
//
//     NULL on pre-009 sessions means "we don't know when this
//     started, don't replay deltas back to 0.0.0". Tool-delta
//     detector treats NULL as "ignore for now, just stamp it
//     forward to the current version on next interaction" so
//     historical sessions don't all light up with a wall of
//     notifications the moment the server reboots.

import type { Database } from "better-sqlite3";

export const ID = "009-session-app-version";

export function up(db: Database): void {
  db.exec(`
    ALTER TABLE sessions
    ADD COLUMN created_under_app_version TEXT;
  `);
}
