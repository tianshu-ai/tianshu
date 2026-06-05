// Web-side plugin registry.
//
// Statically imports each builtin plugin's client module and maps
// `manifest.client.entry` strings to its `components` map. The chat
// shell calls `resolveComponent(entry, key)` when rendering whatever
// the manifest's `contributes` claims it has.
//
// Tenant-installed plugins (P2 / v1+) will land here too via dynamic
// `import()`. v0 only knows about builtins.
//
// If a manifest claims a `client.entry` we don't have in this map
// the host marks the plugin `state: "client-bundle-missing"` and the
// UI silently drops its contributions (per ADR-0003 §1).

import type { ComponentType } from "react";
import type {
  ComposerActionProps,
  PanelProps,
  PluginClientExports,
  SidebarSectionProps,
} from "@tianshu/plugin-sdk/client";

import filesPlugin from "@tianshu-builtin/plugin-files/client";

type AnyComponent = ComponentType<
  PanelProps | SidebarSectionProps | ComposerActionProps
>;

const ENTRIES: Record<string, PluginClientExports> = {
  "@tianshu-builtin/plugin-files/client": filesPlugin,
};

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
