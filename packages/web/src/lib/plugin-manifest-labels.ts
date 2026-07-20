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
