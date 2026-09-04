// Custom config form for the datasource plugin.
// Renders a proper UI for managing named database connections
// instead of raw JSON editing.

import { useState, useEffect } from "react";
import { api, type PluginListEntry } from "../lib/api";
import { usePluginStore } from "../stores/plugin-store";
import { useT } from "../hooks/useT";
import { Plus, Trash2, Loader2, CheckCircle2, XCircle, Zap } from "lucide-react";

interface DriverField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
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
    { key: "uri", label: "URI", placeholder: "bolt://localhost:7687", required: true },
    { key: "username", label: "Username", placeholder: "neo4j", required: true },
    { key: "password", label: "Password", secret: true, required: true },
    { key: "database", label: "Database", placeholder: "neo4j" },
  ]},
  { id: "mysql", name: "MySQL", fields: [
    { key: "host", label: "Host", placeholder: "localhost", required: true },
    { key: "port", label: "Port", placeholder: "3306" },
    { key: "username", label: "Username", placeholder: "root", required: true },
    { key: "password", label: "Password", secret: true, required: true },
    { key: "database", label: "Database", required: true },
  ]},
];

const INPUT =
  "w-full rounded-md border border-border-default bg-bg-elevated px-3 py-1.5 text-[12px] text-fg-default outline-none placeholder:text-fg-fainter focus:border-brand-500";

export function DataSourceConfigForm({ plugin }: { plugin: PluginListEntry }) {
  const t = useT();
  const setPlugins = usePluginStore((s) => s.setPlugins);
  const [types, setTypes] = useState<DriverType[]>(DRIVER_TYPES);
  const [connections, setConnections] = useState<Record<string, ConnectionEntry>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState(DRIVER_TYPES[0]?.id ?? "");

  // Load driver types from API (falls back to hardcoded)
  useEffect(() => {
    fetch(`/api/plugins/datasource/types`, { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (d?.types?.length > 0) {
          setTypes(d.types);
          setNewType((prev) => prev || d.types[0].id);
        }
      })
      .catch(() => {});
  }, []);

  // Load current config
  useEffect(() => {
    const raw = plugin.config?.connections;
    if (raw && typeof raw === "object") {
      setConnections(raw as Record<string, ConnectionEntry>);
    }
  }, [plugin.config]);

  function updateField(name: string, key: string, value: string) {
    setConnections((prev) => ({
      ...prev,
      [name]: { ...prev[name]!, [key]: value },
    }));
    setDirty(true);
  }

  function removeConnection(name: string) {
    setConnections((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    setDirty(true);
  }

  function addConnection() {
    const name = newName.trim().replace(/[^a-zA-Z0-9_-]/g, "-");
    if (!name || connections[name]) return;
    setConnections((prev) => ({
      ...prev,
      [name]: { type: newType, description: "" },
    }));
    setNewName("");
    setAdding(false);
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    setError(null);
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
    setTestResults((prev) => ({ ...prev, [name]: { ok: false, msg: "Testing..." } }));
    try {
      // Must save first if dirty
      const res = await fetch(`/api/plugins/datasource/test/${encodeURIComponent(name)}`, { method: "POST", credentials: "include" });
      const data = await res.json();
      setTestResults((prev) => ({
        ...prev,
        [name]: { ok: !!data.ok, msg: data.ok ? "Connected" : data.error || "Failed" },
      }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [name]: { ok: false, msg: err instanceof Error ? err.message : String(err) },
      }));
    }
  }

  const names = Object.keys(connections);

  return (
    <div className="space-y-4">
      {names.length === 0 && !adding && (
        <p className="text-[12px] text-fg-faint">No data sources configured.</p>
      )}

      {names.map((name) => {
        const conn = connections[name]!;
        const driverType = types.find((t) => t.id === conn.type);
        const test = testResults[name];

        return (
          <div
            key={name}
            className="rounded-lg border border-border-subtle p-3 space-y-2"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-fg-default">{name}</span>
                <span className="rounded bg-bg-raised px-1.5 py-0.5 text-[10px] text-fg-faint">
                  {conn.type}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => testConnection(name)}
                  disabled={dirty}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-fg-muted hover:bg-bg-raised disabled:opacity-40"
                  title={dirty ? "Save first" : "Test connection"}
                >
                  <Zap size={12} /> Test
                </button>
                <button
                  type="button"
                  onClick={() => removeConnection(name)}
                  className="rounded p-1 text-fg-faint hover:bg-bg-raised hover:text-danger"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>

            {test && (
              <div className={`flex items-center gap-1 text-[11px] ${test.ok ? "text-success" : "text-danger"}`}>
                {test.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                {test.msg}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-0.5 block text-[11px] text-fg-faint">Description</label>
                <input
                  className={INPUT}
                  value={String(conn.description ?? "")}
                  onChange={(e) => updateField(name, "description", e.target.value)}
                  placeholder="Optional description"
                />
              </div>
              {driverType?.fields.map((f) => (
                <div key={f.key}>
                  <label className="mb-0.5 block text-[11px] text-fg-faint">
                    {f.label}{f.required ? " *" : ""}
                  </label>
                  <input
                    className={INPUT}
                    type={f.secret ? "password" : "text"}
                    value={String((conn as Record<string, unknown>)[f.key] ?? "")}
                    onChange={(e) => updateField(name, f.key, e.target.value)}
                    placeholder={f.placeholder}
                  />
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {adding ? (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-border-default p-3">
          <input
            className={INPUT + " max-w-[160px]"}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Connection name"
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && addConnection()}
          />
          <select
            className={INPUT + " max-w-[120px]"}
            value={newType}
            onChange={(e) => setNewType(e.target.value)}
          >
            {types.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={addConnection}
            disabled={!newName.trim()}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-brand-500 disabled:opacity-40"
          >
            Add
          </button>
          <button
            type="button"
            onClick={() => setAdding(false)}
            className="text-[12px] text-fg-faint hover:text-fg-default"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-border-default px-3 py-1.5 text-[12px] text-fg-muted hover:bg-bg-raised"
        >
          <Plus size={12} /> Add Data Source
        </button>
      )}

      {error && (
        <div className="rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-border-subtle pt-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null}
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}
