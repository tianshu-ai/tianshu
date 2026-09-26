// Manages named data source connections, per-tenant.

import { createDriver, type ConnectionConfig, type DataSourceDriver } from "./drivers/index.js";

interface TenantPool {
  configs: Record<string, ConnectionConfig>;
  drivers: Map<string, DataSourceDriver>;
}

const pools = new Map<string, TenantPool>();

function getPool(tenantId: string): TenantPool {
  let p = pools.get(tenantId);
  if (!p) {
    p = { configs: {}, drivers: new Map() };
    pools.set(tenantId, p);
  }
  return p;
}

export function configure(tenantId: string, conns: Record<string, ConnectionConfig>): void {
  const pool = getPool(tenantId);
  // Close old drivers that are no longer in config
  for (const [name, driver] of pool.drivers) {
    if (!conns[name]) {
      driver.close().catch(() => {});
      pool.drivers.delete(name);
    }
  }
  pool.configs = conns;
}

export async function getDriver(tenantId: string, name: string): Promise<DataSourceDriver> {
  const pool = getPool(tenantId);
  let d = pool.drivers.get(name);
  if (d) return d;
  const cfg = pool.configs[name];
  if (!cfg) throw new Error(`Unknown data source: "${name}". Available: ${Object.keys(pool.configs).join(", ")}`);
  d = await createDriver(name, cfg);
  pool.drivers.set(name, d);
  return d;
}

export function listSources(tenantId: string): Array<{ name: string; type: string; description: string }> {
  const pool = getPool(tenantId);
  return Object.entries(pool.configs).map(([name, cfg]) => ({
    name,
    type: cfg.type,
    description: cfg.description ?? "",
  }));
}

export async function pingAll(tenantId: string): Promise<Record<string, { ok: boolean; error?: string }>> {
  const pool = getPool(tenantId);
  const results: Record<string, { ok: boolean; error?: string }> = {};
  for (const name of Object.keys(pool.configs)) {
    try {
      const d = await getDriver(tenantId, name);
      const err = await d.ping();
      results[name] = err ? { ok: false, error: err } : { ok: true };
    } catch (err) {
      results[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return results;
}

export async function closeAll(tenantId: string): Promise<void> {
  const pool = pools.get(tenantId);
  if (!pool) return;
  for (const d of pool.drivers.values()) {
    await d.close().catch(() => {});
  }
  pool.drivers.clear();
}
