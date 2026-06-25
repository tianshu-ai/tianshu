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
          <h1 className="flex items-center gap-2 text-xl font-semibold text-gray-100">
            <Server size={18} className="text-brand-400" />
            MCP Servers
          </h1>
          <p className="mt-1 text-[12px] text-gray-500">
            Model Context Protocol servers visible to this agent. Plugin-contributed
            servers come from active plugins (read-only here — toggle the plugin to
            enable/disable). User-configured servers are managed directly below.
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
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-gray-700 px-3 py-1.5 text-[12px] text-gray-300 hover:bg-gray-800/50 disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : undefined} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-brand-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-brand-500"
          >
            <Plus size={12} />
            Add server
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-[12px] text-rose-300">
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
  const title = source === "plugin" ? "From plugins" : "User-configured";
  const subtitle =
    source === "plugin"
      ? "Read-only — managed by the contributing plugin."
      : "Add MCP servers (HTTP) to expand the agent's tool surface.";
  return (
    <section>
      <div className="mb-2 flex items-end justify-between">
        <div>
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-gray-400">
            {title}
          </h2>
          <p className="text-[11px] text-gray-500">{subtitle}</p>
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
  if (source === "plugin") {
    return (
      <div className="rounded-md border border-dashed border-gray-800 px-4 py-6 text-center text-[12px] text-gray-500">
        No plugin currently contributes an MCP server.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-dashed border-gray-800 px-4 py-6 text-center text-[12px] text-gray-500">
      No user-configured MCP servers. Click <span className="text-gray-300">Add server</span>{" "}
      to point the agent at one (e.g. an MCP server you run locally or remotely).
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
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const snap = server.snapshot;
  const tools = snap?.tools ?? [];
  const lastErr = snap?.lastError;
  const endpoint = snap?.endpoint;
  const lastRefreshAgo = useMemo(() => {
    if (!snap?.lastRefreshAt) return null;
    const seconds = Math.round((Date.now() - snap.lastRefreshAt) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const m = Math.round(seconds / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.round(m / 60)}h ago`;
  }, [snap?.lastRefreshAt]);

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
    if (!confirm(`Remove MCP server "${server.displayName}"?`)) return;
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
  }, [isUser, server.displayName, server.id, onChanged, onError]);

  return (
    <div className="overflow-hidden rounded-md border border-gray-800 bg-gray-900/60">
      <div className="flex items-start justify-between gap-3 border-b border-gray-800 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="-my-1 -ml-1 mr-2 rounded p-1 text-gray-500 hover:bg-gray-800/60 hover:text-gray-300"
          aria-label={open ? "Collapse" : "Expand"}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {!server.enabled ? (
              <span className="h-2 w-2 rounded-full bg-gray-500" title="disabled" />
            ) : healthy ? (
              <CheckCircle2 size={14} className="text-emerald-400" />
            ) : (
              <XCircle size={14} className="text-rose-400" />
            )}
            <span className="truncate text-[13px] font-medium text-gray-100">
              {server.displayName}
            </span>
            <span
              className={`rounded-sm px-1.5 py-0.5 text-[10px] ${
                isUser ? "bg-blue-950 text-blue-300" : "bg-gray-800 text-gray-400"
              }`}
            >
              {isUser ? "user" : `plugin: ${server.sourceId}`}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500">
            <span>
              id <code className="text-gray-400">{server.id}</code>
            </span>
            {endpoint && (
              <span>
                endpoint <code className="text-gray-400">{endpoint}</code>
              </span>
            )}
            {snap?.prefix && snap.prefix !== "" && (
              <span>
                prefix <code className="text-gray-400">{snap.prefix}</code>
              </span>
            )}
            {lastRefreshAgo && <span>refreshed {lastRefreshAgo}</span>}
            {!server.enabled && (
              <span className="text-gray-500">(disabled)</span>
            )}
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <span className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-[11px] text-gray-300">
            {server.toolCount} tools
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            title="Refresh"
            className="rounded p-1.5 text-gray-400 hover:bg-gray-800/60 hover:text-gray-200 disabled:opacity-50"
          >
            <RefreshCw size={12} className={busy ? "animate-spin" : undefined} />
          </button>
          {isUser && server.userEntry && (
            <>
              <button
                type="button"
                onClick={() => onEdit(server.userEntry!)}
                disabled={busy}
                title="Edit"
                className="rounded p-1.5 text-gray-400 hover:bg-gray-800/60 hover:text-gray-200 disabled:opacity-50"
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                onClick={onToggle}
                disabled={busy}
                className="rounded-md border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800/50 disabled:opacity-50"
              >
                {server.enabled ? "Disable" : "Enable"}
              </button>
              <button
                type="button"
                onClick={onDelete}
                disabled={busy}
                title="Delete"
                className="rounded p-1.5 text-rose-400 hover:bg-rose-950/40 disabled:opacity-50"
              >
                <Trash2 size={12} />
              </button>
            </>
          )}
        </div>
      </div>

      {lastErr && (
        <div className="border-b border-gray-800 bg-rose-950/30 px-4 py-2 text-[11px] text-rose-300">
          <AlertTriangle size={12} className="mr-1 inline-block" />
          {lastErr}
        </div>
      )}

      {open &&
        (tools.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-gray-500">
            {endpoint
              ? "Server is reachable but advertised no tools."
              : !server.enabled
                ? "Server is disabled."
                : server.source === "plugin"
                  ? "Upstream not reachable yet. Plugin MCP servers usually live inside a sandbox that boots on first agent action — try running an exec/browser tool, or click Refresh after the sandbox starts."
                  : "Endpoint unreachable. Click Refresh to re-probe."}
          </div>
        ) : (
          <table className="w-full text-[12px]">
            <thead className="border-b border-gray-800 text-left text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Tool name</th>
                <th className="px-4 py-2 font-medium">Upstream</th>
                <th className="px-4 py-2 font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t.toolName} className="border-b border-gray-900 last:border-b-0">
                  <td className="px-4 py-2 align-top font-mono text-[11.5px] text-gray-200">
                    {t.toolName}
                  </td>
                  <td className="px-4 py-2 align-top font-mono text-[11.5px] text-gray-500">
                    {t.upstream.name}
                  </td>
                  <td className="px-4 py-2 align-top text-gray-400">
                    {t.upstream.description ?? "—"}
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
      setValidationError("id must be 1-31 chars: lowercase letters, digits, dashes");
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
    mode === "create" ? "Add MCP server" : `Edit ${initial?.displayName ?? id}`;
  return (
    <Modal isOpen onClose={onClose} size="sm" title={dialogTitle}>
      <form
        onSubmit={onSubmit}
        className="h-full space-y-3 overflow-y-auto p-5"
      >

        <Field label="ID" hint="Lowercase letters / digits / dashes; used in URLs and tool prefixes.">
          <input
            type="text"
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={mode === "edit"}
            placeholder="my-mcp"
            className="w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-[13px] text-gray-100 outline-none focus:border-brand-500 disabled:opacity-60"
            required
          />
        </Field>

        <Field label="Display name" hint="Optional; defaults to id.">
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="My MCP server"
            className="w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-[13px] text-gray-100 outline-none focus:border-brand-500"
          />
        </Field>

        <Field label="URL" hint="Streamable HTTP MCP endpoint (must include path, e.g. /mcp).">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/mcp"
            className="w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-[13px] text-gray-100 outline-none focus:border-brand-500"
            required
          />
        </Field>

        <Field
          label="Tool prefix"
          hint='Prepended to every reflected tool name. Default: "<id>_". Pass empty to disable.'
        >
          <input
            type="text"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder={`${id}_`}
            className="w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-[13px] text-gray-100 outline-none focus:border-brand-500"
          />
        </Field>

        <Field
          label="Upstream Host header"
          hint="Optional. Pin the request Host header (most MCP servers validate it; useful behind port-forwards)."
        >
          <input
            type="text"
            value={upstreamHost}
            onChange={(e) => setUpstreamHost(e.target.value)}
            placeholder="localhost:3200"
            className="w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-[13px] text-gray-100 outline-none focus:border-brand-500"
          />
        </Field>

        <label className="flex items-center gap-2 text-[12px] text-gray-300">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="rounded border-gray-700 bg-gray-950"
          />
          Enabled
        </label>

        {validationError && (
          <div className="rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-[11px] text-rose-300">
            {validationError}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-700 px-3 py-1.5 text-[12px] text-gray-300 hover:bg-gray-800/50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-brand-500 disabled:opacity-50"
          >
            {busy ? "Saving…" : mode === "create" ? "Add server" : "Save"}
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
      <label className="mb-1 block text-[11px] font-medium text-gray-300">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-gray-500">{hint}</p>}
    </div>
  );
}
