// Custom config form for the datasource plugin.
// Two-tier connection management:
//   1. Tenant connections — managed by tenant admins, shared by all users
//   2. My connections    — managed by individual users, supplements/overrides tenant

import { useState, useEffect, useCallback } from "react";
import { api, type PluginListEntry } from "../lib/api";
import { usePluginStore } from "../stores/plugin-store";
import { useT } from "../hooks/useT";
import { Plus, Trash2, Loader2, CheckCircle2, XCircle, Zap, Building2, User } from "lucide-react";

interface DriverField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
  fieldType?: "text" | "select";
  options?: Array<{ value: string; label: string }>;
  showWhen?: Record<string, string>;
}

interface DriverType {
  id: string;
  name: string;
  fields: DriverField[];
}

interface ConnectionEntry {
  type: string;
  description?: string;
  [key: string]: unknown;
}

const DRIVER_TYPES: DriverType[] = [
  { id: "neo4j", name: "Neo4j", fields: [
    { key: "uri", label: "ds.field.uri", placeholder: "bolt://localhost:7687", required: true },
    { key: "username", label: "ds.field.username", placeholder: "neo4j", required: true },
    { key: "password", label: "ds.field.password", secret: true, required: true },
    { key: "database", label: "ds.field.database", placeholder: "neo4j" },
  ]},
  { id: "mysql", name: "MySQL", fields: [
    { key: "host", label: "ds.field.host", placeholder: "localhost", required: true },
    { key: "port", label: "ds.field.port", placeholder: "3306" },
    { key: "username", label: "ds.field.username", placeholder: "root", required: true },
    { key: "password", label: "ds.field.password", secret: true, required: true },
    { key: "database", label: "ds.field.database", required: true },
  ]},
  { id: "rest", name: "REST API", fields: [
    { key: "baseUrl", label: "ds.field.baseUrl", placeholder: "https://api.example.com", required: true },
    { key: "headers", label: "ds.field.headers", placeholder: '{"Authorization": "Bearer ***"}' },
    { key: "timeout", label: "ds.field.timeout", placeholder: "30000" },
  ]},
];

const INPUT =
  "w-full rounded-md border border-border-default bg-bg-elevated px-3 py-1.5 text-xs text-fg-default outline-none placeholder:text-fg-fainter focus:border-brand-500";

const TAB_BASE = "px-3 py-1.5 text-xs font-medium border-b-2 transition-colors";
const TAB_ACTIVE = `${TAB_BASE} border-accent text-accent`;
const TAB_INACTIVE = `${TAB_BASE} border-transparent text-fg-muted hover:text-fg-default`;

const API_BASE = "/api/p/datasource";

// ─── Main form ──────────────────────────────────────────────

export function DataSourceConfigForm({ plugin }: { plugin: PluginListEntry }) {
  const t = useT();
  const [tab, setTab] = useState<"tenant" | "user">("user");
  const [isAdmin, setIsAdmin] = useState(false);
  const [types, setTypes] = useState<DriverType[]>(DRIVER_TYPES);

  // Check admin status: if plugin.config.connections is present,
  // the server already exposed it (admin-only data)
  useEffect(() => {
    const raw = plugin.config?.connections;
    if (raw && typeof raw === "object") {
      setIsAdmin(true);
    }
  }, [plugin]);

  // Load driver types from API
  useEffect(() => {
    fetch(`${API_BASE}/types`, { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (d?.types?.length > 0) {
          setTypes(d.types);
        }
      })
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="flex items-center gap-0 border-b border-border-subtle">
        <button
          type="button"
          onClick={() => setTab("user")}
          className={tab === "user" ? TAB_ACTIVE : TAB_INACTIVE}
        >
          <span className="inline-flex items-center gap-1.5">
            <User size={12} />
            {t("ds.myConnections")}
          </span>
        </button>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setTab("tenant")}
            className={tab === "tenant" ? TAB_ACTIVE : TAB_INACTIVE}
          >
            <span className="inline-flex items-center gap-1.5">
              <Building2 size={12} />
              {t("ds.tenantConnections")}
            </span>
          </button>
        )}
      </div>

      {tab === "tenant" && isAdmin ? (
        <TenantConnectionsForm plugin={plugin} types={types} />
      ) : (
        <UserConnectionsForm types={types} />
      )}
    </div>
  );
}

// ─── Tenant connections (admin only) ────────────────────────

function TenantConnectionsForm({ plugin, types }: { plugin: PluginListEntry; types: DriverType[] }) {
  const t = useT();
  const setPlugins = usePluginStore((s) => s.setPlugins);
  const [connections, setConnections] = useState<Record<string, ConnectionEntry>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState(types[0]?.id ?? "");

  useEffect(() => {
    const raw = plugin.config?.connections;
    if (raw && typeof raw === "object") {
      setConnections(raw as Record<string, ConnectionEntry>);
    }
  }, [plugin.config]);

  function updateField(name: string, key: string, value: string) {
    setConnections((prev) => ({ ...prev, [name]: { ...prev[name]!, [key]: value } }));
    setDirty(true);
  }

  function removeConnection(name: string) {
    setConnections((prev) => { const next = { ...prev }; delete next[name]; return next; });
    setDirty(true);
  }

  function addConnection() {
    const name = newName.trim().replace(/[^a-zA-Z0-9_-]/g, "-");
    if (!name || connections[name]) return;
    setConnections((prev) => ({ ...prev, [name]: { type: newType, description: "" } }));
    setNewName(""); setAdding(false); setDirty(true);
  }

  async function save() {
    setSaving(true); setError(null);
    try {
      const r = await api.setPluginConfig("datasource", { connections });
      setPlugins(r.plugins);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function testConnection(name: string) {
    setTestResults((prev) => ({ ...prev, [name]: { ok: false, msg: t("ds.testing") } }));
    try {
      const res = await fetch(`${API_BASE}/test/${encodeURIComponent(name)}`, { method: "POST", credentials: "include" });
      const data = await res.json();
      setTestResults((prev) => ({
        ...prev,
        [name]: { ok: !!data.ok, msg: data.ok ? t("ds.connected") : data.error || t("ds.failed") },
      }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [name]: { ok: false, msg: err instanceof Error ? err.message : String(err) },
      }));
    }
  }

  return (
    <ConnectionList
      connections={connections}
      types={types}
      scope="tenant"
      dirty={dirty}
      saving={saving}
      error={error}
      testResults={testResults}
      adding={adding}
      newName={newName}
      newType={newType}
      onUpdateField={updateField}
      onRemove={removeConnection}
      onAdd={addConnection}
      onSave={save}
      onTest={testConnection}
      onSetAdding={setAdding}
      onSetNewName={setNewName}
      onSetNewType={setNewType}
    />
  );
}

// ─── User connections ───────────────────────────────────────

function UserConnectionsForm({ types }: { types: DriverType[] }) {
  const t = useT();
  const [connections, setConnections] = useState<Record<string, ConnectionEntry>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState(types[0]?.id ?? "");
  const [loaded, setLoaded] = useState(false);

  // Load user connections
  useEffect(() => {
    fetch(`${API_BASE}/user-connections`, { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (d?.connections) setConnections(d.connections);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  function updateField(name: string, key: string, value: string) {
    setConnections((prev) => ({ ...prev, [name]: { ...prev[name]!, [key]: value } }));
    setDirty(true);
  }

  async function removeConnection(name: string) {
    setConnections((prev) => { const next = { ...prev }; delete next[name]; return next; });
    // Immediately persist the deletion
    try {
      const res = await fetch(`${API_BASE}/user-connections/${encodeURIComponent(name)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json();
      if (!data.ok) setError(data.error || "Delete failed");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function addConnection() {
    const name = newName.trim().replace(/[^a-zA-Z0-9_-]/g, "-");
    if (!name || connections[name]) return;
    setConnections((prev) => ({ ...prev, [name]: { type: newType, description: "" } }));
    setNewName(""); setAdding(false); setDirty(true);
  }

  const save = useCallback(async () => {
    setSaving(true); setError(null);
    try {
      const res = await fetch(`${API_BASE}/user-connections`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connections }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Save failed");
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [connections]);

  async function testConnection(name: string) {
    setTestResults((prev) => ({ ...prev, [name]: { ok: false, msg: t("ds.testing") } }));
    try {
      // Save first if dirty
      if (dirty) await save();
      const res = await fetch(`${API_BASE}/test/${encodeURIComponent(name)}`, { method: "POST", credentials: "include" });
      const data = await res.json();
      setTestResults((prev) => ({
        ...prev,
        [name]: { ok: !!data.ok, msg: data.ok ? t("ds.connected") : data.error || t("ds.failed") },
      }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [name]: { ok: false, msg: err instanceof Error ? err.message : String(err) },
      }));
    }
  }

  if (!loaded) {
    return <div className="flex items-center gap-2 text-xs text-fg-faint"><Loader2 size={12} className="animate-spin" /> Loading…</div>;
  }

  return (
    <ConnectionList
      connections={connections}
      types={types}
      scope="user"
      dirty={dirty}
      saving={saving}
      error={error}
      testResults={testResults}
      adding={adding}
      newName={newName}
      newType={newType}
      onUpdateField={updateField}
      onRemove={removeConnection}
      onAdd={addConnection}
      onSave={save}
      onTest={testConnection}
      onSetAdding={setAdding}
      onSetNewName={setNewName}
      onSetNewType={setNewType}
    />
  );
}

// ─── Shared connection list UI ──────────────────────────────

interface ConnectionListProps {
  connections: Record<string, ConnectionEntry>;
  types: DriverType[];
  scope: "tenant" | "user";
  dirty: boolean;
  saving: boolean;
  error: string | null;
  testResults: Record<string, { ok: boolean; msg: string }>;
  adding: boolean;
  newName: string;
  newType: string;
  onUpdateField: (name: string, key: string, value: string) => void;
  onRemove: (name: string) => void;
  onAdd: () => void;
  onSave: () => void;
  onTest: (name: string) => void;
  onSetAdding: (v: boolean) => void;
  onSetNewName: (v: string) => void;
  onSetNewType: (v: string) => void;
}

function ConnectionList({
  connections, types, scope, dirty, saving, error, testResults,
  adding, newName, newType,
  onUpdateField, onRemove, onAdd, onSave, onTest,
  onSetAdding, onSetNewName, onSetNewType,
}: ConnectionListProps) {
  const t = useT();
  const names = Object.keys(connections);

  return (
    <div className="space-y-4">
      {scope === "tenant" && (
        <p className="text-xs text-fg-faint">{t("ds.tenantHint")}</p>
      )}
      {scope === "user" && (
        <p className="text-xs text-fg-faint">{t("ds.userHint")}</p>
      )}

      {names.length === 0 && !adding && (
        <p className="text-xs text-fg-faint">{t("ds.noConnections")}</p>
      )}

      {names.map((name) => {
        const conn = connections[name]!;
        const driverType = types.find((dt) => dt.id === conn.type);
        const test = testResults[name];

        return (
          <div key={name} className="rounded-lg border border-border-subtle p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-fg-default">{name}</span>
                <span className="rounded bg-bg-raised px-1.5 py-0.5 text-xs text-fg-faint">{conn.type}</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onTest(name)}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-fg-muted hover:bg-bg-raised"
                  title={t("ds.testConnection")}
                >
                  <Zap size={12} /> {t("ds.test")}
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(name)}
                  className="rounded p-1 text-fg-faint hover:bg-bg-raised hover:text-danger"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>

            {test && (
              <div className={`flex items-center gap-1 text-xs ${test.ok ? "text-success" : "text-danger"}`}>
                {test.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                {test.msg}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-0.5 block text-xs text-fg-faint">{t("ds.description")}</label>
                <input
                  className={INPUT}
                  value={String(conn.description ?? "")}
                  onChange={(e) => onUpdateField(name, "description", e.target.value)}
                  placeholder={t("ds.descriptionPlaceholder")} autoComplete="off"
                />
              </div>
              {driverType?.fields.map((f) => {
                if (f.showWhen) {
                  const visible = Object.entries(f.showWhen).every(
                    ([k, v]) => String((conn as Record<string, unknown>)[k] ?? "") === v,
                  );
                  if (!visible) return null;
                }
                return (
                  <div key={f.key}>
                    <label className="mb-0.5 block text-xs text-fg-faint">
                      {t(f.label)}{f.required ? " *" : ""}
                    </label>
                    {f.fieldType === "select" && f.options ? (
                      <select
                        className={INPUT}
                        value={String((conn as Record<string, unknown>)[f.key] ?? f.options[0]?.value ?? "")}
                        onChange={(e) => onUpdateField(name, f.key, e.target.value)}
                      >
                        {f.options.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className={INPUT}
                        type={f.secret ? "password" : "text"}
                        value={String((conn as Record<string, unknown>)[f.key] ?? "")}
                        onChange={(e) => onUpdateField(name, f.key, e.target.value)}
                        placeholder={f.placeholder}
                        autoComplete="off"
                        data-1p-ignore
                        data-lpignore="true"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {adding ? (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-border-default p-3">
          <input
            className={INPUT + " max-w-[160px]"}
            value={newName}
            onChange={(e) => onSetNewName(e.target.value)}
            placeholder={t("ds.connectionName")} autoComplete="off"
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && onAdd()}
          />
          <select
            className={INPUT + " max-w-[120px]"}
            value={newType}
            onChange={(e) => onSetNewType(e.target.value)}
          >
            {types.map((dt) => (
              <option key={dt.id} value={dt.id}>{dt.name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={onAdd}
            disabled={!newName.trim()}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500 disabled:opacity-40"
          >
            {t("ds.add")}
          </button>
          <button
            type="button"
            onClick={() => onSetAdding(false)}
            className="text-xs text-fg-faint hover:text-fg-default"
          >
            {t("common.cancel")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onSetAdding(true)}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-border-default px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-raised"
        >
          <Plus size={12} /> {t("ds.addDataSource")}
        </button>
      )}

      {error && (
        <div className="rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-border-subtle pt-3">
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null}
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}
