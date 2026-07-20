import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyDevIdentityFromUrl } from "./dev-identity";
import { bootstrapTheme, useThemeStore } from "./stores/theme-store";

// Apply ?tenant=...&user=... before anything else loads. If the
// URL carries identity hints, this writes the cookie and reloads
// (so the new cookie is in effect on the second pass). On a
// no-hints load it returns immediately.
applyDevIdentityFromUrl();

// Read the persisted theme preference and paint the html
// data-theme attribute BEFORE React mounts so the first frame
// is already in the right colors (no flash-of-wrong-theme).
bootstrapTheme();

// Install the host-side `useComposer()` accessor exactly once at boot.
// Plugin client components import `useComposer` from the SDK; the SDK
// keeps a single accessor slot and we plug ours in here.
import {
  __installChatNav,
  __installOpenFileApi,
  __installPluginConfigForm,
  __installUiPrimitives,
  __installUseComposer,
  __installUseLocale,
  __installUseTheme,
  __installWsEventApi,
  type ChatNavApi,
  type LocaleApi,
  type ThemeApi,
} from "@tianshu-ai/plugin-sdk/client";
import { useChatStore } from "./stores/chat-store";
import { tianshuWs } from "./lib/ws";
import { getComposerApi } from "./stores/composer-store";
import { useSyncExternalStore } from "react";
import {
  getLocale,
  subscribeLocale,
  translate,
  type TranslationKey,
} from "./lib/i18n";
import {
  interpolate,
  lookupPluginString,
} from "./lib/plugin-locales";
import { PluginConfigFormById } from "./components/PluginConfigForm";
import { Modal } from "./components/ui/Modal";
import { MarkdownBlock } from "./components/ui/MarkdownBlock";
import { DocumentViewer } from "./components/ui/DocumentViewer";
__installUseComposer(getComposerApi);
// Plugins import `PluginConfigForm` from the SDK to fold the
// host's auto-generated config form into their own admin pages.
// Same install-once trick as useComposer / OpenFileApi.
__installPluginConfigForm(PluginConfigFormById);
// Shared UI primitives (Modal / MarkdownBlock / DocumentViewer)
// every plugin and the chat shell render through. Install before
// App mounts so the first render already has a live registry.
__installUiPrimitives({ Modal, MarkdownBlock, DocumentViewer });
// Theme hook for plugins. The closure runs every render of a
// component that calls `useTheme()`, so the zustand selector
// inside subscribes to mode + resolved changes and re-renders the
// consumer when the user flips the theme.
__installUseTheme((): ThemeApi => {
  const mode = useThemeStore((s) => s.mode);
  const resolved = useThemeStore((s) => s.resolved);
  const setMode = useThemeStore((s) => s.setMode);
  return { mode, resolved, setMode };
});
// Locale hook for plugins. Same install-once trick as useTheme:
// the closure runs on every render of a component that calls
// `useLocale()`, so subscribing to the locale store inside
// re-renders the consumer when the user flips the language.
//
// The installed `t(fullKey, params?)`:
//   1. Looks up plugin-namespaced keys ("plugin.<id>.<k>") in the
//      merged plugin dictionary (see lib/plugin-locales).
//   2. Falls back to the host's own dictionary via `translate()`
//      for the small set of host UI strings (`auth.signOut` etc.)
//      — same lookup surface, plugins never need to know which
//      dictionary a key came from.
//   3. Returns the raw key when nothing matches, matching the
//      host's own translate() fallback shape.
// `{param}` placeholders are interpolated after lookup.
__installUseLocale((): LocaleApi => {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return {
    locale,
    t: (key: string, params?: Record<string, string | number>): string => {
      // Plugin-namespaced keys go through the merged dictionary
      // first. `lookupPluginString` already falls back to `en`
      // when the active locale has no entry.
      const pluginHit = key.startsWith("plugin.")
        ? lookupPluginString(locale, key)
        : undefined;
      // Fall back to the host's built-in dictionary for host UI
      // strings sharing the same `t`. `translate` narrowly types
      // its input; the cast is safe because unknown keys hit its
      // own fallback chain (returns the raw key).
      const resolved =
        pluginHit ?? translate(key as TranslationKey);
      return interpolate(resolved, params);
    },
  };
});

// Chat navigation hook for plugins (e.g. channel plugins' sidebar
// sections). Subscribes to viewingSessionId so consumers re-render
// when selection changes.
__installChatNav((): ChatNavApi => {
  const viewingSessionId = useChatStore((s) => s.viewingSessionId);
  const setViewingSession = useChatStore((s) => s.selectSession);
  const sendPrompt = useChatStore((s) => s.sendPrompt);
  return { viewingSessionId, setViewingSession, sendPrompt };
});
// WebSocket subscribe surface for plugins. Bridges plugin SDK's
// subscribeToWsEvent to the host's tianshuWs.on(...) singleton so
// plugin code never reaches into the host's app layer.
__installWsEventApi({
  subscribe: (type, handler) => {
    // tianshuWs.on returns the off() function; plugins just
    // bubble it back to React effect cleanup.
    return (
      tianshuWs.on(type as never, handler as never) ?? (() => {})
    );
  },
  // Let plugins push a message up to the host (e.g. board_act
  // panels replying to a server-initiated op request).
  send: (msg) => tianshuWs.send(msg),
});

// Bootstrap fallback for OpenFileApi.
//
// Subtle ordering note: `import App from "./App"` above transitively
// pulls in the plugin registry, which uses `import.meta.glob({
// eager: true })` to inline every plugin's client bundle. Those
// bundles have already executed their module-top-level
// `__installOpenFileApi(...)` calls by the time we get here.
// Always overwriting the slot would silently revert the Files
// plugin's dialog implementation back to a window.open. So:
// only install if nothing else has — the fallback is a true
// bottom-of-stack handler.
{
  type Slot = { __tianshuPluginSdkOpenFile__?: unknown };
  const slot = globalThis as Slot;
  if (!slot.__tianshuPluginSdkOpenFile__) {
    __installOpenFileApi({
      open: (path: string): void => {
        const cleaned = path.replace(/^workspace:\/\/+/, "/");
        const url = `/api/p/files/raw?path=${encodeURIComponent(cleaned)}`;
        window.open(url, "_blank", "noopener");
      },
    });
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
