import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Install the host-side `useComposer()` accessor exactly once at boot.
// Plugin client components import `useComposer` from the SDK; the SDK
// keeps a single accessor slot and we plug ours in here.
import { __installUseComposer } from "@tianshu/plugin-sdk/client";
import { getComposerApi } from "./stores/composer-store";
__installUseComposer(getComposerApi);

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
