import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect } from "react";
import { Eye, EyeOff, ExternalLink, Monitor, Palette } from "lucide-react";

const PLUGIN_ID = "example-shell";
const API = "/api";

function ShellPreviewPanel(_props) {
  const [plugins, setPlugins] = useState(null);
  const [shellActive, setShellActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");

  useEffect(() => {
    loadStatus();
  }, []);

  async function loadStatus() {
    try {
      const res = await fetch(`${API}/plugins`, { credentials: "include" });
      const data = await res.json();
      const list = data.plugins || data;
      setPlugins(list);
      const shell = list.find((p) => p.id === PLUGIN_ID);
      setShellActive(shell?.state === "active");
      // Build preview URL from current location
      const m = location.pathname.match(/\/tenants\/([^/]+)\/users\/([^/]+)/);
      if (m) {
        const port = 3110; // server port in dev mode
        setPreviewUrl(`${location.protocol}//${location.hostname}:${port}/tenants/${m[1]}/users/${m[2]}/`);
      }
    } catch (e) {
      console.error("ShellPreviewPanel:", e);
    } finally {
      setLoading(false);
    }
  }

  async function toggleShell() {
    setToggling(true);
    try {
      await fetch(`${API}/plugins/${PLUGIN_ID}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !shellActive }),
      });
      await loadStatus();
    } catch (e) {
      console.error("toggleShell:", e);
    } finally {
      setToggling(false);
    }
  }

  if (loading) {
    return _jsx("div", {
      className: "flex h-full items-center justify-center text-fg-fainter text-xs",
      children: "Loading...",
    });
  }

  // Count active plugins for context
  const activePlugins = (plugins || []).filter((p) => p.state === "active");

  return _jsxs("div", {
    className: "flex flex-col h-full overflow-y-auto text-sm",
    children: [
      // Header
      _jsxs("div", {
        className: "border-b border-border-subtle px-3 py-2 flex items-center gap-2",
        children: [
          _jsx(Palette, { size: 14, className: "text-fg-muted" }),
          _jsx("span", { className: "text-xs font-medium text-fg-default", children: "Custom UI Shell" }),
        ],
      }),

      // Status card
      _jsxs("div", {
        className: "mx-3 mt-3 rounded-lg border border-border-subtle bg-bg-surface p-3",
        children: [
          _jsxs("div", {
            className: "flex items-center gap-2 mb-2",
            children: [
              _jsx("div", {
                className: `w-2 h-2 rounded-full ${shellActive ? "bg-green-500" : "bg-gray-500"}`,
              }),
              _jsx("span", {
                className: "text-xs font-medium",
                children: shellActive ? "Shell Active" : "Shell Inactive",
              }),
            ],
          }),
          _jsx("p", {
            className: "text-[11px] text-fg-muted leading-relaxed",
            children: shellActive
              ? "The custom UI shell is active. Users accessing this tenant via the server port will see the custom frontend instead of the default chat UI."
              : "Enable the shell to replace the default UI with a custom frontend for this tenant. The default chat UI (this page) remains accessible on the dev port.",
          }),
        ],
      }),

      // Environment info
      _jsxs("div", {
        className: "mx-3 mt-2 rounded-lg border border-border-subtle bg-bg-surface p-3",
        children: [
          _jsx("div", {
            className: "text-[11px] font-medium text-fg-muted mb-2",
            children: "Environment",
          }),
          _jsxs("div", { className: "space-y-1.5 text-[11px]", children: [
            _jsxs("div", { className: "flex justify-between", children: [
              _jsx("span", { className: "text-fg-faint", children: "Active plugins" }),
              _jsx("span", { className: "text-fg-default font-mono", children: String(activePlugins.length) }),
            ]}),
            _jsxs("div", { className: "flex justify-between", children: [
              _jsx("span", { className: "text-fg-faint", children: "Shell plugin" }),
              _jsx("span", {
                className: `font-mono ${shellActive ? "text-green-400" : "text-fg-muted"}`,
                children: shellActive ? "enabled" : "disabled",
              }),
            ]}),
            previewUrl && _jsxs("div", { className: "flex justify-between", children: [
              _jsx("span", { className: "text-fg-faint", children: "Preview URL" }),
              _jsx("span", {
                className: "text-fg-muted font-mono text-[10px] truncate max-w-[140px]",
                title: previewUrl,
                children: `:${new URL(previewUrl).port}`,
              }),
            ]}),
          ]}),
        ],
      }),

      // Available capabilities
      _jsxs("div", {
        className: "mx-3 mt-2 rounded-lg border border-border-subtle bg-bg-surface p-3",
        children: [
          _jsx("div", {
            className: "text-[11px] font-medium text-fg-muted mb-2",
            children: "Available APIs for custom UI",
          }),
          _jsx("div", { className: "flex flex-wrap gap-1", children:
            ["chat/ws", "auth", ...activePlugins.map(p => p.id)].map((id) =>
              _jsx("span", {
                className: "inline-block rounded-md bg-bg-raised px-1.5 py-0.5 text-[10px] text-fg-muted",
                children: id,
              }, id)
            ),
          }),
        ],
      }),

      // Actions
      _jsxs("div", {
        className: "mx-3 mt-3 space-y-2",
        children: [
          // Toggle button
          _jsxs("button", {
            onClick: toggleShell,
            disabled: toggling,
            className: `w-full flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
              shellActive
                ? "bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20"
                : "bg-green-500/10 text-green-400 hover:bg-green-500/20 border border-green-500/20"
            } disabled:opacity-50`,
            children: [
              shellActive ? _jsx(EyeOff, { size: 13 }) : _jsx(Eye, { size: 13 }),
              toggling ? "Updating..." : shellActive ? "Disable Shell" : "Enable Shell",
            ],
          }),

          // Preview link (only when shell is active)
          shellActive && previewUrl && _jsxs("a", {
            href: previewUrl,
            target: "_blank",
            rel: "noopener",
            className: "w-full flex items-center justify-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-xs font-medium text-fg-muted hover:bg-bg-hover transition-colors",
            children: [
              _jsx(ExternalLink, { size: 13 }),
              "Open Shell Preview",
            ],
          }),
        ],
      }),

      // Help text
      _jsx("div", {
        className: "mx-3 mt-3 mb-3 text-[10px] text-fg-fainter leading-relaxed",
        children: "The shell replaces the frontend on the server port. Ask the agent to build a custom UI — it knows all available APIs and can write the shell HTML directly.",
      }),
    ],
  });
}

const exports = {
  components: { ShellPreviewPanel },
};
export default exports;
