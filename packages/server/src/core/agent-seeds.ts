// Plugin-contributed worker-agent seed copy.
//
// The mechanism mirrors `ensureTenantConfigDefaults` (templates):
// once per (tenant, plugin, seed.id) we copy the bundle into
// `<tenant>/_tenant/config/workers/<seed.id>/` if the slot is
// empty. Existing slots are never touched, so:
//
//   * a user edit (e.g. swapping the model in agent.json) is
//     preserved across plugin upgrades
//   * a deleted seed stays deleted — re-seeding only happens when
//     the slot is missing, which means the user explicitly nuked it
//     OR the tenant is brand-new
//
// Cross-plugin slug collisions are resolved last-writer-wins with
// a console warning. We don't try to be clever about it; plugin
// authors should pick globally distinctive ids.
//
// This runs synchronously after a plugin successfully `activate()`s.
// It's filesystem-only (no DB), idempotent, and cheap (one stat
// per seed in the common case).

import fs from "node:fs";
import path from "node:path";
import type { AgentSeedContribution } from "@tianshu-ai/plugin-sdk";
import { getTenantConfigDir } from "./paths.js";

export interface SeedAgentDirsArgs {
  tenantId: string;
  /** Plugin id, used in log lines + collision warnings. */
  pluginId: string;
  /** Plugin's manifest dir. Seed paths in the contribution are
   *  resolved against this. */
  pluginDir: string;
  /** Manifest-declared seeds. Empty / missing → no-op. */
  seeds: readonly AgentSeedContribution[];
  /** Override for tests. */
  home?: string;
  /** Optional sink — defaults to console.warn. */
  onWarn?: (msg: string) => void;
}

export interface SeedAgentDirsResult {
  /** Slugs that just got copied in. */
  inserted: string[];
  /** Slugs already on disk (untouched). */
  preserved: string[];
  /** Slugs whose source path didn't exist or wasn't a directory. */
  invalid: string[];
}

export function seedAgentDirs(args: SeedAgentDirsArgs): SeedAgentDirsResult {
  const { tenantId, pluginId, pluginDir, seeds, home, onWarn } = args;
  const inserted: string[] = [];
  const preserved: string[] = [];
  const invalid: string[] = [];
  const warn = onWarn ?? ((msg) => console.warn(msg));

  if (!seeds || seeds.length === 0) {
    return { inserted, preserved, invalid };
  }

  const workersRoot = path.join(
    getTenantConfigDir(tenantId, home),
    "workers",
  );
  fs.mkdirSync(workersRoot, { recursive: true });

  for (const seed of seeds) {
    if (!seed.id || !seed.path) {
      warn(
        `[agent-seeds:${pluginId}] skipping seed with missing id/path: ${JSON.stringify(seed)}`,
      );
      continue;
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(seed.id)) {
      warn(
        `[agent-seeds:${pluginId}] seed id "${seed.id}" rejected (kebab-case [a-z0-9][a-z0-9-]*)`,
      );
      continue;
    }
    const srcDir = path.resolve(pluginDir, seed.path);
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
      warn(
        `[agent-seeds:${pluginId}] seed "${seed.id}" path not a directory: ${srcDir}`,
      );
      invalid.push(seed.id);
      continue;
    }
    const dstDir = path.join(workersRoot, seed.id);
    if (fs.existsSync(dstDir)) {
      // Existing slot wins. Cross-plugin collision: log it but
      // keep going \u2014 the first plugin to seed this slug owns it
      // until the user removes the directory.
      preserved.push(seed.id);
      continue;
    }
    try {
      fs.cpSync(srcDir, dstDir, { recursive: true });
      inserted.push(seed.id);
    } catch (err) {
      warn(
        `[agent-seeds:${pluginId}] failed to copy seed "${seed.id}": ${err instanceof Error ? err.message : String(err)}`,
      );
      invalid.push(seed.id);
    }
  }

  return { inserted, preserved, invalid };
}
