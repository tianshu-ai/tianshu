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
  overridesAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface WorkerKind {
  id: string;
  displayName: string;
  description?: string;
  userCreatable?: boolean;
  pluginId: string;
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
      const body: Record<string, unknown> = {
        name: editing.name,
        description: editing.description.trim() || null,
        modelId: editing.modelId.trim() || null,
        systemPrompt: editing.systemPrompt.trim() || null,
        toolsAllow: parseList(editing.toolsAllow),
        skills: parseList(editing.skills),
      };
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
                  colSpan={6}
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
                className="border-t border-gray-800 hover:bg-gray-900/30"
              >
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
          isNew={editing.id === null}
          saving={saving}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSave={() => void save()}
        />
      )}
    </div>
  );
}

function EditDialog({
  draft,
  kinds,
  isNew,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  draft: EditDraft;
  kinds: WorkerKind[];
  isNew: boolean;
  saving: boolean;
  onChange: (next: EditDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
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

          <Field label="Model id" hint="Empty = use tenant default model.">
            <input
              type="text"
              value={draft.modelId}
              onChange={(e) =>
                onChange({ ...draft, modelId: e.target.value })
              }
              placeholder="sap-proxy/claude-sonnet-4-6"
              className="w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-[12px] text-gray-100"
            />
          </Field>

          <Field label="System prompt">
            <textarea
              value={draft.systemPrompt}
              onChange={(e) =>
                onChange({ ...draft, systemPrompt: e.target.value })
              }
              rows={4}
              className="w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-[12px] text-gray-100"
            />
          </Field>

          <Field
            label="Allowed tools"
            hint="Comma-separated tool names. Empty = no tools."
          >
            <input
              type="text"
              value={draft.toolsAllow}
              onChange={(e) =>
                onChange({ ...draft, toolsAllow: e.target.value })
              }
              placeholder="task_list, web_fetch"
              className="w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-[12px] text-gray-100"
            />
          </Field>

          <Field label="Skills" hint="Comma-separated skill names.">
            <input
              type="text"
              value={draft.skills}
              onChange={(e) => onChange({ ...draft, skills: e.target.value })}
              placeholder="research-howto"
              className="w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-[12px] text-gray-100"
            />
          </Field>
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
