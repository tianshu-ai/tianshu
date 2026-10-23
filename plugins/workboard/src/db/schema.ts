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

  // notify_channels: JSON array of channel names (e.g. '["webchat","wechat"]').
  // When set, the pool delivers completion notifications to the listed
  // channels instead of the single parentSessionId. NULL means fallback
  // to parentSessionId (backwards-compatible with pre-existing tasks).
  const hasNotifyChannels = db
    .prepare<[], { name: string }>(
      `SELECT name FROM pragma_table_info('tasks') WHERE name = 'notify_channels'`,
    )
    .get();
  if (!hasNotifyChannels) {
    db.exec(`ALTER TABLE tasks ADD COLUMN notify_channels TEXT DEFAULT NULL`);
  }

  // estimated_duration_ms: per-task time estimate set by the creating
  // agent. The supervision watchdog uses this as the first check
  // interval instead of the global default.
  const hasEstDuration = db
    .prepare<[], { name: string }>(
      `SELECT name FROM pragma_table_info('tasks') WHERE name = 'estimated_duration_ms'`,
    )
    .get();
  if (!hasEstDuration) {
    db.exec(`ALTER TABLE tasks ADD COLUMN estimated_duration_ms INTEGER DEFAULT NULL`);
  }

  // next_check_at: epoch ms when the supervision watchdog should
  // next notify the parent session about this task's status.
  // NULL means no pending check (task idle or already completed).
  const hasNextCheck = db
    .prepare<[], { name: string }>(
      `SELECT name FROM pragma_table_info('tasks') WHERE name = 'next_check_at'`,
    )
    .get();
  if (!hasNextCheck) {
    db.exec(`ALTER TABLE tasks ADD COLUMN next_check_at INTEGER DEFAULT NULL`);
  }
}
