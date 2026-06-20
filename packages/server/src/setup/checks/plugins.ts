// Builtin-plugin manifest sanity check + per-tenant enablement.
//
// Two questions in one report:
//   1. Are the plugin manifests on disk shaped correctly?
//      (A baseline before the registry even tries to load them.)
//   2. For each tenant, which of those plugins are *enabled*
//      vs sitting installed-but-off?
//
// Why the second part exists: a user looking at "tianshu doctor"
// sees `✓ files / ✓ microsandbox / ✓ web-search / ✓ workboard`
// and reasonably concludes everything is on. Then they open the
// chat shell's Plugin Manager UI and find three of them disabled.
// The doctor's "✓" was about manifest shape (a developer concern)
// not user intent (the only thing the user cares about).
//
// We don't boot the registry from inside doctor — that would
// couple half the server to a read-only check. We just read each
// tenant's config.json and merge with the global config to figure
// out per-tenant enablement, exactly like resolveTenantConfig.

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

export interface PluginsCheckOpts {
  /** Override builtinConfig dir (test seam / monorepo dev override). */
  builtinConfigDir?: string;
  /** Override TIANSHU_HOME root for test isolation. */
  home?: string;
}

interface ManifestSummary {
  pluginId: string;
  name?: string;
  manifestPath: string;
}

export function checkPlugins(opts: PluginsCheckOpts = {}): CheckGroup {
  const lines: CheckGroup["lines"] = [];

  // --- Stage 1: discover manifests on disk. --------------------
  let dir: string;
  try {
    dir = opts.builtinConfigDir ?? getBuiltinConfigDir();
  } catch (err) {
    lines.push({
      severity: "warning",
      text: "builtinConfig dir not found",
      detail: err instanceof Error ? err.message : String(err),
    });
    return { title: "Builtin plugins", lines };
  }
  const pluginsRoot = path.join(dir, "plugins");
  if (!fs.existsSync(pluginsRoot)) {
    lines.push({
      severity: "warning",
      text: "no builtin plugins shipped",
      detail: `${pluginsRoot} doesn't exist; \`npm run sync:plugins\` may not have run yet.`,
    });
    return { title: "Builtin plugins", lines };
  }

  const manifests: ManifestSummary[] = [];
  for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(pluginsRoot, entry.name, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      lines.push({
        severity: "warning",
        text: `${entry.name}: manifest.json missing`,
        detail: manifestPath,
      });
      continue;
    }
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        id?: string;
        name?: string;
      };
      if (!m.id) {
        lines.push({
          severity: "warning",
          text: `${entry.name}: manifest missing \`id\``,
          detail: manifestPath,
        });
        continue;
      }
      manifests.push({
        pluginId: m.id,
        name: m.name && m.name !== m.id ? m.name : undefined,
        manifestPath,
      });
    } catch (err) {
      lines.push({
        severity: "warning",
        text: `${entry.name}: manifest unreadable`,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (manifests.length === 0) {
    lines.push({
      severity: "warning",
      text: "no valid plugin manifests found",
      detail: pluginsRoot,
    });
    return { title: "Builtin plugins", lines };
  }

  // --- Stage 2: per-tenant enablement. -------------------------
  // We resolve enablement in the same shape resolveTenantConfig
  // would: tenant overrides global, "not listed" = disabled, only
  // explicit `enabled: true` counts as on.
  const home = opts.home ?? getTianshuHome();
  const globalCfg = safeLoadGlobalConfig(home);
  const tenantIds = listTenants(home);

  // tenantIds may be empty (fresh install / pre-wizard). Surface
  // that explicitly rather than letting the section render blank.
  if (tenantIds.length === 0) {
    for (const m of manifests) {
      lines.push({
        severity: "ok",
        text: `${m.pluginId} (installed, no tenants yet)`,
        detail: m.name,
      });
    }
    return { title: "Builtin plugins", lines };
  }

  // Render one line per plugin summarising its enablement across
  // tenants. Most installs have one tenant ("default") so this
  // collapses to "enabled" / "disabled" — clean and honest.
  for (const m of manifests) {
    const enabledIn: string[] = [];
    const disabledIn: string[] = [];
    for (const t of tenantIds) {
      const tenantCfg = safeLoadTenantConfig(t, home);
      const merged = mergePlugins(globalCfg.plugins, tenantCfg.plugins);
      const entry = merged[m.pluginId];
      if (entry?.enabled === true) enabledIn.push(t);
      else disabledIn.push(t);
    }

    if (enabledIn.length === tenantIds.length) {
      lines.push({
        severity: "ok",
        text: `${m.pluginId} (enabled in all tenants)`,
        detail: m.name,
      });
    } else if (enabledIn.length === 0) {
      // Not a "warning" — disabled is a valid choice. We mark
      // it ok-but-info so it doesn't pollute the doctor tally.
      lines.push({
        severity: "ok",
        text: `${m.pluginId} (installed, disabled in all tenants)`,
        detail:
          m.name ??
          "Enable via Plugin Manager UI in the chat shell, or `tianshu` cli-agent's plugin_enable tool.",
      });
    } else {
      lines.push({
        severity: "ok",
        text: `${m.pluginId} (enabled: ${enabledIn.join(", ")} | disabled: ${disabledIn.join(", ")})`,
        detail: m.name,
      });
    }
  }

  return { title: "Builtin plugins", lines };
}

function listTenants(home: string): string[] {
  const tenantsDir = path.join(home, "tenants");
  if (!fs.existsSync(tenantsDir)) return [];
  try {
    return fs
      .readdirSync(tenantsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      // soft-deleted tenants (renamed to <id>.deleted.<ts>) shouldn't
      // show up in the report — they're trivially "off everywhere".
      .filter((d) => !d.name.includes(".deleted."))
      .map((d) => d.name);
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
    // A malformed tenant config shouldn't take the whole doctor
    // down. Return empty; the merge will treat the plugin as
    // unlisted (= disabled).
    return {};
  }
}

function mergePlugins(
  globalPlugins: PluginsConfig | undefined,
  tenantPlugins: PluginsConfig | undefined,
): PluginsConfig {
  return { ...(globalPlugins ?? {}), ...(tenantPlugins ?? {}) };
}
