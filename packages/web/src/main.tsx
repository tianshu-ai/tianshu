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

// Bootstrap fallback for OpenFileApi. The Files plugin's client
// overrides this at mount time with a dialog implementation; this
// fallback covers "Files plugin disabled / not yet mounted" and
// just opens the raw URL in a new tab so a click never does
// nothing.
__installOpenFileApi({
  open: (path: string): void => {
    const cleaned = path.replace(/^workspace:\/\/+/, "/");
    const url = `/api/p/files/raw?path=${encodeURIComponent(cleaned)}`;
    window.open(url, "_blank", "noopener");
  },
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
