// Channel-binding persistence + CRUD.
//
// One row per (tenant, channel, account) lives in `channel_bindings`
// (migration 010). The adapter lifecycle is driven off these rows:
// boot enumerates `enabled=true` rows and starts adapters for each;
// admin "Add" inserts a row + starts the adapter; admin "Remove"
// stops the adapter + deletes the row.
//
// Config is JSON-serialised on write and parsed on read. We never
// expose the raw `config` JSON string to callers; the in-memory shape
// is `Record<string, unknown>` and the plugin's adapter factory is
// responsible for validating its own subset (e.g. via zod). The host
// stores opaquely.

import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { BindingStatus, ChannelBinding } from "./types.js";

interface ChannelBindingRow {
  id: string;
  tenant_id: string;
  channel_id: string;
  plugin_id: string;
  display_name: string | null;
  config: string;
  enabled: number;
  status: string;
  status_detail: string | null;
  created_at: number;
  updated_at: number;
}

function rowToBinding(row: ChannelBindingRow): ChannelBinding {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    channelId: row.channel_id,
    pluginId: row.plugin_id,
    displayName: row.display_name,
    config: parseConfig(row.config),
    enabled: row.enabled === 1,
    status: row.status as BindingStatus,
    statusDetail: row.status_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseConfig(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

/** List every binding visible to a tenant. Disabled rows are
 *  included; callers filter as needed. */
export function listBindingsForTenant(
  db: Database,
  tenantId: string,
): ChannelBinding[] {
  const rows = db
    .prepare<[string], ChannelBindingRow>(
      `SELECT id, tenant_id, channel_id, plugin_id, display_name, config,
              enabled, status, status_detail, created_at, updated_at
         FROM channel_bindings
        WHERE tenant_id = ?
        ORDER BY created_at ASC`,
    )
    .all(tenantId);
  return rows.map(rowToBinding);
}

/** List every binding the host should start at boot. */
export function listEnabledBindings(db: Database): ChannelBinding[] {
  const rows = db
    .prepare<[], ChannelBindingRow>(
      `SELECT id, tenant_id, channel_id, plugin_id, display_name, config,
              enabled, status, status_detail, created_at, updated_at
         FROM channel_bindings
        WHERE enabled = 1
        ORDER BY tenant_id, channel_id`,
    )
    .all();
  return rows.map(rowToBinding);
}

/** Look up a single binding by id. */
export function getBinding(
  db: Database,
  bindingId: string,
): ChannelBinding | null {
  const row = db
    .prepare<[string], ChannelBindingRow>(
      `SELECT id, tenant_id, channel_id, plugin_id, display_name, config,
              enabled, status, status_detail, created_at, updated_at
         FROM channel_bindings WHERE id = ?`,
    )
    .get(bindingId);
  return row ? rowToBinding(row) : null;
}

export interface CreateBindingInput {
  tenantId: string;
  channelId: string;
  pluginId: string;
  displayName?: string;
  config: Record<string, unknown>;
  enabled?: boolean;
}

/** Insert a new binding. Returns the freshly-created row. */
export function createBinding(
  db: Database,
  input: CreateBindingInput,
): ChannelBinding {
  const id = `cb_${randomUUID()}`;
  const now = Date.now();
  db.prepare<[string, string, string, string, string | null, string, number, number, number], unknown>(
    `INSERT INTO channel_bindings
       (id, tenant_id, channel_id, plugin_id, display_name, config,
        enabled, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
  ).run(
    id,
    input.tenantId,
    input.channelId,
    input.pluginId,
    input.displayName ?? null,
    JSON.stringify(input.config ?? {}),
    input.enabled === false ? 0 : 1,
    now,
    now,
  );
  return getBinding(db, id)!;
}

/** Update mutable fields on a binding. Only the columns explicitly
 *  passed are touched; the rest stay at their current value. */
export interface UpdateBindingInput {
  displayName?: string | null;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export function updateBinding(
  db: Database,
  bindingId: string,
  patch: UpdateBindingInput,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.displayName !== undefined) {
    sets.push("display_name = ?");
    params.push(patch.displayName);
  }
  if (patch.config !== undefined) {
    sets.push("config = ?");
    params.push(JSON.stringify(patch.config));
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(patch.enabled ? 1 : 0);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  params.push(Date.now());
  params.push(bindingId);
  db.prepare(
    `UPDATE channel_bindings SET ${sets.join(", ")} WHERE id = ?`,
  ).run(...params);
}

/** Update only the status / status_detail of a binding. Called by
 *  the adapter manager when the underlying adapter transitions
 *  through start → running → error states. */
export function setBindingStatus(
  db: Database,
  bindingId: string,
  status: BindingStatus,
  detail?: string | null,
): void {
  db.prepare<[string, string | null, number, string], unknown>(
    `UPDATE channel_bindings
        SET status = ?, status_detail = ?, updated_at = ?
      WHERE id = ?`,
  ).run(status, detail ?? null, Date.now(), bindingId);
}

/** Delete a binding row. The caller is responsible for stopping
 *  the adapter first; we don't unregister from the hub here. */
export function deleteBinding(db: Database, bindingId: string): void {
  db.prepare<[string], unknown>(`DELETE FROM channel_bindings WHERE id = ?`).run(
    bindingId,
  );
}
