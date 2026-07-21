// Manifest-label localization helper.
//
// Static contribution labels (topBarButton `tooltip`, rightPanel
// `displayName`, sidebarSection `displayName`, adminPage
// `displayName`) live inside each plugin's `manifest.json` as
// English defaults. Translating them by editing the manifest per
// locale isn't tenable (manifest.json is one file, structured
// data, not free-form). Instead we localize at the RENDER site:
// the host looks up a well-known key in the merged plugin locale
// dictionary and falls back to the manifest string when no
// translation exists.
//
// Key convention (SINGLE source of truth — kept in this file so
// plugin authors have one thing to grep for):
//
//     plugin.<pluginId>.manifest.<contribType>.<contribId>
//
// where `<contribType>` is the exact key from `manifest.contributes.*`:
//
//     topBarButtons      // localizes button `tooltip`
//     rightPanels        // localizes panel `displayName` (tab bar)
//     sidebarSections    // localizes section `displayName`
//     adminPages         // localizes admin nav `displayName`
//     composerActions    // localizes action `tooltip`
//
// Examples for the workboard plugin:
//
//     plugin.workboard.manifest.topBarButtons.toggle    → "Task board"
//     plugin.workboard.manifest.rightPanels.main        → "Tasks"
//     plugin.workboard.manifest.sidebarSections.workers → "Workers"
//     plugin.workboard.manifest.adminPages.agents       → "Worker agents"
//
// Plugin authors add these keys to their `locales/<lang>.json`
// using the SHORT form (no `plugin.<id>.` prefix), the same as
// component strings:
//
//     // plugins/workboard/locales/en.json
//     {
//       "manifest.topBarButtons.toggle": "Task board",
//       "manifest.rightPanels.main": "Tasks"
//     }
//
// Missing translations transparently fall back to the manifest's
// English default — unlocalized plugins continue to render.

import { useSyncExternalStore } from "react";
import { getLocale, subscribeLocale } from "./i18n";
import type { Locale } from "./i18n";
import { lookupPluginString } from "./plugin-locales";

export type ManifestLabelKind =
  | "topBarButtons"
  | "rightPanels"
  | "sidebarSections"
  | "adminPages"
  | "composerActions";

/**
 * Look up a translation for a manifest contribution label and
 * fall back to the manifest-provided default. Pure function —
 * takes the caller's already-known locale so a component using
 * this for many labels only subscribes once (via `useManifestLabel`).
 */
export function manifestLabelFor(
  locale: "en" | "zh",
  pluginId: string,
  kind: ManifestLabelKind,
  contribId: string,
  fallback: string | undefined,
): string {
  const key = `plugin.${pluginId}.manifest.${kind}.${contribId}`;
  const hit = lookupPluginString(locale, key);
  return hit ?? fallback ?? contribId;
}

/**
 * React hook wrapper. Subscribes to locale changes so any
 * component using it re-renders when the user flips the language.
 */
export function useManifestLabel(
  pluginId: string,
  kind: ManifestLabelKind,
  contribId: string,
  fallback: string | undefined,
): string {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return manifestLabelFor(locale, pluginId, kind, contribId, fallback);
}

// ─── plugin-level meta (displayName + description) ───────────
//
// The Plugin Manager lists each plugin's top-level `displayName` and
// `description` straight from the manifest (English defaults). Localize
// them the same way, via well-known keys the plugin author adds to
// their locales/<lang>.json (short form):
//
//     manifest.displayName
//     manifest.description
//
// Host prefixes with `plugin.<id>.`. Missing translations fall back to
// the manifest string, so unlocalized plugins render unchanged.

/** Returns a per-plugin resolver for the top-level displayName /
 *  description. Subscribes to locale once. */
export function usePluginMeta(
  pluginId: string,
): {
  displayName: (fallback: string) => string;
  description: (fallback: string | null) => string | null;
} {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return {
    displayName: (fallback: string) =>
      lookupPluginString(locale, `plugin.${pluginId}.manifest.displayName`) ??
      fallback,
    description: (fallback: string | null) =>
      lookupPluginString(locale, `plugin.${pluginId}.manifest.description`) ??
      fallback,
  };
}

// ─── configSchema field / group labels ──────────────────────
//
// The auto-generated plugin config form (PluginConfigForm) renders
// field labels / descriptions / placeholders / units, select option
// labels, and field-group titles straight from manifest.configSchema
// — all English defaults. We localize them at the render site using
// the same lookup-with-fallback pattern as contribution labels.
//
// Key convention (short form in the plugin's locales/<lang>.json):
//
//     manifest.config.<fieldKey>.label
//     manifest.config.<fieldKey>.description
//     manifest.config.<fieldKey>.placeholder
//     manifest.config.<fieldKey>.unit
//     manifest.config.<fieldKey>.option.<optionValue>
//     manifest.configGroups.<groupId>.label
//     manifest.configGroups.<groupId>.description
//     manifest.configGroups.<groupId>.badge
//
// The host prefixes each with `plugin.<id>.`. Missing translations
// fall back to the manifest string.

/** Returns a per-plugin resolver for config-form labels. The
 *  returned function takes a short key (e.g. `config.<fieldKey>.label`)
 *  plus the manifest fallback. */
export function useConfigLabels(
  pluginId: string,
): (shortKey: string, fallback: string | undefined) => string {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return (shortKey: string, fallback: string | undefined) =>
    configLabelFor(locale, pluginId, shortKey, fallback);
}

function configLabelFor(
  locale: Locale,
  pluginId: string,
  shortKey: string,
  fallback: string | undefined,
): string {
  const hit = lookupPluginString(
    locale,
    `plugin.${pluginId}.manifest.${shortKey}`,
  );
  return hit ?? fallback ?? "";
}
