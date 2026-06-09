// Migration runner.
//
// Migrations are simple: an ordered list, each with a unique id and an `up`
// function. We track applied ids in a `schema_migrations` table inside the
// tenant DB, so the runner is idempotent — calling it on an up-to-date DB
// is a no-op.
//
// Down migrations are intentionally NOT supported. SQLite + downgrade is
// painful; we'd rather forward-fix.

import type { Database } from "better-sqlite3";
import * as initial from "./001-initial.js";
import * as taskDependencies from "./002-task-dependencies.js";

export interface Migration {
  id: string;
  up: (db: Database) => void;
}

/** Ordered list of migrations. Append, never reorder, never edit past entries. */
export const MIGRATIONS: Migration[] = [
  { id: initial.ID, up: initial.up },
  { id: taskDependencies.ID, up: taskDependencies.up },
];

const ENSURE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id         TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );
`;

export function runMigrations(db: Database): { applied: string[]; alreadyApplied: string[] } {
  db.exec(ENSURE_MIGRATIONS_TABLE);

  const existing = db
    .prepare<[], { id: string }>("SELECT id FROM schema_migrations")
    .all()
    .map((r) => r.id);
  const seen = new Set(existing);

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  const recordStmt = db.prepare(
    "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
  );

  for (const m of MIGRATIONS) {
    if (seen.has(m.id)) {
      alreadyApplied.push(m.id);
      continue;
    }
    db.transaction(() => {
      m.up(db);
      recordStmt.run(m.id, Date.now());
    })();
    applied.push(m.id);
  }

  return { applied, alreadyApplied };
}
