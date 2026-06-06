// Web-side plugin registry.
//
// ADR-0004 §15: builtin client modules are collected from the repo's
// top-level `plugins/<id>/dist/client.js` via Vite's compile-time
// `import.meta.glob`. The mapping from `manifest.client.entry` →
// module is read from each plugin's manifest.json. Adding a new
// builtin = drop a directory; no edit to this file.
//
// Tenant-installed plugins (P2 / v1+) will land here too via dynamic
// `import()`. v0 only knows about builtins.
//
// If a manifest claims a `client.entry` we don't have in this map
// the host marks the plugin `state: "client-bundle-missing"` and the
// UI silently drops its contributions (per ADR-0003 §1).
//
// Why globs and not `import "@tianshu-builtin/..."`: hard-coded
// imports forced us to edit this file every time a new plugin
// landed. The glob path is relative to this file at build time, so
// the build still has full static analysis (tree-shaking,
// type-checking) — we just don't enumerate plugins by hand.

import type { ComponentType } from "react";
import type {
  AttachmentRendererProps,
  ComposerActionProps,
  PanelProps,
  PluginClientExports,
  SidebarSectionProps,
} from "@tianshu/plugin-sdk/client";

type AnyComponent = ComponentType<
  | PanelProps
  | SidebarSectionProps
  | ComposerActionProps
  | AttachmentRendererProps
>;

interface BuiltinManifestShape {
  id: string;
  client?: { entry?: string };
}

// Vite resolves these at build time. The path is relative to this
// file; `../../../../plugins/*/...` walks up out of `packages/web/src/lib`.
//
// `eager: true` inlines the modules into the main bundle — for v0
// builtins this is what we want. v1+ tenant plugins will use a
// separate `import.meta.glob(..., { eager: false })` that returns
// loader functions for code splitting.
const manifestModules = import.meta.glob<BuiltinManifestShape>(
  "../../../../plugins/*/manifest.json",
  { eager: true, import: "default" },
);
const clientModules = import.meta.glob<PluginClientExports>(
  "../../../../plugins/*/dist/client.js",
  { eager: true, import: "default" },
);

const ENTRIES: Record<string, PluginClientExports> = (() => {
  const map: Record<string, PluginClientExports> = {};
  // Key shape from glob: "../../../../plugins/files/manifest.json" →
  // pluginId "files". Pair manifest with the matching dist/client.js
  // glob entry.
  const pluginIdRe = /\/plugins\/([^/]+)\/manifest\.json$/;
  const distIdRe = /\/plugins\/([^/]+)\/dist\/client\.js$/;
  const clientByPluginId = new Map<string, PluginClientExports>();
  for (const [filePath, mod] of Object.entries(clientModules)) {
    const m = distIdRe.exec(filePath);
    if (m) clientByPluginId.set(m[1]!, mod);
  }
  for (const [filePath, manifest] of Object.entries(manifestModules)) {
    const m = pluginIdRe.exec(filePath);
    if (!m) continue;
    const pluginId = m[1]!;
    const entry = manifest?.client?.entry;
    if (!entry) continue;
    const mod = clientByPluginId.get(pluginId);
    if (!mod) continue;
    map[entry] = mod;
  }
  return map;
})();

/** Look up a component by `(client.entry, contributes.*.component)`. */
export function resolveComponent(
  entry: string | null | undefined,
  componentKey: string,
): AnyComponent | null {
  if (!entry) return null;
  const mod = ENTRIES[entry];
  if (!mod) return null;
  return mod.components[componentKey] ?? null;
}

/** Returns true if the host bundle has the plugin's client module. */
export function hasClientBundle(entry: string | null | undefined): boolean {
  if (!entry) return false;
  return ENTRIES[entry] !== undefined;
}
