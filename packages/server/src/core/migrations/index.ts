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
import * as sessionTree from "./003-session-tree.js";
import * as rebuildMessageChain from "./004-rebuild-message-chain.js";
import * as taskStatusRename from "./005-task-status-rename.js";
import * as taskLabels from "./006-task-labels.js";
import * as sessionInbox from "./007-session-inbox.js";
import * as taskIntervention from "./008-task-intervention.js";
import * as sessionAppVersion from "./009-session-app-version.js";
import * as channels from "./010-channels.js";
import * as channelBindingsOwner from "./011-channel-bindings-owner.js";
import * as channelBindingsUnique from "./012-channel-bindings-unique.js";
import * as userPreferences from "./013-user-preferences.js";
import * as messageChainWalkIndex from "./014-message-chain-walk-index.js";
import * as piStorageV2 from "./015-pi-storage-v2.js";
import * as toolResultToTool from "./016-toolresult-to-tool.js";
import * as turnNumber from "./017-turn-number.js";
import * as turnNumberForkSeed from "./018-turn-number-fork-seed.js";

export interface Migration {
  id: string;
  up: (db: Database) => void;
}

/** Ordered list of migrations. Append, never reorder, never edit past entries. */
export const MIGRATIONS: Migration[] = [
  { id: initial.ID, up: initial.up },
  { id: taskDependencies.ID, up: taskDependencies.up },
  { id: sessionTree.ID, up: sessionTree.up },
  { id: rebuildMessageChain.ID, up: rebuildMessageChain.up },
  { id: taskStatusRename.ID, up: taskStatusRename.up },
  { id: taskLabels.ID, up: taskLabels.up },
  { id: sessionInbox.ID, up: sessionInbox.up },
  { id: taskIntervention.ID, up: taskIntervention.up },
  { id: sessionAppVersion.ID, up: sessionAppVersion.up },
  { id: channels.ID, up: channels.up },
  { id: channelBindingsOwner.ID, up: channelBindingsOwner.up },
  { id: channelBindingsUnique.ID, up: channelBindingsUnique.up },
  { id: userPreferences.ID, up: userPreferences.up },
  { id: messageChainWalkIndex.ID, up: messageChainWalkIndex.up },
  { id: piStorageV2.ID, up: piStorageV2.up },
  { id: toolResultToTool.ID, up: toolResultToTool.up },
  { id: turnNumber.ID, up: turnNumber.up },
  { id: turnNumberForkSeed.ID, up: turnNumberForkSeed.up },
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
    console.log(`[migrations] running ${m.id}...`);
    const t0 = Date.now();
    db.transaction(() => {
      m.up(db);
      recordStmt.run(m.id, Date.now());
    })();
    console.log(`[migrations] ${m.id} done (${Date.now() - t0}ms)`);
    applied.push(m.id);
  }

  return { applied, alreadyApplied };
}
