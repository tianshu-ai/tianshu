// Workboard DB schema bookkeeping.
//
// Most of the workboard's first-class schema (tasks, history)
// lives in host migrations under `packages/server/src/core/
// migrations/`. The bits here are workboard-private columns and
// teardown of the now-retired `worker_agents` table.
//
// PR-C2 of the DB → fs migration. Worker agents have moved to
// `<tenant>/_tenant/config/workers/<slug>/agent.json` (see
// `fs-worker-agents.ts`). The legacy table is dropped on every
// activation; the migration was driven by `migrate-worker-agents.ts`
// in the previous PR's activation cycle, so by the time C2 ships
// every tenant we care about has either fs-side rows or had them
// reconstructable from agent-seeds.

import type { TenantDbHandle } from "@tianshu-ai/plugin-sdk";

export function ensureSchema(db: TenantDbHandle): void {
  // Drop the legacy worker_agents table if it still exists. Source
  // of truth lives in the filesystem now.
  db.exec(`DROP TABLE IF EXISTS workboard_worker_agents`);

  // tasks.worker_agent_id continues to exist; semantics changed
  // from "UUID of a row in worker_agents" to "slug under
  // _tenant/config/workers/<slug>/". The column type is TEXT in
  // both cases, so no rewrite needed. The pool's claim path keys
  // off this slug now.
  const hasCol = db
    .prepare<[], { name: string }>(
      `SELECT name FROM pragma_table_info('tasks') WHERE name = 'worker_agent_id'`,
    )
    .get();
  if (!hasCol) {
    db.exec(`ALTER TABLE tasks ADD COLUMN worker_agent_id TEXT`);
  }
}
