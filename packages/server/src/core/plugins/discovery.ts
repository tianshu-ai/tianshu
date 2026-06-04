// Plugin discovery — scans the builtin and tenant plugin directories,
// parses manifests, and produces a deterministic merged list per
// ADR-0003 §3 (tenant manifest with same id replaces builtin; new id
// in tenant adds a tenant-only plugin).
//
// Discovery does NOT activate. Activation runs separately so a bad
// manifest is just one row marked failed in /api/plugins; the rest of
// the boot keeps going.

import fs from "node:fs";
import path from "node:path";
import type { PluginManifest } from "@tianshu/plugin-sdk";
import { getTenantSharedDir } from "../paths.js";
import { parseManifest, PluginManifestError } from "./manifest.js";

export type PluginSource = "builtin" | "tenant";

export interface DiscoveredPlugin {
  source: PluginSource;
  /** Absolute path to the plugin directory. */
  dir: string;
  manifest: PluginManifest;
}

export interface FailedManifest {
  source: PluginSource;
  dir: string;
  pluginId: string | null;
  issues: string[];
}

export interface DiscoveryResult {
  plugins: DiscoveredPlugin[];
  failed: FailedManifest[];
}

export interface DiscoveryOpts {
  /** Override the builtinConfig directory. Resolves the BUILTIN_CONFIG_DIR
   *  env if not given, finally falling back to packages/server/builtinConfig. */
  builtinConfigDir?: string;
  /** Override the tenant home dir base. Optional — defaults to TIANSHU_HOME. */
  home?: string;
}

export function getBuiltinConfigDir(): string {
  const env = process.env.BUILTIN_CONFIG_DIR?.trim();
  if (env) return path.resolve(env);
  // Resolve relative to this file at runtime: dist/core/plugins/discovery.js
  // → ../../../builtinConfig (server package root).
  // For ESM we can't use __dirname; rely on import.meta.url.
  const here = new URL(".", import.meta.url).pathname;
  return path.resolve(here, "..", "..", "..", "builtinConfig");
}

export function discoverPlugins(tenantId: string, opts: DiscoveryOpts = {}): DiscoveryResult {
  const builtinDir = opts.builtinConfigDir ?? getBuiltinConfigDir();
  const tenantDir = path.join(getTenantSharedDir(tenantId, opts.home), "config", "plugins");

  const builtin = scanPluginDir(path.join(builtinDir, "plugins"), "builtin");
  const tenant = scanPluginDir(tenantDir, "tenant");

  // Tenant manifests override builtin by id; new ids merge in.
  const byId = new Map<string, DiscoveredPlugin>();
  for (const p of builtin.plugins) byId.set(p.manifest.id, p);
  for (const p of tenant.plugins) byId.set(p.manifest.id, p);

  const plugins = [...byId.values()].sort((a, b) =>
    a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0,
  );

  return {
    plugins,
    failed: [...builtin.failed, ...tenant.failed],
  };
}

interface ScanResult {
  plugins: DiscoveredPlugin[];
  failed: FailedManifest[];
}

function scanPluginDir(dir: string, source: PluginSource): ScanResult {
  if (!fs.existsSync(dir)) return { plugins: [], failed: [] };
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const plugins: DiscoveredPlugin[] = [];
  const failed: FailedManifest[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
    const pluginDir = path.join(dir, e.name);
    const manifestPath = path.join(pluginDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (err) {
      failed.push({
        source,
        dir: pluginDir,
        pluginId: null,
        issues: [`failed to parse manifest.json: ${err instanceof Error ? err.message : String(err)}`],
      });
      continue;
    }
    try {
      const manifest = parseManifest(raw);
      if (manifest.id !== e.name) {
        failed.push({
          source,
          dir: pluginDir,
          pluginId: manifest.id,
          issues: [`manifest.id "${manifest.id}" must match directory name "${e.name}"`],
        });
        continue;
      }
      plugins.push({ source, dir: pluginDir, manifest });
    } catch (err) {
      if (err instanceof PluginManifestError) {
        failed.push({ source, dir: pluginDir, pluginId: err.pluginId, issues: err.issues });
      } else {
        failed.push({
          source,
          dir: pluginDir,
          pluginId: null,
          issues: [err instanceof Error ? err.message : String(err)],
        });
      }
    }
  }
  return { plugins, failed };
}
