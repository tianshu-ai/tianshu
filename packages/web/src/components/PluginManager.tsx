// Plugin Manager — bundled chat-shell affordance (not itself a plugin).
//
// Two tabs:
//   - "Installed" — plugins discovered on disk for this tenant
//     (builtin + tenant overrides). Toggling persists to
//     <tenant>/config.json via PATCH /api/plugins/:id.
//   - "Catalog"   — plugins listed in the tianshu-ai/plugin-registry
//     catalog (or whatever TIANSHU_CATALOG_URL points at). Read-only
//     in P1; the Install button lands in P2.
//
// Per ADR-0003 §1, "not installed" must mean "not visible". The
// Installed tab therefore only ever shows plugins whose manifest is
// already on disk. The Catalog tab is for discovering ones that
// aren't.

import { useEffect, useState } from "react";
import {
  Loader2,
  Puzzle,
  X,
  AlertTriangle,
  CheckCircle2,
  Pause,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import {
  api,
  type PluginListEntry,
  type PluginState,
  type CatalogEntry,
  type CatalogSnapshot,
} from "../lib/api";
import { usePluginStore } from "../stores/plugin-store";

interface Props {
  open: boolean;
  onClose: () => void;
}

type Tab = "installed" | "catalog";

export default function PluginManager({ open, onClose }: Props) {
  const plugins = usePluginStore((s) => s.plugins);
  const setPlugins = usePluginStore((s) => s.setPlugins);
  const loadPlugins = usePluginStore((s) => s.load);
  const refreshPlugins = usePluginStore((s) => s.refresh);
  const refreshingPlugins = usePluginStore((s) => s.refreshing);

  const [tab, setTab] = useState<Tab>("installed");
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Installed tab — ensure the shared store is hydrated. The store's
  // `load()` is idempotent so opening the modal again is cheap.
  useEffect(() => {
    if (!open) return;
    void loadPlugins();
  }, [open, loadPlugins]);

  // Catalog tab — load lazily on first switch.
  useEffect(() => {
    if (!open || tab !== "catalog" || catalog !== null) return;
    let cancelled = false;
    setError(null);
    api
      .pluginCatalog()
      .then((snap) => {
        if (cancelled) return;
        setCatalog(snap);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, tab, catalog]);

  // ESC closes; reset transient state.
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


  async function refreshCatalog() {
    setRefreshing(true);
    setError(null);
    try {
      const snap = await api.refreshPluginCatalog();
      setCatalog(snap);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }

  const installedIds = new Set((plugins ?? []).map((p) => p.id));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="plugin-manager-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border-default bg-bg-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
          <div className="flex items-center gap-2">
            <Puzzle size={16} className="text-brand-400" />
            <h2 id="plugin-manager-title" className="text-sm font-semibold text-fg-default">
              Plugin Manager
            </h2>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost p-1.5" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-border-subtle px-3 pt-2">
          <TabButton active={tab === "installed"} onClick={() => setTab("installed")}>
            Installed
            {plugins && (
              <span className="ml-1.5 rounded bg-bg-raised px-1.5 py-0.5 text-[9px] text-fg-muted">
                {plugins.length}
              </span>
            )}
          </TabButton>
          <TabButton active={tab === "catalog"} onClick={() => setTab("catalog")}>
            Catalog
            {catalog && (
              <span className="ml-1.5 rounded bg-bg-raised px-1.5 py-0.5 text-[9px] text-fg-muted">
                {catalog.entries.length}
              </span>
            )}
          </TabButton>
          <div className="flex-1" />
          {tab === "installed" && (
            <button
              type="button"
              onClick={() => void refreshPlugins()}
              disabled={refreshingPlugins}
              className="btn-ghost flex items-center gap-1.5 px-2 py-1 text-[11px] text-fg-muted"
              title="Re-discover plugins on disk (after a manual install or git pull)"
            >
              <RefreshCw
                size={12}
                className={refreshingPlugins ? "animate-spin" : ""}
              />
              Refresh
            </button>
          )}
          {tab === "catalog" && catalog && (
            <button
              type="button"
              onClick={refreshCatalog}
              disabled={refreshing}
              className="btn-ghost flex items-center gap-1.5 px-2 py-1 text-[11px] text-fg-muted"
              title="Re-fetch the catalog from the registry"
            >
              <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
              Refresh
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-3 rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
              {error}
            </div>
          )}

          {tab === "installed" ? (
            <InstalledList
              plugins={plugins}
              pendingId={pendingId}
              onToggle={toggle}
            />
          ) : (
            <CatalogList catalog={catalog} installedIds={installedIds} />
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border-subtle px-5 py-3 text-[11px] leading-relaxed text-fg-faint">
          {tab === "installed" ? (
            <>
              Changes persist to{" "}
              <code className="rounded bg-bg-raised px-1 text-fg-muted">
                &lt;tenant&gt;/config.json
              </code>{" "}
              and take effect immediately for new requests.
            </>
          ) : (
            <>
              Catalog hosted at{" "}
              <code className="rounded bg-bg-raised px-1 text-fg-muted">
                tianshu-ai/plugin-registry
              </code>
              . Install button lands in P2.
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex items-center rounded-t-md border-b-2 px-3 py-2 text-xs font-medium",
        active
          ? "border-brand-500 text-fg-default"
          : "border-transparent text-fg-faint hover:text-fg-muted",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function InstalledList({
  plugins,
  pendingId,
  onToggle,
}: {
  plugins: PluginListEntry[] | null;
  pendingId: string | null;
  onToggle: (p: PluginListEntry) => void;
}) {
  if (plugins === null) {
    return (
      <div className="flex items-center justify-center py-10 text-sm text-fg-faint">
        <Loader2 size={14} className="mr-2 animate-spin" />
        Loading…
      </div>
    );
  }
  if (plugins.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-fg-faint">
        No plugins discovered for this tenant.
        <p className="mt-2 text-xs text-fg-fainter">
          Builtin plugins ship under{" "}
          <code className="rounded bg-bg-raised px-1 text-fg-muted">
            packages/server/builtinConfig/plugins/
          </code>
          . Tenant plugins live at{" "}
          <code className="rounded bg-bg-raised px-1 text-fg-muted">
            &lt;tenant&gt;/_tenant/config/plugins/
          </code>
          . Browse the Catalog tab to find more.
        </p>
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {plugins.map((p) => (
        <li
          key={p.id}
          className="flex items-start justify-between gap-3 rounded-lg border border-border-subtle bg-bg-elevated/50 p-3"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-fg-default">{p.displayName}</span>
              <code className="rounded bg-bg-raised px-1 py-0.5 text-[10px] text-fg-muted">
                {p.id}
              </code>
              <span className="text-[10px] text-fg-fainter">v{p.version}</span>
              <SourceBadge source={p.source} />
              <StateBadge state={p.state} />
            </div>
            {p.description && (
              <p className="mt-1 text-xs text-fg-muted">{p.description}</p>
            )}
            <CapabilityBadges entry={p} />
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
            onClick={() => onToggle(p)}
          />
        </li>
      ))}
    </ul>
  );
}

function CapabilityBadges({ entry }: { entry: PluginListEntry }) {
  const { provided, requires, missing } = entry.capabilities;
  if (provided.length === 0 && requires.length === 0 && missing.length === 0) {
    return null;
  }
  return (
    <div className="mt-1 flex flex-wrap gap-1.5 text-[10px]">
      {provided.map((c) => (
        <span
          key={`p-${c}`}
          className="rounded bg-emerald-900/40 px-1.5 py-0.5 text-emerald-300"
          title={`This plugin provides ${c}`}
        >
          provides {c}
        </span>
      ))}
      {requires
        .filter((c) => !missing.includes(c))
        .map((c) => (
          <span
            key={`r-${c}`}
            className="rounded bg-sky-900/40 px-1.5 py-0.5 text-sky-300"
            title={`This plugin requires ${c} (satisfied)`}
          >
            requires {c}
          </span>
        ))}
      {missing.map((c) => (
        <span
          key={`m-${c}`}
          className="rounded bg-rose-900/40 px-1.5 py-0.5 text-rose-300"
          title={`This plugin requires ${c}, but no provider is enabled`}
        >
          missing {c}
        </span>
      ))}
    </div>
  );
}

function CatalogList({
  catalog,
  installedIds,
}: {
  catalog: CatalogSnapshot | null;
  installedIds: Set<string>;
}) {
  if (catalog === null) {
    return (
      <div className="flex items-center justify-center py-10 text-sm text-fg-faint">
        <Loader2 size={14} className="mr-2 animate-spin" />
        Fetching catalog…
      </div>
    );
  }
  if (catalog.entries.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-fg-faint">
        Catalog is empty.
        <p className="mt-2 text-xs text-fg-fainter">
          The registry is at{" "}
          <a
            href="https://github.com/tianshu-ai/plugin-registry"
            target="_blank"
            rel="noreferrer"
            className="text-brand-400 hover:underline"
          >
            tianshu-ai/plugin-registry
          </a>
          . Submit a PR to add your plugin.
        </p>
      </div>
    );
  }
  return (
    <>
      {catalog.entriesDropped > 0 && (
        <div className="mb-3 rounded-md border border-amber-700/50 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-300">
          {catalog.entriesDropped} catalog{" "}
          {catalog.entriesDropped === 1 ? "entry was" : "entries were"} dropped because{" "}
          {catalog.entriesDropped === 1 ? "it failed" : "they failed"} schema validation.
        </div>
      )}
      <ul className="space-y-2">
        {catalog.entries.map((c) => (
          <CatalogRow
            key={c.id}
            entry={c}
            alreadyInstalled={installedIds.has(c.id)}
          />
        ))}
      </ul>
    </>
  );
}

function CatalogRow({
  entry,
  alreadyInstalled,
}: {
  entry: CatalogEntry;
  alreadyInstalled: boolean;
}) {
  return (
    <li className="flex items-start justify-between gap-3 rounded-lg border border-border-subtle bg-bg-elevated/50 p-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-fg-default">{entry.displayName}</span>
          <code className="rounded bg-bg-raised px-1 py-0.5 text-[10px] text-fg-muted">
            {entry.id}
          </code>
          <span className="text-[10px] text-fg-fainter">v{entry.latestVersion}</span>
          {entry.verified && (
            <span className="flex items-center gap-1 rounded bg-emerald-900/40 px-1.5 py-0.5 text-[9px] uppercase text-emerald-300">
              <ShieldCheck size={10} /> verified
            </span>
          )}
          <a
            href={entry.repository}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[10px] text-fg-faint hover:text-brand-400"
          >
            {entry.author} <ExternalLink size={9} />
          </a>
        </div>
        <p className="mt-1 text-xs text-fg-muted">{entry.description}</p>
        {entry.tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {entry.tags.map((t) => (
              <span
                key={t}
                className="rounded bg-bg-raised px-1.5 py-px text-[9px] text-fg-faint"
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        disabled
        title="Install lands in P2"
        className="flex-shrink-0 cursor-not-allowed rounded-md bg-bg-raised px-3 py-1.5 text-[11px] font-medium text-fg-faint"
      >
        {alreadyInstalled ? "Installed" : "Install"}
      </button>
    </li>
  );
}

function SourceBadge({ source }: { source: PluginListEntry["source"] }) {
  const cls =
    source === "builtin"
      ? "bg-bg-raised text-fg-muted"
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
        <span className="flex items-center gap-1 rounded bg-bg-raised px-1.5 py-0.5 text-[9px] uppercase text-fg-muted">
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
        active ? "bg-brand-600" : "bg-bg-hover",
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
          className="absolute -right-4 top-1/2 -translate-y-1/2 animate-spin text-fg-muted"
        />
      )}
    </button>
  );
}
