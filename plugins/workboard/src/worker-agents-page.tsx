// Worker agents admin page (workboard plugin).
//
// One row per agent. Builtin agents are seeded by the plugin on
// activation and can be edited freely; deletion is refused (the
// seed loop's invariants depend on the row persisting). User
// agents are fully CRUD'd here.
//
// Backend: GET/POST/PATCH/DELETE /api/p/workboard/agents.
// `kinds` in the GET payload comes from the workboard plugin's
// internal kind catalogue — the picker only offers kinds the
// pool's factory actually knows how to staff.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { WORKER_DENY_TOOLS_SET } from "./worker/tool-policy.js";

interface WorkerAgent {
  id: string;
  tenantId: string;
  kind: string;
  name: string;
  description: string | null;
  modelId: string | null;
  systemPrompt: string | null;
  toolsAllow: string[] | null;
  skills: string[] | null;
  source: "builtin" | "user";
  builtinKey: string | null;
  ownerUserId: string | null;
  enabled: boolean;
  overridesAt: number | null;
  createdAt: number;
  updatedAt: number;
}

type WorkerKindField =
  | "description"
  | "modelId"
  | "systemPrompt"
  | "toolsAllow"
  | "skills";

interface WorkerKind {
  id: string;
  displayName: string;
  description?: string;
  userCreatable?: boolean;
  pluginId: string;
  /** Optional fields this kind exposes; absent means "all". */
  fields?: WorkerKindField[];
}

interface ApiResponse {
  agents: WorkerAgent[];
  kinds: WorkerKind[];
}

interface EditDraft {
  id: string | null; // null = new
  kind: string;
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
  toolsAllow: string;
  skills: string;
}

const EMPTY_DRAFT: EditDraft = {
  id: null,
  kind: "",
  name: "",
  description: "",
  modelId: "",
  systemPrompt: "",
  toolsAllow: "",
  skills: "",
};

function agentToDraft(a: WorkerAgent): EditDraft {
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    description: a.description ?? "",
    modelId: a.modelId ?? "",
    systemPrompt: a.systemPrompt ?? "",
    toolsAllow: (a.toolsAllow ?? []).join(", "),
    skills: (a.skills ?? []).join(", "),
  };
}

function parseList(s: string): string[] | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  return trimmed
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

export default function WorkerAgentsPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [saving, setSaving] = useState(false);
  // Models list for the model-id dropdown. Pulled from the host's
  // /api/models endpoint exactly once when the page mounts. We
  // fall back to the empty list (text input) if the call fails so
  // a misconfigured host doesn't lock the editor.
  const [models, setModels] = useState<
    { id: string; name: string; provider: string }[]
  >([]);
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  // Tool / skill catalogues for the ChipPicker. Empty = picker
  // falls back to its legacy freetext input.
  const [allTools, setAllTools] = useState<
    { name: string; description: string; pluginId: string }[]
  >([]);
  const [allSkills, setAllSkills] = useState<
    { name: string; description: string; pluginId: string }[]
  >([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/p/workboard/agents", {
        credentials: "include",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as ApiResponse;
      setData(j);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // One-shot host catalog fetch on mount. Plugin client bundles
  // share the same origin/cookies, so /api/* is reachable
  // directly. Three independent fetches — partial failure leaves
  // the affected picker in freetext fallback mode but doesn't
  // block the others.
  useEffect(() => {
    let cancelled = false;
    async function loadJsonOrNull(url: string): Promise<unknown> {
      try {
        const r = await fetch(url, { credentials: "include" });
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      }
    }
    void Promise.all([
      loadJsonOrNull("/api/models"),
      loadJsonOrNull("/api/tools"),
      loadJsonOrNull("/api/skills"),
    ]).then(([modelsJ, toolsJ, skillsJ]) => {
      if (cancelled) return;
      const mj = modelsJ as
        | {
            models?: { id: string; name: string; provider: string }[];
            defaultModel?: string | null;
          }
        | null;
      if (mj) {
        setModels(
          (mj.models ?? []).map((m) => ({
            id: m.id,
            name: m.name,
            provider: m.provider,
          })),
        );
        setDefaultModelId(mj.defaultModel ?? null);
      }
      const tj = toolsJ as
        | {
            tools?: { name: string; description: string; pluginId: string }[];
          }
        | null;
      if (tj) {
        // Hide orchestration-only workboard tools (task_list /
        // task_create / ...). Workers run a single task; those
        // tools belong to the chat orchestrator. Runtime denies
        // them anyway (worker/pool.ts), so listing them here
        // would just be a misleading checkbox the user can't
        // actually grant. Single source of truth lives in
        // ./worker/tool-policy.ts.
        setAllTools(
          (tj.tools ?? []).filter(
            (t) => !WORKER_DENY_TOOLS_SET.has(t.name),
          ),
        );
      }
      const sj = skillsJ as
        | {
            skills?: { name: string; description: string; pluginId: string }[];
          }
        | null;
      if (sj) setAllSkills(sj.skills ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const userCreatableKinds = useMemo(
    () =>
      (data?.kinds ?? []).filter((k) => k.userCreatable !== false),
    [data?.kinds],
  );

  function startNew() {
    if (userCreatableKinds.length === 0) return;
    setEditing({
      ...EMPTY_DRAFT,
      kind: userCreatableKinds[0]!.id,
    });
  }

  function startEdit(a: WorkerAgent) {
    setEditing(agentToDraft(a));
  }

  async function save() {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      const allow = allowedFieldsFor(editing.kind, data?.kinds ?? []);
      const body: Record<string, unknown> = { name: editing.name };
      if (allow.has("description")) {
        body.description = editing.description.trim() || null;
      }
      if (allow.has("modelId")) {
        body.modelId = editing.modelId.trim() || null;
      }
      if (allow.has("systemPrompt")) {
        body.systemPrompt = editing.systemPrompt.trim() || null;
      }
      if (allow.has("toolsAllow")) {
        body.toolsAllow = parseList(editing.toolsAllow);
      }
      if (allow.has("skills")) {
        body.skills = parseList(editing.skills);
      }
      let r: Response;
      if (editing.id) {
        r = await fetch(`/api/p/workboard/agents/${editing.id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        body.kind = editing.kind;
        r = await fetch(`/api/p/workboard/agents`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        let parsed: { error?: string } | null = null;
        try {
          parsed = text ? (JSON.parse(text) as { error?: string }) : null;
        } catch {
          /* ignore */
        }
        throw new Error(parsed?.error ?? `HTTP ${r.status}`);
      }
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(a: WorkerAgent) {
    if (a.source === "builtin") return;
    if (
      !window.confirm(
        `Delete worker agent "${a.name}"? The pool will rebuild without it.`,
      )
    )
      return;
    try {
      const r = await fetch(`/api/p/workboard/agents/${a.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function setEnabled(a: WorkerAgent, next: boolean) {
    setError(null);
    try {
      const r = await fetch(`/api/p/workboard/agents/${a.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function reset(a: WorkerAgent) {
    if (a.source !== "builtin") return;
    if (
      !window.confirm(
        `Reset "${a.name}" back to the plugin's seeded values? Your edits will be lost.`,
      )
    )
      return;
    try {
      const r = await fetch(`/api/p/workboard/agents/${a.id}/reset`, {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const agents = data?.agents ?? [];

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-gray-100">
            <Bot size={18} className="text-brand-400" />
            Worker agents
          </h1>
          <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-gray-500">
            Configurable worker instances. The workboard pool dispatches
            each claimed task to the matching agent; per-agent
            overrides (system prompt, model, allowed tools, skills)
            layer on top of the kind defaults. Builtin rows are
            seeded by their owning plugin — edit freely, or use{" "}
            <span className="text-gray-400">Reset</span> to drop your
            edits.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="flex items-center gap-1 rounded-md border border-gray-700 px-2.5 py-1.5 text-[12px] text-gray-300 hover:bg-gray-800 disabled:opacity-50"
            title="Reload"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            Reload
          </button>
          <button
            type="button"
            onClick={startNew}
            disabled={userCreatableKinds.length === 0}
            className="flex items-center gap-1 rounded-md bg-brand-600 px-2.5 py-1.5 text-[12px] font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-400"
            title={
              userCreatableKinds.length === 0
                ? "No plugin contributes a user-creatable workerKind yet."
                : "Create a new worker agent"
            }
          >
            <Plus size={12} />
            New agent
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-rose-700/50 bg-rose-950/40 p-3 text-[12px] text-rose-200">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-gray-800">
        <table className="w-full text-left text-[12px] text-gray-300">
          <thead className="bg-gray-900/50 text-[11px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2">On</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Model</th>
              <th className="px-3 py-2">Tools</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {agents.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-6 text-center text-[12px] text-gray-500"
                >
                  No worker agents yet. Enable the workboard plugin to
                  seed the echo demo, or click "New agent".
                </td>
              </tr>
            )}
            {agents.map((a) => (
              <tr
                key={a.id}
                className={`border-t border-gray-800 hover:bg-gray-900/30 ${
                  a.enabled ? "" : "opacity-50"
                }`}
              >
                <td className="px-3 py-2">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={a.enabled}
                    onClick={() => void setEnabled(a, !a.enabled)}
                    title={
                      a.enabled
                        ? "Disable: pool stops scheduling for this agent (config preserved)."
                        : "Enable: pool will allocate a worker slot on next rebuild."
                    }
                    className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                      a.enabled ? "bg-emerald-500" : "bg-gray-700"
                    }`}
                  >
                    <span
                      className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                        a.enabled ? "translate-x-3.5" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium text-gray-100">{a.name}</div>
                  {a.description && (
                    <div className="text-[11px] text-gray-500">{a.description}</div>
                  )}
                </td>
                <td className="px-3 py-2">
                  <code className="rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-300">
                    {a.kind}
                  </code>
                </td>
                <td className="px-3 py-2">
                  {a.source === "builtin" ? (
                    <span className="rounded bg-indigo-950 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-300">
                      builtin
                      {a.overridesAt && (
                        <span className="ml-1 text-indigo-400/70">
                          (edited)
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="rounded bg-emerald-950 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                      user
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-400">
                  {a.modelId ?? <span className="text-gray-600">default</span>}
                </td>
                <td className="px-3 py-2 text-gray-400">
                  {a.toolsAllow && a.toolsAllow.length > 0 ? (
                    <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[11px]">
                      {a.toolsAllow.length}
                    </span>
                  ) : (
                    <span className="text-gray-600">none</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => startEdit(a)}
                      title="Edit"
                      className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-gray-100"
                    >
                      <Pencil size={12} />
                    </button>
                    {a.source === "builtin" ? (
                      <button
                        type="button"
                        onClick={() => void reset(a)}
                        title="Reset to seeded values"
                        disabled={a.overridesAt === null}
                        className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-gray-100 disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        <RotateCcw size={12} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void remove(a)}
                        title="Delete"
                        className="rounded p-1 text-rose-400 hover:bg-rose-950/40"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditDialog
          draft={editing}
          kinds={userCreatableKinds}
          allKinds={data?.kinds ?? []}
          isNew={editing.id === null}
          saving={saving}
          models={models}
          defaultModelId={defaultModelId}
          allTools={allTools}
          allSkills={allSkills}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSave={() => void save()}
        />
      )}
    </div>
  );
}

const ALL_OPTIONAL_FIELDS: WorkerKindField[] = [
  "description",
  "modelId",
  "systemPrompt",
  "toolsAllow",
  "skills",
];

function allowedFieldsFor(
  kindId: string,
  kinds: WorkerKind[],
): Set<WorkerKindField> {
  const def = kinds.find((k) => k.id === kindId);
  return new Set(def?.fields ?? ALL_OPTIONAL_FIELDS);
}

function EditDialog({
  draft,
  kinds,
  allKinds,
  isNew,
  saving,
  models,
  defaultModelId,
  allTools,
  allSkills,
  onChange,
  onCancel,
  onSave,
}: {
  draft: EditDraft;
  /** Kinds the picker offers when creating a new agent (already
   *  filtered to userCreatable). */
  kinds: WorkerKind[];
  /** Every kind, including non-userCreatable ones, used to look up
   *  the field whitelist for the current draft (the user might be
   *  editing a builtin echo agent whose kind isn't in `kinds`). */
  allKinds: WorkerKind[];
  isNew: boolean;
  saving: boolean;
  /** Host's known models, fetched once at page mount via /api/models.
   *  Empty array means we couldn't reach the host (or none configured)
   *  — the dialog falls back to a freetext input. */
  models: { id: string; name: string; provider: string }[];
  /** Default model id from /api/models; surfaced as a hint after the
   *  empty option in the picker. */
  defaultModelId: string | null;
  /** Tool / skill catalogues from the host. Empty = ChipPicker
   *  falls back to its legacy freetext input. */
  allTools: { name: string; description: string; pluginId: string }[];
  allSkills: { name: string; description: string; pluginId: string }[];
  onChange: (next: EditDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const allow = allowedFieldsFor(draft.kind, allKinds);
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/60 p-4">
      <div className="mt-12 w-full max-w-xl rounded-lg border border-gray-800 bg-gray-950 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-100">
            {isNew ? "New worker agent" : "Edit worker agent"}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-gray-100"
          >
            <X size={14} />
          </button>
        </div>

        <div className="space-y-3 p-4">
          {isNew && (
            <Field label="Kind">
              <select
                value={draft.kind}
                onChange={(e) => onChange({ ...draft, kind: e.target.value })}
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-[12px] text-gray-100"
              >
                {kinds.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.displayName} ({k.pluginId})
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Name">
            <input
              type="text"
              value={draft.name}
              onChange={(e) => onChange({ ...draft, name: e.target.value })}
              className="w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-[12px] text-gray-100"
            />
          </Field>

          {allow.has("description") && (
            <Field label="Description">
              <input
                type="text"
                value={draft.description}
                onChange={(e) =>
                  onChange({ ...draft, description: e.target.value })
                }
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-[12px] text-gray-100"
              />
            </Field>
          )}

          {allow.has("modelId") && (
            <Field
              label="Model"
              hint={
                defaultModelId
                  ? `Empty = use tenant default (${defaultModelId}).`
                  : "Empty = use tenant default model."
              }
            >
              {models.length > 0 ? (
                <select
                  value={draft.modelId}
                  onChange={(e) =>
                    onChange({ ...draft, modelId: e.target.value })
                  }
                  className="w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-[12px] text-gray-100"
                >
                  <option value="">
                    — use tenant default 
                    {defaultModelId ? `(${defaultModelId})` : ""}
                  </option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} — {m.id}
                    </option>
                  ))}
                </select>
              ) : (
                // Models list unreachable / empty: fall back to
                // freetext so the user can still type an id rather
                // than be stuck with no input at all.
                <input
                  type="text"
                  value={draft.modelId}
                  onChange={(e) =>
                    onChange({ ...draft, modelId: e.target.value })
                  }
                  placeholder="sap-proxy/claude-sonnet-4-6"
                  className="w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-[12px] text-gray-100"
                />
              )}
            </Field>
          )}

          {allow.has("systemPrompt") && (
            <Field
              label="System prompt"
              hint="Empty = host default. Builtin LLM workers ship with a SOUL-style worker prompt; clear this field to fall back to it."
            >
              <textarea
                value={draft.systemPrompt}
                onChange={(e) =>
                  onChange({ ...draft, systemPrompt: e.target.value })
                }
                rows={4}
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-[12px] text-gray-100"
              />
            </Field>
          )}

          {allow.has("toolsAllow") && (
            <Field
              label="Allowed tools"
              hint="Empty = unlimited (every tool the host exposes; task_complete is always injected)."
            >
              <ChipPicker
                value={draft.toolsAllow}
                onChange={(next) =>
                  onChange({ ...draft, toolsAllow: next })
                }
                catalog={allTools}
                emptyHint="— unlimited (no restriction)"
              />
            </Field>
          )}

          {allow.has("skills") && (
            <Field
              label="Skills"
              hint="Empty = unlimited (every skill the host exposes)."
            >
              <ChipPicker
                value={draft.skills}
                onChange={(next) => onChange({ ...draft, skills: next })}
                catalog={allSkills}
                emptyHint="— unlimited (no restriction)"
              />
            </Field>
          )}

          {/* Edge case: kind has only `name` allowed (e.g. a future
              kind that's pure metadata). Show a hint so the form
              doesn't look broken. */}
          {allow.size === 0 && (
            <p className="text-[11px] text-gray-500">
              No additional settings for this worker type.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-800 px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-md border border-gray-700 px-2.5 py-1.5 text-[12px] text-gray-300 hover:bg-gray-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving || !draft.name.trim() || !draft.kind}
            className="rounded-md bg-brand-600 px-2.5 py-1.5 text-[12px] font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:bg-gray-700"
          >
            {saving ? "Saving…" : isNew ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </div>
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
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        {label}
      </span>
      {children}
      {hint && (
        <span className="mt-1 block text-[11px] text-gray-600">{hint}</span>
      )}
    </label>
  );
}

/**
 * Chip-style multi-select for the tools / skills allow-lists.
 *
 * - The model in the parent state is a comma-separated string
 *   (so the existing parseList path on save still works). We
 *   read it as `Set<string>` for fast membership checks and
 *   write back a normalised ", "-joined string on every change.
 * - Catalogue (everything the host exposes) is shown in a scrollable
 *   list under a search box; click an entry to add / remove.
 *   Selected entries are mirrored above as removable chips.
 * - If `catalog` is empty (host endpoint failed), we fall back
 *   to the legacy freetext input so the editor isn't unusable.
 */
function ChipPicker({
  value,
  onChange,
  catalog,
  emptyHint,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  catalog: { name: string; description: string; pluginId: string }[];
  emptyHint?: string;
  placeholder?: string;
}) {
  const [search, setSearch] = useState("");

  // Parse the comma-separated string into a stable order set.
  const selected = useMemo(() => {
    const parts = value
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    return parts;
  }, [value]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const writeBack = useCallback(
    (next: string[]) => {
      // Dedup while preserving order.
      const seen = new Set<string>();
      const out: string[] = [];
      for (const n of next) {
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(n);
      }
      onChange(out.join(", "));
    },
    [onChange],
  );

  const toggle = (name: string) => {
    if (selectedSet.has(name)) {
      writeBack(selected.filter((n) => n !== name));
    } else {
      writeBack([...selected, name]);
    }
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.pluginId.toLowerCase().includes(q),
    );
  }, [catalog, search]);

  // Catalog unreachable → legacy freetext input. Keeps the page
  // usable when the host endpoints are not yet wired or fail.
  if (catalog.length === 0) {
    return (
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "comma, separated, names"}
        className="w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-[12px] text-gray-100"
      />
    );
  }

  // Surface orphaned selections (entries selected but no longer in
  // catalog — typically after a plugin disable) at the top of the
  // list so the user can clear them. Otherwise everything renders
  // in the single scrollable list.
  const catalogNames = new Set(catalog.map((e) => e.name));
  const orphaned = selected.filter((n) => !catalogNames.has(n));

  // Header bar: count + select-all / clear shortcuts. "Select
  // all" only operates on currently visible (post-search)
  // entries, so a search-narrowed pick is possible without
  // scrolling.
  const visibleNames = visible.map((v) => v.name);
  const allVisibleSelected =
    visibleNames.length > 0 &&
    visibleNames.every((n) => selectedSet.has(n));

  return (
    <div className="rounded-md border border-gray-700 bg-gray-900 p-1.5">
      <div className="mb-1 flex items-center gap-1.5">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="flex-1 rounded border border-gray-800 bg-gray-950 px-1.5 py-0.5 text-[11px] text-gray-100"
        />
        <span className="text-[10px] text-gray-500">
          {selected.length}/{catalog.length} selected
        </span>
        <button
          type="button"
          onClick={() => {
            if (allVisibleSelected) {
              writeBack(selected.filter((n) => !visibleNames.includes(n)));
            } else {
              writeBack([...selected, ...visibleNames]);
            }
          }}
          disabled={visibleNames.length === 0}
          className="rounded border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-300 hover:border-gray-500 hover:bg-gray-800 disabled:opacity-50"
          title={allVisibleSelected ? "Deselect all visible" : "Select all visible"}
        >
          {allVisibleSelected ? "clear" : "all"}
        </button>
      </div>
      {selected.length === 0 && (
        <div className="px-1.5 py-0.5 text-[11px] italic text-gray-500">
          {emptyHint ?? "None selected."}
        </div>
      )}
      {orphaned.length > 0 && (
        <div className="mb-1 rounded border border-amber-700/60 bg-amber-950/20 px-1.5 py-1 text-[10px] text-amber-200">
          <div className="mb-0.5 font-semibold">
            {orphaned.length} no longer in catalog
          </div>
          <div className="flex flex-wrap gap-1">
            {orphaned.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => toggle(name)}
                className="flex items-center gap-1 rounded-full border border-amber-700 bg-amber-950/40 px-1.5 py-0 text-[10px] text-amber-200 hover:border-rose-500 hover:bg-rose-950/40 hover:text-rose-200"
                title="Click to remove"
              >
                <span className="font-mono">{name}</span>
                <X size={9} />
              </button>
            ))}
          </div>
        </div>
      )}
      <ul className="max-h-56 overflow-y-auto">
        {visible.length === 0 && (
          <li className="px-1.5 py-1 text-[11px] italic text-gray-500">
            No matches.
          </li>
        )}
        {visible.map((entry) => {
          const checked = selectedSet.has(entry.name);
          return (
            <li key={entry.name}>
              <button
                type="button"
                onClick={() => toggle(entry.name)}
                className={`flex w-full items-start gap-1.5 rounded px-1.5 py-1 text-left text-[11px] ${
                  checked
                    ? "bg-emerald-950/30 text-emerald-100"
                    : "text-gray-200 hover:bg-gray-800"
                }`}
              >
                <span
                  className={`mt-px flex h-3 w-3 shrink-0 items-center justify-center rounded border ${
                    checked
                      ? "border-emerald-500 bg-emerald-500/30 text-emerald-200"
                      : "border-gray-600"
                  }`}
                >
                  {checked ? "✓" : ""}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="font-mono">{entry.name}</span>
                  <span className="ml-1.5 text-[10px] text-gray-500">
                    {entry.pluginId}
                  </span>
                  {entry.description && (
                    <span className="block truncate text-[10px] text-gray-500">
                      {entry.description}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
