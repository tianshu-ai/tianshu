// Manages named data source connections.
//
// Two tiers:
//   1. Tenant-level — configured by admin in plugin config, shared by all users
//   2. User-level   — configured by individual users, supplements/overrides tenant
//
// When both tiers define a connection with the same name, the user-level wins.
// listSources / getDriver merge both tiers transparently.

import { createDriver, type ConnectionConfig, type DataSourceDriver } from "./drivers/index.js";

interface Pool {
  configs: Record<string, ConnectionConfig>;
  drivers: Map<string, DataSourceDriver>;
}

// tenant-level pools
const tenantPools = new Map<string, Pool>();
// user-level pools keyed by "tenantId::userId"
const userPools = new Map<string, Pool>();

function getOrCreatePool(map: Map<string, Pool>, key: string): Pool {
  let p = map.get(key);
  if (!p) {
    p = { configs: {}, drivers: new Map() };
    map.set(key, p);
  }
  return p;
}

function userKey(tenantId: string, userId: string): string {
  return `${tenantId}::${userId}`;
}

function syncPool(pool: Pool, conns: Record<string, ConnectionConfig>): void {
  // Close drivers that were removed or whose config changed
  for (const [name, driver] of pool.drivers) {
    const newCfg = conns[name];
    if (!newCfg || JSON.stringify(newCfg) !== JSON.stringify(pool.configs[name])) {
      driver.close().catch(() => {});
      pool.drivers.delete(name);
    }
  }
  pool.configs = conns;
}

// ── Tenant-level ────────────────────────────────────────────────

export function configureTenant(tenantId: string, conns: Record<string, ConnectionConfig>): void {
  syncPool(getOrCreatePool(tenantPools, tenantId), conns);
}

// ── User-level ──────────────────────────────────────────────────

export function configureUser(tenantId: string, userId: string, conns: Record<string, ConnectionConfig>): void {
  syncPool(getOrCreatePool(userPools, userKey(tenantId, userId)), conns);
}

export function getUserConnections(tenantId: string, userId: string): Record<string, ConnectionConfig> {
  return userPools.get(userKey(tenantId, userId))?.configs ?? {};
}

// ── Merged access (user overrides tenant) ───────────────────────

/** Merged config: tenant + user (user wins on name collision). */
function mergedConfigs(tenantId: string, userId?: string): Record<string, ConnectionConfig> {
  const tenant = tenantPools.get(tenantId)?.configs ?? {};
  if (!userId) return { ...tenant };
  const user = userPools.get(userKey(tenantId, userId))?.configs ?? {};
  return { ...tenant, ...user };
}

/** Resolve which pool owns a connection name. User-level first. */
function resolvePool(tenantId: string, userId: string | undefined, name: string): Pool | undefined {
  if (userId) {
    const up = userPools.get(userKey(tenantId, userId));
    if (up?.configs[name]) return up;
  }
  const tp = tenantPools.get(tenantId);
  if (tp?.configs[name]) return tp;
  return undefined;
}

export async function getDriver(tenantId: string, name: string, userId?: string): Promise<DataSourceDriver> {
  const pool = resolvePool(tenantId, userId, name);
  if (!pool) {
    const available = Object.keys(mergedConfigs(tenantId, userId));
    throw new Error(`Unknown data source: "${name}". Available: ${available.join(", ")}`);
  }
  let d = pool.drivers.get(name);
  if (d) return d;
  const cfg = pool.configs[name]!;
  d = await createDriver(name, cfg);
  pool.drivers.set(name, d);
  return d;
}

export function listSources(tenantId: string, userId?: string): Array<{ name: string; type: string; description: string; scope: "tenant" | "user" }> {
  const tenantCfg = tenantPools.get(tenantId)?.configs ?? {};
  const userCfg = userId ? (userPools.get(userKey(tenantId, userId))?.configs ?? {}) : {};

  const result: Array<{ name: string; type: string; description: string; scope: "tenant" | "user" }> = [];

  // User-level first (takes priority)
  for (const [name, cfg] of Object.entries(userCfg)) {
    result.push({ name, type: cfg.type, description: cfg.description ?? "", scope: "user" });
  }
  // Tenant-level (skip if already covered by user)
  for (const [name, cfg] of Object.entries(tenantCfg)) {
    if (!userCfg[name]) {
      result.push({ name, type: cfg.type, description: cfg.description ?? "", scope: "tenant" });
    }
  }
  return result;
}

export async function pingAll(tenantId: string, userId?: string): Promise<Record<string, { ok: boolean; error?: string }>> {
  const configs = mergedConfigs(tenantId, userId);
  const results: Record<string, { ok: boolean; error?: string }> = {};
  for (const name of Object.keys(configs)) {
    try {
      const d = await getDriver(tenantId, name, userId);
      const err = await d.ping();
      results[name] = err ? { ok: false, error: err } : { ok: true };
    } catch (err) {
      results[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return results;
}

export async function closeAll(tenantId: string): Promise<void> {
  const pool = tenantPools.get(tenantId);
  if (pool) {
    for (const d of pool.drivers.values()) await d.close().catch(() => {});
    pool.drivers.clear();
  }
  // Also close all user pools for this tenant
  for (const [key, pool] of userPools) {
    if (key.startsWith(tenantId + "::")) {
      for (const d of pool.drivers.values()) await d.close().catch(() => {});
      pool.drivers.clear();
    }
  }
}

// ── Backward compat ─────────────────────────────────────────────
/** @deprecated Use configureTenant */
export const configure = configureTenant;
