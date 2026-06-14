import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Install the host-side `useComposer()` accessor exactly once at boot.
// Plugin client components import `useComposer` from the SDK; the SDK
// keeps a single accessor slot and we plug ours in here.
import {
  __installOpenFileApi,
  __installUseComposer,
} from "@tianshu/plugin-sdk/client";
import { getComposerApi } from "./stores/composer-store";
__installUseComposer(getComposerApi);

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
