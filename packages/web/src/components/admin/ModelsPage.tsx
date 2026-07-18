// Models / provider catalog admin page (host-shipped, not a plugin
// contribution). Displays and maintains the provider catalog that
// lives in the GLOBAL config (~/.tianshu/config.json → models.providers)
// — the same shape you'd hand-edit in that file.
//
// Behaviour:
//   - GET  /api/admin/models/providers  → load (apiKeys masked).
//   - PUT  /api/admin/models/providers  → save the whole catalog.
//   - Config is re-read from disk per request, so an external edit to
//     config.json shows up on the next load (hit "Reload"), and a save
//     here is picked up by the next model resolution — no restart.
//
// Secrets: the real apiKey never reaches the browser. The server sends
// a mask sentinel for providers that have a key; leaving the field on
// the sentinel keeps the stored key, typing a new value replaces it,
// clearing it removes it.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  KeyRound,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";

const API_KEY_MASK = "__stored__";

interface ModelRow {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  supportsImages?: boolean;
  mode?: string;
  compat?: Record<string, unknown>;
}

interface ProviderRow {
  baseUrl?: string;
  api?: string;
  apiKey?: string; // mask sentinel on load
  group?: string;
  models?: ModelRow[];
  hasApiKey?: boolean;
}

interface ApiResponse {
  providers: Record<string, ProviderRow>;
  defaultModelId: string | null;
  defaultModel: string | null;
}

// Local editable shape: providers as an ordered array (so we can add /
// remove / keep insertion order in the UI) with a stable client key.
interface EditableProvider extends ProviderRow {
  _key: string; // stable react key
  id: string; // provider id (editable)
  // True once the user has typed in the apiKey field this session. On
  // load the field is EMPTY (never the mask sentinel), so an untouched
  // field with hasApiKey=true means "keep the stored key" and we send
  // the sentinel back; an edited field sends its literal value (or
  // empty = clear the key). This is what avoids the sentinel ever
  // reaching the <input> and getting corrupted on partial edits.
  _apiKeyEdited?: boolean;
}

const API_OPTIONS = [
  "anthropic-messages",
  "openai-completions",
  "google-generative-ai",
];

let keySeq = 0;
const nextKey = () => `p${keySeq++}`;

// Normalise a provider row from the server into the editable shape:
// the server sends apiKey = API_KEY_MASK when a key is stored; we
// blank the field and rely on hasApiKey + _apiKeyEdited instead so the
// sentinel is never bound to an input.
function toEditable(id: string, p: ProviderRow): EditableProvider {
  const stored = p.apiKey === API_KEY_MASK || p.hasApiKey;
  return {
    ...p,
    id,
    _key: nextKey(),
    apiKey: "",
    hasApiKey: !!stored,
    _apiKeyEdited: false,
  };
}

export default function ModelsPage() {
  const [providers, setProviders] = useState<EditableProvider[] | null>(null);
  const [defaultModelId, setDefaultModelId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch("/api/admin/models/providers", {
        credentials: "include",
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
      }
      const j = (await r.json()) as ApiResponse;
      const list: EditableProvider[] = Object.entries(j.providers ?? {}).map(
        ([id, p]) => toEditable(id, p),
      );
      setProviders(list);
      setDefaultModelId(j.defaultModelId ?? "");
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    (fn: (draft: EditableProvider[]) => EditableProvider[]) => {
      setProviders((cur) => (cur ? fn(cur) : cur));
      setDirty(true);
      setNotice(null);
    },
    [],
  );

  const save = useCallback(async () => {
    if (!providers) return;
    // Validate: unique non-empty provider ids; unique non-empty model ids.
    const ids = new Set<string>();
    for (const p of providers) {
      const pid = p.id.trim();
      if (!pid) {
        setError("Every provider needs an id.");
        return;
      }
      if (ids.has(pid)) {
        setError(`Duplicate provider id: "${pid}".`);
        return;
      }
      ids.add(pid);
      const mids = new Set<string>();
      for (const m of p.models ?? []) {
        const mid = (m.id ?? "").trim();
        if (!mid) {
          setError(`Provider "${pid}" has a model with no id.`);
          return;
        }
        if (mids.has(mid)) {
          setError(`Provider "${pid}" has duplicate model id "${mid}".`);
          return;
        }
        mids.add(mid);
      }
    }

    // Build the providers object keyed by id.
    const body: Record<string, ProviderRow> = {};
    for (const p of providers) {
      const { _key, id, hasApiKey, _apiKeyEdited, apiKey, ...rest } = p;
      void _key;
      // apiKey resolution:
      //   - untouched field + a stored key  → send the mask sentinel;
      //     the server preserves the existing secret.
      //   - user typed something            → send the literal value.
      //   - user cleared it (edited, empty)  → send "" to remove it.
      //   - no stored key, untouched         → "" (nothing to keep).
      const apiKeyOut =
        !_apiKeyEdited && hasApiKey ? API_KEY_MASK : (apiKey ?? "");
      body[id.trim()] = {
        ...rest,
        apiKey: apiKeyOut,
        models: (p.models ?? []).map((m) => ({ ...m, id: m.id.trim() })),
      };
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch("/api/admin/models/providers", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providers: body,
          defaultModelId: defaultModelId.trim(),
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(j.message || j.error || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as ApiResponse;
      const list: EditableProvider[] = Object.entries(j.providers ?? {}).map(
        ([id, p]) => toEditable(id, p),
      );
      setProviders(list);
      setDefaultModelId(j.defaultModelId ?? "");
      setDirty(false);
      setNotice("Saved to ~/.tianshu/config.json");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [providers, defaultModelId]);

  const totalModels = useMemo(
    () => (providers ?? []).reduce((n, p) => n + (p.models?.length ?? 0), 0),
    [providers],
  );

  // Options for the default-model picker, derived from the live
  // (possibly-unsaved) provider list so a just-added model is
  // selectable immediately. value is "<providerId>/<modelId>".
  const modelOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (const p of providers ?? []) {
      const pid = p.id.trim();
      if (!pid) continue;
      for (const m of p.models ?? []) {
        const mid = (m.id ?? "").trim();
        if (!mid) continue;
        const value = `${pid}/${mid}`;
        opts.push({ value, label: m.name ? `${m.name} — ${value}` : value });
      }
    }
    return opts;
  }, [providers]);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-fg-default">
            <Boxes size={18} className="text-link" />
            Models
          </h1>
          <p className="mt-1 max-w-3xl text-[12px] text-fg-faint">
            Provider catalog from{" "}
            <code className="text-fg-muted">~/.tianshu/config.json</code>{" "}
            (<code className="text-fg-muted">models.providers</code>).
            Editing here writes back to that file; an external edit to
            the file shows up after Reload.{" "}
            {providers && (
              <span className="text-fg-muted">
                {providers.length} provider(s), {totalModels} model(s).
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading || saving}
            className="flex items-center gap-1.5 rounded-md border border-border-default px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg-default disabled:opacity-50"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            Reload
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || loading || !dirty}
            className="flex items-center gap-1.5 rounded-md bg-link px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            <Save size={13} />
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-sm text-danger">
          <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}
      {notice && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-emerald-700/40 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200">
          <CheckCircle2 size={15} className="flex-shrink-0" />
          {notice}
        </div>
      )}

      {/* Default model */}
      <div className="mb-5 rounded-md border border-border-subtle bg-bg-elevated/30 p-4">
        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
          Default model
        </label>
        <select
          value={defaultModelId}
          onChange={(e) => {
            setDefaultModelId(e.target.value);
            setDirty(true);
            setNotice(null);
          }}
          className="w-full rounded-md border border-border-default bg-bg-base px-2.5 py-1.5 text-sm text-fg-default focus:border-link focus:outline-none"
        >
          <option value="">(none)</option>
          {modelOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {/* Preserve a stored value that isn't in the current model
              list (e.g. set externally, or its provider/model was just
              removed) so selecting it back is possible and it isn't
              silently dropped. */}
          {defaultModelId &&
            !modelOptions.some((o) => o.value === defaultModelId) && (
              <option value={defaultModelId}>{defaultModelId} (not in catalog)</option>
            )}
        </select>
        <p className="mt-1 text-[11px] text-fg-fainter">
          Pick from the configured models above. Add a model to a
          provider to make it selectable here.
        </p>
      </div>

      {loading && !providers && (
        <div className="rounded-md border border-dashed border-border-subtle px-4 py-10 text-center text-[12px] text-fg-faint">
          Loading providers…
        </div>
      )}

      <div className="space-y-3">
        {(providers ?? []).map((p) => (
          <ProviderCard
            key={p._key}
            provider={p}
            collapsed={!!collapsed[p._key]}
            onToggle={() =>
              setCollapsed((c) => ({ ...c, [p._key]: !c[p._key] }))
            }
            onChange={(patch) =>
              mutate((draft) =>
                draft.map((x) => (x._key === p._key ? { ...x, ...patch } : x)),
              )
            }
            onDelete={() =>
              mutate((draft) => draft.filter((x) => x._key !== p._key))
            }
          />
        ))}
      </div>

      <button
        type="button"
        onClick={() =>
          mutate((draft) => [
            ...draft,
            {
              _key: nextKey(),
              id: "",
              api: "anthropic-messages",
              group: "Cloud",
              apiKey: "",
              models: [],
              hasApiKey: false,
            },
          ])
        }
        className="mt-4 flex items-center gap-1.5 rounded-md border border-dashed border-border-default px-3 py-2 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg-default"
      >
        <Plus size={14} />
        Add provider
      </button>
    </div>
  );
}

function ProviderCard({
  provider,
  collapsed,
  onToggle,
  onChange,
  onDelete,
}: {
  provider: EditableProvider;
  collapsed: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<EditableProvider>) => void;
  onDelete: () => void;
}) {
  const models = provider.models ?? [];

  const setModel = (idx: number, patch: Partial<ModelRow>) =>
    onChange({
      models: models.map((m, i) => (i === idx ? { ...m, ...patch } : m)),
    });
  const addModel = () =>
    onChange({ models: [...models, { id: "" }] });
  const delModel = (idx: number) =>
    onChange({ models: models.filter((_, i) => i !== idx) });

  return (
    <div className="rounded-md border border-border-subtle bg-bg-elevated/40">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex-shrink-0 text-fg-faint hover:text-fg-default"
          aria-label={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
        </button>
        <input
          value={provider.id}
          onChange={(e) => onChange({ id: e.target.value })}
          placeholder="provider-id"
          className="w-44 rounded border border-border-default bg-bg-base px-2 py-1 text-sm font-medium text-fg-default placeholder:text-fg-fainter focus:border-link focus:outline-none"
        />
        <span className="text-[11px] text-fg-fainter">
          {models.length} model(s)
        </span>
        {provider.hasApiKey && (
          <span className="flex items-center gap-1 rounded-full bg-bg-raised px-2 py-0.5 text-[10px] text-fg-muted">
            <KeyRound size={10} /> key set
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onDelete}
          className="flex items-center gap-1 rounded-md border border-danger/60 px-2 py-1 text-[11px] font-medium text-danger hover:bg-danger hover:text-white"
        >
          <Trash2 size={12} /> Remove
        </button>
      </div>

      {!collapsed && (
        <div className="space-y-4 p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="API">
              <select
                value={provider.api ?? ""}
                onChange={(e) => onChange({ api: e.target.value })}
                className="w-full rounded border border-border-default bg-bg-base px-2 py-1.5 text-sm text-fg-default focus:border-link focus:outline-none"
              >
                <option value="">(unset)</option>
                {API_OPTIONS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
                {provider.api && !API_OPTIONS.includes(provider.api) && (
                  <option value={provider.api}>{provider.api}</option>
                )}
              </select>
            </Field>
            <Field label="Group">
              <input
                value={provider.group ?? ""}
                onChange={(e) => onChange({ group: e.target.value })}
                placeholder="Cloud / Local"
                className="w-full rounded border border-border-default bg-bg-base px-2 py-1.5 text-sm text-fg-default placeholder:text-fg-fainter focus:border-link focus:outline-none"
              />
            </Field>
            <Field label="API key">
              <div className="flex items-center gap-1.5">
                <input
                  type="password"
                  value={provider.apiKey ?? ""}
                  onChange={(e) =>
                    onChange({ apiKey: e.target.value, _apiKeyEdited: true })
                  }
                  placeholder={
                    provider.hasApiKey && !provider._apiKeyEdited
                      ? "•••• stored (leave blank to keep)"
                      : "unset"
                  }
                  className="w-full rounded border border-border-default bg-bg-base px-2 py-1.5 text-sm text-fg-default placeholder:text-fg-fainter focus:border-link focus:outline-none"
                />
                {provider.hasApiKey && !provider._apiKeyEdited && (
                  <button
                    type="button"
                    onClick={() =>
                      onChange({
                        apiKey: "",
                        hasApiKey: false,
                        _apiKeyEdited: true,
                      })
                    }
                    title="Clear the stored key"
                    className="flex-shrink-0 rounded border border-border-default px-2 py-1.5 text-[11px] text-fg-muted hover:bg-bg-hover hover:text-fg-default"
                  >
                    Clear
                  </button>
                )}
              </div>
            </Field>
          </div>
          <Field label="Base URL">
            <input
              value={provider.baseUrl ?? ""}
              onChange={(e) => onChange({ baseUrl: e.target.value })}
              placeholder="https://… (optional; supports ${VAR})"
              className="w-full rounded border border-border-default bg-bg-base px-2 py-1.5 text-sm text-fg-default placeholder:text-fg-fainter focus:border-link focus:outline-none"
            />
          </Field>

          {/* Models */}
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
              Models
            </div>
            <div className="space-y-2">
              {models.map((m, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-12 items-center gap-2 rounded border border-border-subtle bg-bg-base/50 px-2 py-1.5"
                >
                  <input
                    value={m.id}
                    onChange={(e) => setModel(idx, { id: e.target.value })}
                    placeholder="model-id"
                    className="col-span-4 rounded border border-border-default bg-bg-base px-2 py-1 text-[13px] text-fg-default placeholder:text-fg-fainter focus:border-link focus:outline-none"
                  />
                  <input
                    value={m.name ?? ""}
                    onChange={(e) => setModel(idx, { name: e.target.value })}
                    placeholder="Display name"
                    className="col-span-3 rounded border border-border-default bg-bg-base px-2 py-1 text-[13px] text-fg-default placeholder:text-fg-fainter focus:border-link focus:outline-none"
                  />
                  <input
                    value={m.contextWindow ?? ""}
                    onChange={(e) =>
                      setModel(idx, {
                        contextWindow: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      })
                    }
                    placeholder="ctx"
                    inputMode="numeric"
                    className="col-span-2 rounded border border-border-default bg-bg-base px-2 py-1 text-[13px] text-fg-default placeholder:text-fg-fainter focus:border-link focus:outline-none"
                  />
                  <label className="col-span-2 flex items-center gap-1 text-[11px] text-fg-muted">
                    <input
                      type="checkbox"
                      checked={!!m.reasoning}
                      onChange={(e) =>
                        setModel(idx, { reasoning: e.target.checked })
                      }
                    />
                    reasoning
                  </label>
                  <button
                    type="button"
                    onClick={() => delModel(idx)}
                    className="col-span-1 flex justify-center rounded p-1 text-danger hover:bg-danger hover:text-white"
                    aria-label="Remove model"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              {models.length === 0 && (
                <div className="rounded border border-dashed border-border-subtle px-3 py-3 text-center text-[11px] text-fg-fainter">
                  No models. Add one below.
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={addModel}
              className="mt-2 flex items-center gap-1 rounded border border-dashed border-border-default px-2 py-1 text-[11px] text-fg-muted hover:bg-bg-hover hover:text-fg-default"
            >
              <Plus size={12} /> Add model
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
        {label}
      </label>
      {children}
    </div>
  );
}
