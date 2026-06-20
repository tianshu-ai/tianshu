// Tenant + user + plugin enablement topology.
//
// Replaces the "Builtin plugins" section with a more honest view:
//   ✓ tenant 'default'
//      users: dev
//      plugins: files, workboard
//   ✓ tenant 'alpha'
//      users: alice, bob
//      plugins: files
//
// Why this shape: pre-this-commit doctor either listed plugins
// without saying *for whom* (the original `✓ files`) or listed
// plugins by tenant per row (the previous fix). Both leave the
// tenant→user linkage invisible. Users running multi-tenant /
// multi-user installs (the actual purpose of the multi-tenant
// architecture) had to mentally cross-reference Plugin Manager
// UI + tenant config. Cli-agent had no visibility either.
//
// The cli-agent's `run_doctor` returns this same structured shape
// (severity/text/detail), so the agent can answer "what's enabled
// where?" by reading one tool result instead of grepping configs.

import fs from "node:fs";
import path from "node:path";
import { CheckGroup } from "../render.js";
import { getBuiltinConfigDir } from "../../core/plugins/discovery.js";
import {
  loadGlobalConfig,
  loadTenantConfig,
  type PluginsConfig,
} from "../../core/config.js";
import { getTianshuHome } from "../../core/paths.js";

export interface TenantsCheckOpts {
  /** Override builtinConfig dir (test seam / monorepo dev override). */
  builtinConfigDir?: string;
  /** Override TIANSHU_HOME root for test isolation. */
  home?: string;
}

export function checkTenants(opts: TenantsCheckOpts = {}): CheckGroup {
  const lines: CheckGroup["lines"] = [];
  const home = opts.home ?? getTianshuHome();

  // What plugins are *available* (manifest on disk). We need this
  // both to render unknown-plugin warnings (config references a
  // plugin id that doesn't exist anymore) and to compute the
  // "all available" baseline.
  const availablePlugins = readAvailablePlugins(opts);
  if (availablePlugins.error) {
    lines.push({
      severity: "warning",
      text: "couldn't enumerate plugins",
      detail: availablePlugins.error,
    });
  }
  const availableSet = new Set(availablePlugins.ids);

  // Now the tenants pass.
  const tenantIds = listTenants(home);
  if (tenantIds.length === 0) {
    lines.push({
      severity: "warning",
      text: "no tenants on disk",
      detail:
        "Run `tianshu tenant create default` (or let the wizard auto-create one).",
    });
    return { title: "Tenants & plugins", lines };
  }

  const globalCfg = safeLoadGlobalConfig(home);

  for (const tenantId of tenantIds) {
    const tenantCfg = safeLoadTenantConfig(tenantId, home);
    const merged = mergePlugins(globalCfg.plugins, tenantCfg.plugins);

    const enabled: string[] = [];
    const disabled: string[] = [];
    const unknown: string[] = [];
    for (const [pluginId, entry] of Object.entries(merged)) {
      if (!availableSet.has(pluginId)) {
        unknown.push(pluginId);
        continue;
      }
      if (entry?.enabled === true) enabled.push(pluginId);
      else disabled.push(pluginId);
    }
    // Plugins that exist on disk but aren't mentioned at all in
    // either global or tenant config are effectively disabled.
    // Render them in the disabled bucket so the user (and agent)
    // can see "available but not configured for this tenant".
    for (const id of availablePlugins.ids) {
      if (!(id in merged)) disabled.push(id);
    }

    const users = listUsers(home, tenantId);

    // Header line per tenant.
    lines.push({
      severity: "ok",
      text: `tenant '${tenantId}'`,
      detail: tenantCfg.defaultModel
        ? `defaultModel override: ${tenantCfg.defaultModel}`
        : undefined,
    });
    lines.push({
      severity: "ok",
      text: `  users (${users.length}): ${users.length > 0 ? users.join(", ") : "(none)"}`,
    });
    lines.push({
      severity: "ok",
      text: `  enabled plugins (${enabled.length}): ${enabled.length > 0 ? enabled.sort().join(", ") : "(none)"}`,
    });
    if (disabled.length > 0) {
      lines.push({
        severity: "ok",
        text: `  disabled plugins (${disabled.length}): ${disabled.sort().join(", ")}`,
      });
    }
    if (unknown.length > 0) {
      lines.push({
        severity: "warning",
        text: `  unknown plugins in config (${unknown.length}): ${unknown.sort().join(", ")}`,
        detail:
          "Config references plugins that don't exist on disk. Either install them, or remove the entries.",
      });
    }
  }

  return { title: "Tenants & plugins", lines };
}

function readAvailablePlugins(
  opts: TenantsCheckOpts,
): { ids: string[]; error?: string } {
  let dir: string;
  try {
    dir = opts.builtinConfigDir ?? getBuiltinConfigDir();
  } catch (err) {
    return {
      ids: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const pluginsRoot = path.join(dir, "plugins");
  if (!fs.existsSync(pluginsRoot)) {
    return {
      ids: [],
      error: `${pluginsRoot} doesn't exist; \`npm run sync:plugins\` may not have run yet.`,
    };
  }
  const ids: string[] = [];
  for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(pluginsRoot, entry.name, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        id?: string;
      };
      if (m.id) ids.push(m.id);
    } catch {
      // skip; manifest sanity is the registry's job, not ours
    }
  }
  return { ids };
}

function listTenants(home: string): string[] {
  const tenantsDir = path.join(home, "tenants");
  if (!fs.existsSync(tenantsDir)) return [];
  try {
    return fs
      .readdirSync(tenantsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      // Soft-deleted tenants (`<id>.deleted.<ts>`) are
      // archaeology, not active state.
      .filter((d) => !d.name.includes(".deleted."))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function listUsers(home: string, tenantId: string): string[] {
  // Users live under <tenant>/workspace/users/<userId>/ — same
  // shape getTenantUsersDir() resolves. Mirror that here directly
  // so this check stays sync-safe and avoids a circular import
  // with paths.ts (which transitively pulls in the env loader).
  const usersDir = path.join(
    home,
    "tenants",
    tenantId,
    "workspace",
    "users",
  );
  if (!fs.existsSync(usersDir)) return [];
  try {
    return fs
      .readdirSync(usersDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function safeLoadGlobalConfig(home: string) {
  try {
    return loadGlobalConfig(home);
  } catch {
    return {};
  }
}

function safeLoadTenantConfig(tenantId: string, home: string) {
  try {
    return loadTenantConfig(tenantId, home);
  } catch {
    return {};
  }
}

function mergePlugins(
  globalPlugins: PluginsConfig | undefined,
  tenantPlugins: PluginsConfig | undefined,
): PluginsConfig {
  return { ...(globalPlugins ?? {}), ...(tenantPlugins ?? {}) };
}
