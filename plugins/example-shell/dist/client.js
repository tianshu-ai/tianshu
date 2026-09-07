import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect, useCallback } from "react";
import { Eye, EyeOff, ExternalLink, Paintbrush, Upload, RefreshCw, FileCode, CheckCircle } from "lucide-react";

const PLUGIN_ID = "example-shell";
const API = "/api";
const SHELL_API = `${API}/p/${PLUGIN_ID}`;

function ShellPreviewPanel(_props) {
  const [plugins, setPlugins] = useState(null);
  const [shellActive, setShellActive] = useState(false);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState(null);
  const [previewKey, setPreviewKey] = useState(0);

  const loadStatus = useCallback(async () => {
    try {
      const [pluginsRes, statusRes] = await Promise.all([
        fetch(`${API}/plugins`, { credentials: "include" }).then(r => r.json()),
        fetch(`${SHELL_API}/status`, { credentials: "include" }).then(r => r.ok ? r.json() : null),
      ]);
      const list = pluginsRes.plugins || pluginsRes;
      setPlugins(list);
      const shell = list.find((p) => p.id === PLUGIN_ID);
      setShellActive(shell?.state === "active");
      setStatus(statusRes);
    } catch (e) {
      console.error("ShellPreviewPanel:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  async function toggleShell() {
    setToggling(true);
    try {
      await fetch(`${API}/plugins/${PLUGIN_ID}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !shellActive }),
      });
      await loadStatus();
    } finally { setToggling(false); }
  }

  async function publishShell() {
    setPublishing(true);
    setPublishResult(null);
    try {
      const res = await fetch(`${SHELL_API}/publish`, {
        method: "POST", credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        setPublishResult({ ok: true, files: data.files });
        await loadStatus();
      } else {
        setPublishResult({ ok: false, error: data.message || data.error });
      }
    } catch (e) {
      setPublishResult({ ok: false, error: String(e) });
    } finally { setPublishing(false); }
  }

  if (loading) {
    return _jsx("div", {
      className: "flex h-full items-center justify-center text-fg-fainter text-xs",
      children: "Loading...",
    });
  }

  const activePlugins = (plugins || []).filter((p) => p.state === "active");
  const hasDraft = status?.draft?.exists;
  const hasPublished = status?.published?.exists;

  return _jsxs("div", {
    className: "flex flex-col h-full overflow-y-auto text-sm",
    children: [
      // Header
      _jsxs("div", {
        className: "border-b border-border-subtle px-3 py-2 flex items-center gap-2",
        children: [
          _jsx(Paintbrush, { size: 14, className: "text-fg-muted" }),
          _jsx("span", { className: "text-xs font-medium text-fg-default", children: "Custom UI Shell" }),
          _jsx("div", { className: "ml-auto" }),
          _jsx("button", {
            onClick: () => { loadStatus(); setPreviewKey(k => k + 1); },
            className: "rounded p-1 text-fg-faint hover:text-fg-default hover:bg-bg-hover transition-colors",
            title: "Refresh",
            children: _jsx(RefreshCw, { size: 12 }),
          }),
        ],
      }),

      // Status cards
      _jsxs("div", {
        className: "mx-3 mt-3 space-y-2",
        children: [
          // Draft status
          _jsxs("div", {
            className: `rounded-lg border p-3 ${hasDraft ? "border-blue-500/30 bg-blue-500/5" : "border-border-subtle bg-bg-surface"}`,
            children: [
              _jsxs("div", {
                className: "flex items-center gap-2 mb-1",
                children: [
                  _jsx(FileCode, { size: 13, className: hasDraft ? "text-blue-400" : "text-fg-faint" }),
                  _jsx("span", { className: "text-xs font-medium", children: "Draft" }),
                  hasDraft && _jsx("span", {
                    className: "ml-auto text-[10px] text-blue-400",
                    children: `${status.draft.files.length} file${status.draft.files.length > 1 ? "s" : ""}`,
                  }),
                ],
              }),
              _jsx("p", {
                className: "text-[11px] text-fg-muted leading-relaxed",
                children: hasDraft
                  ? "Agent has written a shell draft. Preview it below, then publish to go live."
                  : "No draft yet. Ask the agent to build a custom UI — it will write to _tenant/shell/.",
              }),
              hasDraft && _jsx("div", {
                className: "mt-2 space-y-0.5",
                children: status.draft.files.map(f =>
                  _jsxs("div", {
                    className: "flex items-center text-[10px] text-fg-faint font-mono",
                    children: [
                      _jsx("span", { children: f.path }),
                      _jsx("span", { className: "ml-auto", children: formatSize(f.size) }),
                    ],
                  }, f.path)
                ),
              }),
            ],
          }),

          // Published status
          _jsxs("div", {
            className: `rounded-lg border p-3 ${hasPublished ? "border-green-500/30 bg-green-500/5" : "border-border-subtle bg-bg-surface"}`,
            children: [
              _jsxs("div", {
                className: "flex items-center gap-2 mb-1",
                children: [
                  _jsx(CheckCircle, { size: 13, className: hasPublished ? "text-green-400" : "text-fg-faint" }),
                  _jsx("span", { className: "text-xs font-medium", children: "Published" }),
                  hasPublished && _jsx("span", {
                    className: "ml-auto text-[10px] text-green-400",
                    children: `${status.published.files.length} file${status.published.files.length > 1 ? "s" : ""}`,
                  }),
                ],
              }),
              _jsx("p", {
                className: "text-[11px] text-fg-muted leading-relaxed",
                children: hasPublished
                  ? "Custom shell is live for all users of this tenant."
                  : "No published shell yet. Publish a draft to replace the default UI.",
              }),
            ],
          }),
        ],
      }),

      // Preview iframe (draft)
      hasDraft && _jsxs("div", {
        className: "mx-3 mt-3",
        children: [
          _jsx("div", {
            className: "text-[11px] font-medium text-fg-muted mb-1.5",
            children: "Draft Preview",
          }),
          _jsx("div", {
            className: "rounded-lg border border-border-subtle overflow-hidden bg-white",
            style: { height: "240px" },
            children: _jsx("iframe", {
              src: `${SHELL_API}/preview`,
              title: "Shell Preview",
              sandbox: "allow-scripts allow-forms allow-same-origin",
              className: "w-full h-full border-0",
              style: { transform: "scale(0.5)", transformOrigin: "top left", width: "200%", height: "200%" },
            }, previewKey),
          }),
        ],
      }),

      // Actions
      _jsxs("div", {
        className: "mx-3 mt-3 space-y-2",
        children: [
          // Publish button
          hasDraft && _jsxs("button", {
            onClick: publishShell,
            disabled: publishing,
            className: "w-full flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/20 transition-colors disabled:opacity-50",
            children: [
              _jsx(Upload, { size: 13 }),
              publishing ? "Publishing..." : "Publish Draft → Go Live",
            ],
          }),

          // Publish result
          publishResult && _jsx("div", {
            className: `rounded-lg px-3 py-2 text-[11px] ${publishResult.ok ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`,
            children: publishResult.ok
              ? `✓ Published ${publishResult.files.length} files. Refresh the shell URL to see changes.`
              : `✗ ${publishResult.error}`,
          }),

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
        ],
      }),

      // Available APIs
      _jsxs("div", {
        className: "mx-3 mt-3 rounded-lg border border-border-subtle bg-bg-surface p-3",
        children: [
          _jsx("div", {
            className: "text-[11px] font-medium text-fg-muted mb-2",
            children: "Available APIs for custom UI",
          }),
          _jsx("div", { className: "flex flex-wrap gap-1", children:
            ["chat/ws", "auth", ...activePlugins.map(p => p.id).filter(id => id !== PLUGIN_ID)].map((id) =>
              _jsx("span", {
                className: "inline-block rounded-md bg-bg-raised px-1.5 py-0.5 text-[10px] text-fg-muted",
                children: id,
              }, id)
            ),
          }),
        ],
      }),

      // Help text
      _jsx("div", {
        className: "mx-3 mt-3 mb-3 text-[10px] text-fg-fainter leading-relaxed",
        children: "Workflow: Agent writes draft → preview here → publish to go live. Each tenant has its own shell.",
      }),
    ],
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

const exports = {
  components: { ShellPreviewPanel },
};
export default exports;
