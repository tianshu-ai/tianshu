// Cross-source MCP servers admin page (host-shipped, not a plugin
// contribution). Renders two groups:
//
//   - Plugin-contributed servers — read-only, owned by whichever
//     plugin declared `contributes.toolsets[]`. We tell the user
//     "edit by enabling/disabling the plugin" rather than letting
//     them mutate plugin-owned config from here.
//
//   - User-configured servers — full CRUD: add, edit, delete,
//     enable/disable, manual refresh. Persisted in the tenant
//     config under `mcp.servers[]`.
//
// Backend: GET /api/mcp/servers → list with `source` field.
//          POST/PATCH/DELETE /api/mcp/servers[/:id] → CRUD on the
//          user side. POST /api/mcp/servers/:id/refresh → re-probe.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useUiPrimitives } from "@tianshu-ai/plugin-sdk/client";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  XCircle,
} from "lucide-react";
import { useT } from "../../hooks/useT";

interface ServerEntry {
  source: "plugin" | "user";
  sourceId: string;
  id: string;
  displayName: string;
  enabled: boolean;
  providerName: string;
  toolCount: number;
  snapshot: McpToolsetSnapshot | null;
  userEntry?: UserEntryShape;
}

interface UserEntryShape {
  id: string;
  displayName?: string;
  url: string;
  prefix?: string;
  upstreamHost?: string;
  enabled: boolean;
}

interface McpToolsetSnapshot {
  name: string;
  prefix: string;
  endpoint: string | undefined;
  tools: { toolName: string; upstream: { name: string; description?: string } }[];
  lastRefreshAt: number | undefined;
  lastError: string | undefined;
}

interface ApiResponse {
  servers: ServerEntry[];
}

export default function McpServersPage() {
  const t = useT();
  const [servers, setServers] = useState<ServerEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<UserEntryShape | "new" | null>(null);

  const fetchServers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/mcp/servers", { credentials: "include" });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
      }
      const j = (await r.json()) as ApiResponse;
      setServers(j.servers ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchServers();
  }, [fetchServers]);

  const grouped = useMemo(() => {
    const out: { source: "plugin" | "user"; items: ServerEntry[] }[] = [
      { source: "plugin", items: [] },
      { source: "user", items: [] },
    ];
    for (const s of servers ?? []) {
      out.find((g) => g.source === s.source)?.items.push(s);
    }
    return out;
  }, [servers]);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-fg-default">
            <Server size={18} className="text-brand-400" />
            {t("mcp.title")}
          </h1>
          <p className="mt-1 text-[12px] text-fg-faint">
            {t("mcp.description")}
          </p>
        </div>
        {/* flex-shrink-0 + whitespace-nowrap on each button so the
         *  header description can wrap freely without compressing
         *  the action buttons into 2-line boxes. */}
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={fetchServers}
            disabled={loading}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border-default px-3 py-1.5 text-[12px] text-fg-muted hover:bg-bg-raised/50 disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : undefined} />
            {t("common.refresh")}
          </button>
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-brand-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-brand-500"
          >
            <Plus size={12} />
            {t("mcp.addServer")}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-[12px] text-danger">
          <AlertTriangle size={14} className="mt-px flex-shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}

      {servers && (
        <div className="space-y-6">
          {grouped.map((g) => (
            <SourceGroup
              key={g.source}
              source={g.source}
              items={g.items}
              onEdit={(entry) => setEditing(entry)}
              onChanged={fetchServers}
              onError={setError}
            />
          ))}
        </div>
      )}

      {editing && (
        <EditDialog
          mode={editing === "new" ? "create" : "edit"}
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await fetchServers();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function SourceGroup({
  source,
  items,
  onEdit,
  onChanged,
  onError,
}: {
  source: "plugin" | "user";
  items: ServerEntry[];
  onEdit: (entry: UserEntryShape) => void;
  onChanged: () => Promise<void>;
  onError: (err: string) => void;
}) {
  const t = useT();
  const title =
    source === "plugin" ? t("mcp.group.plugin.title") : t("mcp.group.user.title");
  const subtitle =
    source === "plugin"
      ? t("mcp.group.plugin.subtitle")
      : t("mcp.group.user.subtitle");
  return (
    <section>
      <div className="mb-2 flex items-end justify-between">
        <div>
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-fg-muted">
            {title}
          </h2>
          <p className="text-[11px] text-fg-faint">{subtitle}</p>
        </div>
      </div>
      {items.length === 0 ? (
        <EmptyGroup source={source} />
      ) : (
        <div className="space-y-3">
          {items.map((s) => (
            <ServerCard
              key={`${s.source}.${s.sourceId}.${s.id}`}
              server={s}
              onEdit={onEdit}
              onChanged={onChanged}
              onError={onError}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function EmptyGroup({ source }: { source: "plugin" | "user" }) {
  const t = useT();
  if (source === "plugin") {
    return (
      <div className="rounded-md border border-dashed border-border-subtle px-4 py-6 text-center text-[12px] text-fg-faint">
        {t("mcp.empty.plugin")}
      </div>
    );
  }
  return (
    <div className="rounded-md border border-dashed border-border-subtle px-4 py-6 text-center text-[12px] text-fg-faint">
      {t("mcp.empty.userBefore")}{" "}
      <span className="text-fg-muted">{t("mcp.addServer")}</span>{" "}
      {t("mcp.empty.userAfter")}
    </div>
  );
}

function ServerCard({
  server,
  onEdit,
  onChanged,
  onError,
}: {
  server: ServerEntry;
  onEdit: (entry: UserEntryShape) => void;
  onChanged: () => Promise<void>;
  onError: (err: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const snap = server.snapshot;
  const tools = snap?.tools ?? [];
  const lastErr = snap?.lastError;
  const endpoint = snap?.endpoint;
  // Inlined (not memoised) so it re-renders when the locale
  // changes; the calc is cheap enough not to need memoisation.
  let lastRefreshAgo: string | null = null;
  if (snap?.lastRefreshAt) {
    const seconds = Math.round((Date.now() - snap.lastRefreshAt) / 1000);
    if (seconds < 60) {
      lastRefreshAgo = t("mcp.refreshedSecondsAgo", { n: seconds });
    } else {
      const m = Math.round(seconds / 60);
      if (m < 60) {
        lastRefreshAgo = t("mcp.refreshedMinutesAgo", { n: m });
      } else {
        lastRefreshAgo = t("mcp.refreshedHoursAgo", { n: Math.round(m / 60) });
      }
    }
  }

  const healthy = server.enabled && !lastErr && tools.length > 0;
  const isUser = server.source === "user";

  const onRefresh = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(
        `/api/mcp/servers/${encodeURIComponent(server.id)}/refresh`,
        { method: "POST", credentials: "include" },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [server.id, onChanged, onError]);

  const onToggle = useCallback(async () => {
    if (!isUser || !server.userEntry) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/mcp/servers/${encodeURIComponent(server.id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !server.enabled }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [isUser, server.userEntry, server.id, server.enabled, onChanged, onError]);

  const onDelete = useCallback(async () => {
    if (!isUser) return;
    if (!confirm(t("mcp.confirmDelete", { name: server.displayName }))) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/mcp/servers/${encodeURIComponent(server.id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [isUser, server.displayName, server.id, onChanged, onError, t]);

  return (
    <div className="overflow-hidden rounded-md border border-border-subtle bg-bg-elevated/60">
      <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="-my-1 -ml-1 mr-2 rounded p-1 text-fg-faint hover:bg-bg-raised/60 hover:text-fg-muted"
          aria-label={open ? t("mcp.collapse") : t("mcp.expand")}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {!server.enabled ? (
              <span
                className="h-2 w-2 rounded-full bg-fg-fainter"
                title={t("mcp.status.disabled")}
              />
            ) : healthy ? (
              <CheckCircle2 size={14} className="text-success" />
            ) : (
              <XCircle size={14} className="text-danger" />
            )}
            <span className="truncate text-[13px] font-medium text-fg-default">
              {server.displayName}
            </span>
            <span
              className={`rounded-sm px-1.5 py-0.5 text-[10px] ${
                isUser ? "bg-blue-950 text-link" : "bg-bg-raised text-fg-muted"
              }`}
            >
              {isUser
                ? t("mcp.badge.user")
                : t("mcp.badge.plugin", { id: server.sourceId })}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-fg-faint">
            <span>
              {t("mcp.meta.id")} <code className="text-fg-muted">{server.id}</code>
            </span>
            {endpoint && (
              <span>
                {t("mcp.meta.endpoint")}{" "}
                <code className="text-fg-muted">{endpoint}</code>
              </span>
            )}
            {snap?.prefix && snap.prefix !== "" && (
              <span>
                {t("mcp.meta.prefix")}{" "}
                <code className="text-fg-muted">{snap.prefix}</code>
              </span>
            )}
            {lastRefreshAgo && <span>{lastRefreshAgo}</span>}
            {!server.enabled && (
              <span className="text-fg-faint">{t("mcp.parenDisabled")}</span>
            )}
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <span className="rounded-md border border-border-default bg-bg-base px-2 py-1 text-[11px] text-fg-muted">
            {t("mcp.toolCount", { n: server.toolCount })}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            title={t("common.refresh")}
            className="rounded p-1.5 text-fg-muted hover:bg-bg-raised/60 hover:text-fg-default disabled:opacity-50"
          >
            <RefreshCw size={12} className={busy ? "animate-spin" : undefined} />
          </button>
          {isUser && server.userEntry && (
            <>
              <button
                type="button"
                onClick={() => onEdit(server.userEntry!)}
                disabled={busy}
                title={t("common.edit")}
                className="rounded p-1.5 text-fg-muted hover:bg-bg-raised/60 hover:text-fg-default disabled:opacity-50"
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                onClick={onToggle}
                disabled={busy}
                className="rounded-md border border-border-default px-2 py-1 text-[11px] text-fg-muted hover:bg-bg-raised/50 disabled:opacity-50"
              >
                {server.enabled ? t("common.disable") : t("common.enable")}
              </button>
              <button
                type="button"
                onClick={onDelete}
                disabled={busy}
                title={t("common.delete")}
                className="rounded p-1.5 text-danger hover:bg-rose-950/40 disabled:opacity-50"
              >
                <Trash2 size={12} />
              </button>
            </>
          )}
        </div>
      </div>

      {lastErr && (
        <div className="border-b border-border-subtle bg-rose-950/30 px-4 py-2 text-[11px] text-danger">
          <AlertTriangle size={12} className="mr-1 inline-block" />
          {lastErr}
        </div>
      )}

      {open &&
        (tools.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-fg-faint">
            {endpoint
              ? t("mcp.tools.empty.reachable")
              : !server.enabled
                ? t("mcp.tools.empty.disabled")
                : server.source === "plugin"
                  ? t("mcp.tools.empty.pluginNotReady")
                  : t("mcp.tools.empty.unreachable")}
          </div>
        ) : (
          <table className="w-full text-[12px]">
            <thead className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wide text-fg-faint">
              <tr>
                <th className="px-4 py-2 font-medium">{t("mcp.table.toolName")}</th>
                <th className="px-4 py-2 font-medium">{t("mcp.table.upstream")}</th>
                <th className="px-4 py-2 font-medium">{t("mcp.table.description")}</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => (
                <tr
                  key={tool.toolName}
                  className="border-b border-border-subtle last:border-b-0"
                >
                  <td className="px-4 py-2 align-top font-mono text-[11.5px] text-fg-default">
                    {tool.toolName}
                  </td>
                  <td className="px-4 py-2 align-top font-mono text-[11.5px] text-fg-faint">
                    {tool.upstream.name}
                  </td>
                  <td className="px-4 py-2 align-top text-fg-muted">
                    {tool.upstream.description ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </div>
  );
}

function EditDialog({
  mode,
  initial,
  onClose,
  onSaved,
  onError,
}: {
  mode: "create" | "edit";
  initial: UserEntryShape | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (err: string) => void;
}) {
  const t = useT();
  const [id, setId] = useState(initial?.id ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [prefix, setPrefix] = useState(initial?.prefix ?? "");
  const [upstreamHost, setUpstreamHost] = useState(initial?.upstreamHost ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id)) {
      setValidationError(t("mcp.validation.id"));
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = { id, url, enabled };
      if (displayName) body.displayName = displayName;
      if (prefix !== initial?.prefix) body.prefix = prefix; // preserve "" → empty prefix
      if (upstreamHost) body.upstreamHost = upstreamHost;

      const path =
        mode === "create"
          ? "/api/mcp/servers"
          : `/api/mcp/servers/${encodeURIComponent(id)}`;
      const r = await fetch(path, {
        method: mode === "create" ? "POST" : "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.message ?? `HTTP ${r.status}`);
      }
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const { Modal } = useUiPrimitives();
  // Title is rendered by Modal; we drop the inline <h2> the inner
  // form used to carry. Body uses a <form> so submitting still
  // works on Enter inside any input.
  const dialogTitle =
    mode === "create"
      ? t("mcp.dialog.addTitle")
      : t("mcp.dialog.editTitle", { name: initial?.displayName ?? id });
  return (
    <Modal isOpen onClose={onClose} size="sm" title={dialogTitle}>
      <form
        onSubmit={onSubmit}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5"
      >

        <Field label={t("mcp.form.id.label")} hint={t("mcp.form.id.hint")}>
          <input
            type="text"
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={mode === "edit"}
            placeholder="my-mcp"
            className="w-full rounded-md border border-border-default bg-bg-base px-2 py-1.5 text-[13px] text-fg-default outline-none focus:border-brand-500 disabled:opacity-60"
            required
          />
        </Field>

        <Field
          label={t("mcp.form.displayName.label")}
          hint={t("mcp.form.displayName.hint")}
        >
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="My MCP server"
            className="w-full rounded-md border border-border-default bg-bg-base px-2 py-1.5 text-[13px] text-fg-default outline-none focus:border-brand-500"
          />
        </Field>

        <Field label={t("mcp.form.url.label")} hint={t("mcp.form.url.hint")}>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/mcp"
            className="w-full rounded-md border border-border-default bg-bg-base px-2 py-1.5 text-[13px] text-fg-default outline-none focus:border-brand-500"
            required
          />
        </Field>

        <Field
          label={t("mcp.form.prefix.label")}
          hint={t("mcp.form.prefix.hint")}
        >
          <input
            type="text"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder={`${id}_`}
            className="w-full rounded-md border border-border-default bg-bg-base px-2 py-1.5 text-[13px] text-fg-default outline-none focus:border-brand-500"
          />
        </Field>

        <Field
          label={t("mcp.form.upstreamHost.label")}
          hint={t("mcp.form.upstreamHost.hint")}
        >
          <input
            type="text"
            value={upstreamHost}
            onChange={(e) => setUpstreamHost(e.target.value)}
            placeholder="localhost:3200"
            className="w-full rounded-md border border-border-default bg-bg-base px-2 py-1.5 text-[13px] text-fg-default outline-none focus:border-brand-500"
          />
        </Field>

        <label className="flex items-center gap-2 text-[12px] text-fg-muted">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="rounded border-border-default bg-bg-base"
          />
          {t("mcp.enabledCheckbox")}
        </label>

        {validationError && (
          <div className="rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-[11px] text-danger">
            {validationError}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border-default px-3 py-1.5 text-[12px] text-fg-muted hover:bg-bg-raised/50"
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-brand-500 disabled:opacity-50"
          >
            {busy
              ? t("common.saving")
              : mode === "create"
                ? t("mcp.addServer")
                : t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-fg-muted">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-fg-faint">{hint}</p>}
    </div>
  );
}
