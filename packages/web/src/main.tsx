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
  __installOpenFileApi,
  __installPluginConfigForm,
  __installUiPrimitives,
  __installUseComposer,
  __installUseTheme,
  type ThemeApi,
} from "@tianshu-ai/plugin-sdk/client";
import { getComposerApi } from "./stores/composer-store";
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
