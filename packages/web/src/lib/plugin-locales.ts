// Plugin locale registry.
//
// Sibling of `plugin-registry.ts`: same build-time discovery via
// `import.meta.glob`, but for `plugins/<id>/locales/{en,zh}.json`
// instead of manifests. Each plugin ships flat `{ key: text }`
// dictionaries; the host merges them into a global map keyed by
// `plugin.<id>.<key>` so `translate(fullKey)` on the host side can
// look up plugin-contributed strings the same way it looks up
// built-in ones.
//
// Why compile-time glob and not a runtime `/api/plugins/locales`
// endpoint: the manifests themselves already ride this path (see
// plugin-registry.ts). Reusing it keeps the web bundle in one
// piece — no waterfall fetch before plugin UI can render, no
// second source of truth to keep in sync with builtinConfig.
// Non-builtin (tenant-installed) plugins in a future PR can still
// layer a runtime loader on top of the same registerPluginLocales
// entrypoint.

import type { Locale } from "./i18n";

// Vite: relative from this file walks up out of packages/web/src/lib.
// `eager: true` inlines the JSON into the main bundle — dictionaries
// are tiny (a few KB each) and we need them synchronously on first
// render.
const localeModules = import.meta.glob<Record<string, string>>(
  "../../../../plugins/*/locales/*.json",
  { eager: true, import: "default" },
);

/** In-memory merged dictionary. Keys are FULL namespaced keys
 *  (`plugin.<id>.<original>`); values are the current-locale
 *  string. One map per supported locale. */
const merged: Record<Locale, Map<string, string>> = {
  en: new Map(),
  zh: new Map(),
};

const pluginLocalePathRe =
  /\/plugins\/([^/]+)\/locales\/([^/]+)\.json$/;

/**
 * Register a single plugin's locale bundle. Extracted so runtime
 * (non-builtin) plugin installs can call it later with fetched
 * JSON blobs; the boot path below calls it once per builtin.
 *
 * `keys` is the plugin-local map ({ "workers.title": "..." }).
 * Entries land in the global map under `plugin.<pluginId>.<key>`.
 * Passing an empty / undefined map clears the plugin's slice for
 * that locale — useful for hot-reload paths.
 */
export function registerPluginLocale(
  pluginId: string,
  locale: Locale,
  keys: Record<string, string> | undefined,
): void {
  const bucket = merged[locale];
  const prefix = `plugin.${pluginId}.`;
  // Drop any prior entries for this plugin so re-registration
  // doesn't leave stale keys behind.
  for (const k of bucket.keys()) {
    if (k.startsWith(prefix)) bucket.delete(k);
  }
  if (!keys) return;
  for (const [k, v] of Object.entries(keys)) {
    if (typeof v !== "string") continue;
    bucket.set(prefix + k, v);
  }
}

// Boot-time: walk the glob results and register every locale
// bundle Vite pulled in. Runs exactly once at module load; the
// merged maps stay live for the lifetime of the tab.
for (const [filePath, mod] of Object.entries(localeModules)) {
  const m = pluginLocalePathRe.exec(filePath);
  if (!m) continue;
  const pluginId = m[1]!;
  const lang = m[2]!;
  if (lang !== "en" && lang !== "zh") continue;
  registerPluginLocale(pluginId, lang, mod ?? {});
}

/**
 * Resolve a plugin-namespaced key against the merged dictionary
 * for `locale`. Falls back to English (matches the host's own
 * `translate` fallback chain) so a Chinese install that hasn't
 * translated a specific string still renders the English text
 * rather than the raw key. Returns `undefined` when the key isn't
 * known anywhere — callers layer their own fallback (raw key /
 * manifest default) on top.
 */
export function lookupPluginString(
  locale: Locale,
  fullKey: string,
): string | undefined {
  return merged[locale].get(fullKey) ?? merged.en.get(fullKey);
}

/**
 * Substitute `{param}` placeholders in `template` with values from
 * `params`. Missing keys are left as the literal `{name}` so a
 * silent typo shows up in the UI instead of an empty span.
 * Extracted for testing; the same shape ships in the host
 * `translate` helper.
 */
export function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) => {
    const v = params[name];
    return v === undefined || v === null ? whole : String(v);
  });
}
