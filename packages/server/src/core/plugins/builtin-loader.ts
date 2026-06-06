// File-scan loader for builtin server modules (ADR-0004 §15).
//
// Replaces the hand-maintained `moduleMapResolver({...})` in index.ts.
// The discovery walk reads `<plugins-root>/<id>/manifest.json`,
// resolves each plugin's `server.entry` to a real ESM module by
// looking up the matching `<plugins-root>/<id>/dist/server.js` file
// (or whatever `package.json#exports['./server']` says, if a more
// elaborate package layout is needed later).
//
// What this is NOT:
// - A third-party plugin runtime. The scan is restricted to a known
//   `pluginsRoot` directory the host operator chose. Catalog-installed
//   tenant plugins still go through the dynamic-import path that v1+
//   will add separately.
// - A hot-reloader. ESM module cache is per-URL; toggling enabled →
//   disabled → enabled re-uses the same module. v0 doesn't try to
//   evict cached modules — restart the server to pick up code changes
//   in a builtin's `dist/`.
//
// Failure modes are non-fatal: a bad manifest, missing dist file, or
// missing `default` export logs a warning and is skipped. The plugin
// will then surface as `state: "failed"` via the registry's normal
// "server.entry not registered" path, which the Plugin Manager UI
// already renders.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginServerModule } from "@tianshu/plugin-sdk";
import { moduleMapResolver, type ServerPluginModuleResolver } from "./registry.js";

/**
 * Resolver that can re-scan the builtins directory on demand. The
 * registry holds onto a single resolver across the server's
 * lifetime; without re-scan support, dropping a new plugin
 * directory at runtime would never be picked up because the
 * resolver's module map is fixed at server boot.
 *
 * `reload()` is what `POST /api/plugins/refresh` calls (alongside
 * the registry's per-tenant invalidate) so adding a builtin = drop
 * a directory + run sync:plugins + click Refresh.
 */
export interface ReloadingResolver {
  resolve(entry: string): Promise<import("@tianshu/plugin-sdk").PluginServerModule | null>;
  reload(): Promise<void>;
}

export interface BuiltinLoaderOpts {
  /**
   * Directory to scan. Each subdirectory is a plugin (must contain
   * `manifest.json`). Conventionally this is the repo's top-level
   * `plugins/` (where source lives) — `dist/` paths are derived from
   * each manifest's location. Pre-build (`npm run build` at the repo
   * root) is required before this resolver works in production.
   */
  pluginsRoot: string;
  /**
   * Optional log sink. Defaults to console. Tests pass a noop / spy.
   */
  log?: (level: "info" | "warn", msg: string) => void;
}

/**
 * Build a {@link ServerPluginModuleResolver} by scanning `pluginsRoot`,
 * loading each plugin's compiled server module, and mapping the
 * `manifest.server.entry` string → module.
 *
 * Async because module loading uses dynamic `import()`. Call this
 * once at server boot and reuse the resolver for the registry.
 *
 * For dev / catalog-install scenarios where a new plugin directory
 * appears after server boot, prefer {@link buildReloadingBuiltinResolver}
 * which exposes a `reload()` method that re-scans on demand.
 */
export async function buildBuiltinResolver(
  opts: BuiltinLoaderOpts,
): Promise<ServerPluginModuleResolver> {
  const map = await scanPlugins(opts);
  return moduleMapResolver(map);
}

/**
 * Like {@link buildBuiltinResolver} but the returned resolver has a
 * `reload()` method that re-scans the plugins directory and
 * replaces its internal module map. Used by
 * `POST /api/plugins/refresh`.
 *
 * Modules already imported by Node's ESM cache are reused on reload
 * (same URL = same module). Dropped plugins are removed from the
 * map but the underlying module objects stay live in the ESM cache;
 * v0 doesn't try to evict them.
 */
export async function buildReloadingBuiltinResolver(
  opts: BuiltinLoaderOpts,
): Promise<ReloadingResolver> {
  let map = await scanPlugins(opts);
  return {
    async resolve(entry: string) {
      return map[entry] ?? null;
    },
    async reload() {
      map = await scanPlugins(opts);
    },
  };
}

async function scanPlugins(
  opts: BuiltinLoaderOpts,
): Promise<Record<string, PluginServerModule>> {
  const log = opts.log ?? defaultLog;
  const map: Record<string, PluginServerModule> = {};

  if (!fs.existsSync(opts.pluginsRoot)) {
    log("info", `[builtin-loader] no plugins dir at ${opts.pluginsRoot}; nothing to load`);
    return map;
  }

  const ids = fs
    .readdirSync(opts.pluginsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
    .map((d) => d.name)
    .sort();

  for (const id of ids) {
    const pluginDir = path.join(opts.pluginsRoot, id);
    const manifestPath = path.join(pluginDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;

    let manifest: { id?: unknown; server?: { entry?: unknown } };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (err) {
      log("warn", `[builtin-loader] ${id}: bad manifest.json (${describe(err)})`);
      continue;
    }

    const serverEntry = manifest.server?.entry;
    if (typeof serverEntry !== "string" || serverEntry.length === 0) {
      // Client-only plugin — nothing to register on the server side.
      continue;
    }

    const distFile = path.join(pluginDir, "dist", "server.js");
    if (!fs.existsSync(distFile)) {
      log(
        "warn",
        `[builtin-loader] ${id}: ${distFile} missing — run \`npm run build\` to compile builtin plugins`,
      );
      continue;
    }

    let mod: PluginServerModule | null = null;
    try {
      const imported = (await import(pathToFileURL(distFile).href)) as
        | { default?: PluginServerModule }
        | PluginServerModule;
      mod =
        "activate" in imported && typeof imported.activate === "function"
          ? (imported as PluginServerModule)
          : "default" in imported && imported.default
            ? imported.default
            : null;
    } catch (err) {
      log("warn", `[builtin-loader] ${id}: failed to import ${distFile} (${describe(err)})`);
      continue;
    }

    if (!mod || typeof mod.activate !== "function") {
      log(
        "warn",
        `[builtin-loader] ${id}: ${distFile} did not export an activate() — skipping`,
      );
      continue;
    }

    if (map[serverEntry]) {
      log(
        "warn",
        `[builtin-loader] ${id}: server.entry "${serverEntry}" already registered by another plugin — skipping`,
      );
      continue;
    }

    map[serverEntry] = mod;
    log("info", `[builtin-loader] loaded ${id} → ${serverEntry}`);
  }

  return map;
}

function defaultLog(level: "info" | "warn", msg: string): void {
  if (level === "info") {
    // eslint-disable-next-line no-console
    console.log(msg);
  } else {
    // eslint-disable-next-line no-console
    console.warn(msg);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
