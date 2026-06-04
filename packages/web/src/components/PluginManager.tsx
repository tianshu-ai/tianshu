// Plugin Manager — bundled chat-shell affordance (not itself a plugin).
//
// Lists every plugin discovered for the current tenant (builtin +
// tenant overrides), shows source / version / state / failure reason,
// and lets the user toggle enabled per plugin.
//
// Mutations go through `PATCH /api/plugins/:id`, which persists
// `<tenant>/config.json` and re-runs discovery + activation. The
// response payload is the fresh full list, so this component stays
// trivially in sync without polling.
//
// Per ADR-0003 §1, "not installed" must mean "not visible". This UI
// therefore only ever shows plugins whose manifest is on disk —
// builtin or tenant override. There is no "marketplace" or "available
// to install" tab in v0.

import { useEffect, useState } from "react";
import { Loader2, Puzzle, X, AlertTriangle, CheckCircle2, Pause } from "lucide-react";
import { api, type PluginListEntry, type PluginState } from "../lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function PluginManager({ open, onClose }: Props) {
  const [plugins, setPlugins] = useState<PluginListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setPlugins(null);
    api
      .plugins()
      .then((r) => {
        if (cancelled) return;
        setPlugins(r.plugins);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // ESC closes; trap on the modal layer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function toggle(p: PluginListEntry) {
    const next = p.state !== "active";
    setPendingId(p.id);
    setError(null);
    try {
      const r = await api.setPluginEnabled(p.id, next);
      setPlugins(r.plugins);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="plugin-manager-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-gray-700 bg-gray-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-5 py-3">
          <div className="flex items-center gap-2">
            <Puzzle size={16} className="text-brand-400" />
            <h2 id="plugin-manager-title" className="text-sm font-semibold text-gray-100">
              Plugin Manager
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost p-1.5"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-3 rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
              {error}
            </div>
          )}

          {plugins === null && !error && (
            <div className="flex items-center justify-center py-10 text-sm text-gray-500">
              <Loader2 size={14} className="mr-2 animate-spin" />
              Loading…
            </div>
          )}

          {plugins !== null && plugins.length === 0 && (
            <div className="py-10 text-center text-sm text-gray-500">
              No plugins discovered for this tenant.
              <p className="mt-2 text-xs text-gray-600">
                Builtin plugins ship under{" "}
                <code className="rounded bg-gray-800 px-1 text-gray-400">
                  packages/server/builtinConfig/plugins/
                </code>
                . Tenant plugins live at{" "}
                <code className="rounded bg-gray-800 px-1 text-gray-400">
                  &lt;tenant&gt;/_tenant/config/plugins/
                </code>
                .
              </p>
            </div>
          )}

          {plugins !== null && plugins.length > 0 && (
            <ul className="space-y-2">
              {plugins.map((p) => (
                <li
                  key={p.id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900/50 p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-gray-100">
                        {p.displayName}
                      </span>
                      <code className="rounded bg-gray-800 px-1 py-0.5 text-[10px] text-gray-400">
                        {p.id}
                      </code>
                      <span className="text-[10px] text-gray-600">v{p.version}</span>
                      <SourceBadge source={p.source} />
                      <StateBadge state={p.state} />
                    </div>
                    {p.description && (
                      <p className="mt-1 text-xs text-gray-400">{p.description}</p>
                    )}
                    {p.failedReason && (
                      <div className="mt-1 flex items-start gap-1 text-[11px] text-rose-300">
                        <AlertTriangle size={11} className="mt-px flex-shrink-0" />
                        <span className="break-all">{p.failedReason}</span>
                      </div>
                    )}
                  </div>
                  <Toggle
                    active={p.state === "active"}
                    pending={pendingId === p.id}
                    disabled={p.state === "failed" || p.state === "client-bundle-missing"}
                    onClick={() => toggle(p)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-800 px-5 py-3 text-[11px] leading-relaxed text-gray-500">
          Changes persist to{" "}
          <code className="rounded bg-gray-800 px-1 text-gray-400">
            &lt;tenant&gt;/config.json
          </code>{" "}
          and take effect immediately for new requests.
        </div>
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: PluginListEntry["source"] }) {
  const cls =
    source === "builtin"
      ? "bg-gray-800 text-gray-400"
      : "bg-violet-900/50 text-violet-300";
  return <span className={`rounded px-1.5 py-0.5 text-[9px] uppercase ${cls}`}>{source}</span>;
}

function StateBadge({ state }: { state: PluginState }) {
  switch (state) {
    case "active":
      return (
        <span className="flex items-center gap-1 rounded bg-emerald-900/50 px-1.5 py-0.5 text-[9px] uppercase text-emerald-300">
          <CheckCircle2 size={10} /> active
        </span>
      );
    case "disabled":
      return (
        <span className="flex items-center gap-1 rounded bg-gray-800 px-1.5 py-0.5 text-[9px] uppercase text-gray-400">
          <Pause size={10} /> disabled
        </span>
      );
    case "failed":
      return (
        <span className="flex items-center gap-1 rounded bg-rose-900/50 px-1.5 py-0.5 text-[9px] uppercase text-rose-300">
          <AlertTriangle size={10} /> failed
        </span>
      );
    case "client-bundle-missing":
      return (
        <span className="rounded bg-amber-900/50 px-1.5 py-0.5 text-[9px] uppercase text-amber-300">
          no client bundle
        </span>
      );
  }
}

function Toggle({
  active,
  pending,
  disabled,
  onClick,
}: {
  active: boolean;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      disabled={pending || disabled}
      onClick={onClick}
      className={[
        "relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer items-center rounded-full transition-colors",
        active ? "bg-brand-600" : "bg-gray-700",
        (pending || disabled) && "cursor-not-allowed opacity-50",
      ]
        .filter(Boolean)
        .join(" ")}
      title={
        disabled
          ? "Plugin cannot be enabled in its current state"
          : active
            ? "Click to disable"
            : "Click to enable"
      }
    >
      <span
        className={[
          "inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform",
          active ? "translate-x-5" : "translate-x-1",
        ].join(" ")}
      />
      {pending && (
        <Loader2
          size={10}
          className="absolute -right-4 top-1/2 -translate-y-1/2 animate-spin text-gray-400"
        />
      )}
    </button>
  );
}
