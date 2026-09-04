// Manages named data source connections.

import { createDriver, type ConnectionConfig, type DataSourceDriver } from "./drivers/index.js";

const drivers = new Map<string, DataSourceDriver>();
let configs: Record<string, ConnectionConfig> = {};

export function configure(conns: Record<string, ConnectionConfig>): void {
  // Close old drivers that are no longer in config
  for (const [name, driver] of drivers) {
    if (!conns[name]) {
      driver.close().catch(() => {});
      drivers.delete(name);
    }
  }
  configs = conns;
}

export async function getDriver(name: string): Promise<DataSourceDriver> {
  let d = drivers.get(name);
  if (d) return d;
  const cfg = configs[name];
  if (!cfg) throw new Error(`Unknown data source: "${name}". Available: ${Object.keys(configs).join(", ")}`);
  d = await createDriver(name, cfg);
  drivers.set(name, d);
  return d;
}

export function listSources(): Array<{ name: string; type: string; description: string }> {
  return Object.entries(configs).map(([name, cfg]) => ({
    name,
    type: cfg.type,
    description: cfg.description ?? "",
  }));
}

export async function pingAll(): Promise<Record<string, { ok: boolean; error?: string }>> {
  const results: Record<string, { ok: boolean; error?: string }> = {};
  for (const name of Object.keys(configs)) {
    try {
      const d = await getDriver(name);
      const err = await d.ping();
      results[name] = err ? { ok: false, error: err } : { ok: true };
    } catch (err) {
      results[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return results;
}

export async function closeAll(): Promise<void> {
  for (const d of drivers.values()) {
    await d.close().catch(() => {});
  }
  drivers.clear();
}
