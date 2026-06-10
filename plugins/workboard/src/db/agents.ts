// Worker-agent rows. Owned end-to-end by the workboard plugin.
//
// History note: an earlier draft put this table in a host migration
// (003-worker-agents) on the theory that other plugins might want to
// reference agent ids. Nothing did, so the abstraction was hoisted
// too high — N+6.2 v2 moves it back into the plugin. Schema lives
// here, ensured idempotently on activate via `ensureSchema()`.
//
// The plugin's REST surface (`routes/agents.ts`), the workboard
// admin page, and the WorkerPool all read through this module. No
// other plugin should poke this table directly; if a future feature
// needs to "share" agents across plugins, do it through a defined
// API/capability instead of cross-plugin SQL.
//
// Seeding rule (from the original ADR-0002 §7.1 follow-up):
//   * insert if no row with `(tenant_id, builtin_key)` exists
//   * update if row exists and `overrides_at IS NULL`
//   * preserve if row exists and `overrides_at IS NOT NULL`
// Reset (a separate explicit op) clears `overrides_at` and
// re-applies the seed.

import { randomUUID } from "node:crypto";
import type { TenantDbHandle } from "@tianshu/plugin-sdk";

export interface WorkerAgent {
  id: string;
  tenantId: string;
  kind: string;
  name: string;
  description: string | null;
  modelId: string | null;
  systemPrompt: string | null;
  toolsAllow: string[] | null;
  skills: string[] | null;
  source: "builtin" | "user";
  builtinKey: string | null;
  ownerUserId: string | null;
  /** When false, the row stays in the table (config preserved) but
   *  the pool doesn't allocate a slot for it — the user's primary
   *  knob to mute an agent. Defaults to true for both seeded
   *  builtin rows and freshly created user rows. */
  enabled: boolean;
  overridesAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface WorkerAgentRow {
  id: string;
  tenant_id: string;
  kind: string;
  name: string;
  description: string | null;
  model_id: string | null;
  system_prompt: string | null;
  tools_allow: string | null;
  skills: string | null;
  source: string;
  builtin_key: string | null;
  owner_user_id: string | null;
  enabled: number;
  overrides_at: number | null;
  created_at: number;
  updated_at: number;
}

function parseStringArray(raw: string | null): string[] | null {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : null;
  } catch {
    return null;
  }
}

function rowToAgent(row: WorkerAgentRow): WorkerAgent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    modelId: row.model_id,
    systemPrompt: row.system_prompt,
    toolsAllow: parseStringArray(row.tools_allow),
    skills: parseStringArray(row.skills),
    source: row.source as WorkerAgent["source"],
    builtinKey: row.builtin_key,
    ownerUserId: row.owner_user_id,
    enabled: row.enabled !== 0,
    overridesAt: row.overrides_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Idempotent — runs on every plugin activation. The table doesn't
 *  go through the host migration runner because no other plugin
 *  needs it; if/when that changes, promote the schema to a host
 *  migration and delete this function.
 *
 *  Also adds `tasks.worker_agent_id` if missing. The `tasks` table
 *  is created by host migration 001-initial, but the column is
 *  workboard-specific — plugin owns the schema for its own
 *  features. SQLite's `ALTER TABLE ADD COLUMN` has no `IF NOT
 *  EXISTS`, so we check `pragma_table_info` first. */
export function ensureSchema(db: TenantDbHandle): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workboard_worker_agents (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL,
      kind            TEXT NOT NULL,
      name            TEXT NOT NULL,
      description     TEXT,
      model_id        TEXT,
      system_prompt   TEXT,
      tools_allow     TEXT,
      skills          TEXT,
      source          TEXT NOT NULL CHECK (source IN ('builtin','user')),
      builtin_key     TEXT,
      owner_user_id   TEXT,
      enabled         INTEGER NOT NULL DEFAULT 1,
      overrides_at    INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workboard_agents_kind
      ON workboard_worker_agents(kind);
    CREATE INDEX IF NOT EXISTS idx_workboard_agents_owner
      ON workboard_worker_agents(owner_user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workboard_agents_builtin
      ON workboard_worker_agents(tenant_id, builtin_key)
      WHERE builtin_key IS NOT NULL;
  `);

  const hasCol = db
    .prepare<[], { name: string }>(
      `SELECT name FROM pragma_table_info('tasks') WHERE name = 'worker_agent_id'`,
    )
    .get();
  if (!hasCol) {
    db.exec(`ALTER TABLE tasks ADD COLUMN worker_agent_id TEXT`);
  }

  // `enabled` was added after the first cut shipped — backfill if
  // the column is missing on an existing tenant DB.
  const hasEnabled = db
    .prepare<[], { name: string }>(
      `SELECT name FROM pragma_table_info('workboard_worker_agents') WHERE name = 'enabled'`,
    )
    .get();
  if (!hasEnabled) {
    db.exec(
      `ALTER TABLE workboard_worker_agents
       ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`,
    );
  }
}

export function listWorkerAgents(
  db: TenantDbHandle,
  tenantId: string,
): WorkerAgent[] {
  const rows = db
    .prepare<[string], WorkerAgentRow>(
      `SELECT * FROM workboard_worker_agents
       WHERE tenant_id = ?
       ORDER BY source ASC, name ASC, created_at ASC`,
    )
    .all(tenantId);
  return rows.map(rowToAgent);
}

export function getWorkerAgent(
  db: TenantDbHandle,
  tenantId: string,
  id: string,
): WorkerAgent | null {
  const row = db
    .prepare<[string, string], WorkerAgentRow>(
      `SELECT * FROM workboard_worker_agents WHERE tenant_id = ? AND id = ?`,
    )
    .get(tenantId, id);
  return row ? rowToAgent(row) : null;
}

export function getWorkerAgentByBuiltinKey(
  db: TenantDbHandle,
  tenantId: string,
  builtinKey: string,
): WorkerAgent | null {
  const row = db
    .prepare<[string, string], WorkerAgentRow>(
      `SELECT * FROM workboard_worker_agents WHERE tenant_id = ? AND builtin_key = ?`,
    )
    .get(tenantId, builtinKey);
  return row ? rowToAgent(row) : null;
}

export interface CreateWorkerAgentInput {
  kind: string;
  name: string;
  description?: string | null;
  modelId?: string | null;
  systemPrompt?: string | null;
  toolsAllow?: string[] | null;
  skills?: string[] | null;
  ownerUserId?: string | null;
  /** Defaults to true. */
  enabled?: boolean;
}

export function createUserWorkerAgent(
  db: TenantDbHandle,
  tenantId: string,
  input: CreateWorkerAgentInput,
): WorkerAgent {
  const now = Date.now();
  const id = randomUUID();
  const enabled = input.enabled === false ? 0 : 1;
  db.prepare(
    `INSERT INTO workboard_worker_agents (
       id, tenant_id, kind, name, description,
       model_id, system_prompt, tools_allow, skills,
       source, builtin_key, owner_user_id, enabled, overrides_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', NULL, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    tenantId,
    input.kind,
    input.name.trim(),
    input.description?.trim() || null,
    input.modelId?.trim() || null,
    input.systemPrompt?.trim() || null,
    input.toolsAllow ? JSON.stringify(input.toolsAllow) : null,
    input.skills ? JSON.stringify(input.skills) : null,
    input.ownerUserId ?? null,
    enabled,
    now,
    now,
  );
  const row = getWorkerAgent(db, tenantId, id);
  if (!row) throw new Error(`createUserWorkerAgent: row ${id} vanished`);
  return row;
}

export interface UpdateWorkerAgentPatch {
  name?: string;
  description?: string | null;
  modelId?: string | null;
  systemPrompt?: string | null;
  toolsAllow?: string[] | null;
  skills?: string[] | null;
  enabled?: boolean;
}

/** Patch a worker agent. Always stamps `overrides_at` so the seed
 *  loop knows the user touched this row. */
export function updateWorkerAgent(
  db: TenantDbHandle,
  tenantId: string,
  id: string,
  patch: UpdateWorkerAgentPatch,
): WorkerAgent | null {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.name !== undefined) {
    sets.push("name = ?");
    params.push(patch.name.trim());
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    params.push(patch.description?.trim() || null);
  }
  if (patch.modelId !== undefined) {
    sets.push("model_id = ?");
    params.push(patch.modelId?.trim() || null);
  }
  if (patch.systemPrompt !== undefined) {
    sets.push("system_prompt = ?");
    params.push(patch.systemPrompt?.trim() || null);
  }
  if (patch.toolsAllow !== undefined) {
    sets.push("tools_allow = ?");
    params.push(patch.toolsAllow ? JSON.stringify(patch.toolsAllow) : null);
  }
  if (patch.skills !== undefined) {
    sets.push("skills = ?");
    params.push(patch.skills ? JSON.stringify(patch.skills) : null);
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(patch.enabled ? 1 : 0);
  }

  if (sets.length === 0) return getWorkerAgent(db, tenantId, id);

  // Toggling `enabled` alone is a runtime mute, not a config
  // override — don't stamp `overrides_at` so the next plugin
  // upgrade can still flow display fields through. Any other field
  // change DOES count as user customisation and locks the row
  // against seed updates.
  const onlyEnabled =
    patch.enabled !== undefined &&
    patch.name === undefined &&
    patch.description === undefined &&
    patch.modelId === undefined &&
    patch.systemPrompt === undefined &&
    patch.toolsAllow === undefined &&
    patch.skills === undefined;

  const now = Date.now();
  if (onlyEnabled) {
    sets.push("updated_at = ?");
    params.push(now);
  } else {
    sets.push("updated_at = ?", "overrides_at = ?");
    params.push(now, now);
  }
  params.push(tenantId, id);
  db.prepare(
    `UPDATE workboard_worker_agents SET ${sets.join(", ")}
     WHERE tenant_id = ? AND id = ?`,
  ).run(...params);
  return getWorkerAgent(db, tenantId, id);
}

export function deleteWorkerAgent(
  db: TenantDbHandle,
  tenantId: string,
  id: string,
): boolean {
  const before = getWorkerAgent(db, tenantId, id);
  if (!before) return false;
  // Builtin rows are protected — the seed loop's invariants depend
  // on `builtin_key` rows persisting across plugin updates. The
  // user can reset them but not delete.
  if (before.source === "builtin") return false;
  db.prepare(
    `DELETE FROM workboard_worker_agents WHERE tenant_id = ? AND id = ?`,
  ).run(tenantId, id);
  return true;
}

export interface SeedAgentSpec {
  /** Locally-unique key. The seed loop namespaces this internally
   *  under the workboard plugin id so future seed contributions
   *  from other surfaces can't collide. */
  builtinKey: string;
  kind: string;
  name: string;
  description?: string | null;
  modelId?: string | null;
  systemPrompt?: string | null;
  toolsAllow?: string[] | null;
  skills?: string[] | null;
}

/**
 * Idempotent seed of plugin-contributed default agents.
 *
 * For each spec:
 *   - if no row with this `builtin_key` exists → insert as `builtin`
 *     with `overrides_at=NULL`
 *   - if row exists and `overrides_at IS NULL` → update fields to
 *     match the spec (plugin update flows through)
 *   - if row exists and `overrides_at IS NOT NULL` → no-op
 *     (user customisation wins until reset)
 *
 * Returns counts so the activation log can show what happened.
 */
export function seedBuiltinAgents(
  db: TenantDbHandle,
  tenantId: string,
  specs: readonly SeedAgentSpec[],
): { inserted: number; updated: number; preserved: number } {
  let inserted = 0;
  let updated = 0;
  let preserved = 0;
  const now = Date.now();

  for (const s of specs) {
    const existing = getWorkerAgentByBuiltinKey(db, tenantId, s.builtinKey);
    if (!existing) {
      db.prepare(
        `INSERT INTO workboard_worker_agents (
           id, tenant_id, kind, name, description,
           model_id, system_prompt, tools_allow, skills,
           source, builtin_key, owner_user_id, overrides_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'builtin', ?, NULL, NULL, ?, ?)`,
      ).run(
        randomUUID(),
        tenantId,
        s.kind,
        s.name,
        s.description ?? null,
        s.modelId ?? null,
        s.systemPrompt ?? null,
        s.toolsAllow ? JSON.stringify(s.toolsAllow) : null,
        s.skills ? JSON.stringify(s.skills) : null,
        s.builtinKey,
        now,
        now,
      );
      inserted++;
      continue;
    }
    if (existing.overridesAt !== null) {
      preserved++;
      continue;
    }
    db.prepare(
      `UPDATE workboard_worker_agents
       SET kind = ?, name = ?, description = ?, model_id = ?,
           system_prompt = ?, tools_allow = ?, skills = ?,
           updated_at = ?
       WHERE tenant_id = ? AND builtin_key = ?`,
    ).run(
      s.kind,
      s.name,
      s.description ?? null,
      s.modelId ?? null,
      s.systemPrompt ?? null,
      s.toolsAllow ? JSON.stringify(s.toolsAllow) : null,
      s.skills ? JSON.stringify(s.skills) : null,
      now,
      tenantId,
      s.builtinKey,
    );
    updated++;
  }

  return { inserted, updated, preserved };
}

/** Reset a builtin row back to its seeded values and clear the
 *  user-edit timestamp so the next seed pass treats it as
 *  untouched again. Returns the post-reset row, or null if the
 *  row no longer matches a seed (caller should 400). */
export function resetBuiltinAgent(
  db: TenantDbHandle,
  tenantId: string,
  id: string,
  seedByBuiltinKey: Map<string, SeedAgentSpec>,
): WorkerAgent | null {
  const before = getWorkerAgent(db, tenantId, id);
  if (!before || before.source !== "builtin" || !before.builtinKey) return null;
  const spec = seedByBuiltinKey.get(before.builtinKey);
  if (!spec) return null;
  const now = Date.now();
  db.prepare(
    `UPDATE workboard_worker_agents
     SET kind = ?, name = ?, description = ?, model_id = ?,
         system_prompt = ?, tools_allow = ?, skills = ?,
         overrides_at = NULL,
         updated_at = ?
     WHERE tenant_id = ? AND id = ?`,
  ).run(
    spec.kind,
    spec.name,
    spec.description ?? null,
    spec.modelId ?? null,
    spec.systemPrompt ?? null,
    spec.toolsAllow ? JSON.stringify(spec.toolsAllow) : null,
    spec.skills ? JSON.stringify(spec.skills) : null,
    now,
    tenantId,
    id,
  );
  return getWorkerAgent(db, tenantId, id);
}
