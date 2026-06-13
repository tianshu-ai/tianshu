// Worker agents — read-only listing.
//
// Edits used to live here. After PR-B / PR-C of the DB → fs
// migration, worker config is authored as files under
// `<tenant>/_tenant/config/workers/<slug>/` (`agent.json` +
// optional `SOUL.md` + optional `skills/` bundle). The chat
// agent's `tenant_config_*` tools are the canonical write
// surface; this page just shows what the loader sees so the user
// can sanity-check.

import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Bot, RefreshCw } from "lucide-react";

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
  enabled: boolean;
  overridesAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface WorkerKindDef {
  id: string;
  displayName: string;
  description?: string;
  userCreatable?: boolean;
  fields: string[];
}

interface AgentsResponse {
  agents: WorkerAgent[];
  kinds: WorkerKindDef[];
}

export function WorkerAgentsPage(): ReactElement {
  const [agents, setAgents] = useState<WorkerAgent[]>([]);
  const [kinds, setKinds] = useState<WorkerKindDef[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/p/workboard/agents", {
        credentials: "include",
      });
      if (!r.ok) {
        setError(`GET /agents → HTTP ${r.status}`);
        return;
      }
      const j = (await r.json()) as AgentsResponse;
      setAgents(j.agents);
      setKinds(j.kinds);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const kindLabel = (id: string): string =>
    kinds.find((k) => k.id === id)?.displayName ?? id;

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-4 rounded-md border border-amber-900/40 bg-amber-950/30 px-3 py-2 text-[12px] leading-relaxed text-amber-200/90">
        <div className="font-semibold text-amber-100">
          Read-only listing — edit on disk
        </div>
        <p className="mt-1 text-amber-200/70">
          Worker config lives at{" "}
          <code className="rounded bg-amber-950/60 px-1 py-0.5 text-amber-100">
            _tenant/config/workers/&lt;slug&gt;/
          </code>
          . Each worker is a directory with{" "}
          <code className="text-amber-100">agent.json</code> and an optional{" "}
          <code className="text-amber-100">SOUL.md</code> /{" "}
          <code className="text-amber-100">skills/</code>. Edit the files
          directly, or ask the chat agent to do it via{" "}
          <code className="text-amber-100">tenant_config_write</code>. Pool
          picks up changes on next activate; a fs watcher follow-up will
          make this live.
        </p>
      </div>

      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-gray-100">
            <Bot size={18} className="text-brand-400" />
            Worker agents
          </h1>
          <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-gray-500">
            Inventory the workboard pool currently sees. Filesystem rows
            shadow same-slug DB rows; legacy DB rows still present here
            haven't been edited or aren't yet picked up by the merger.
          </p>
        </div>
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
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-900/40 bg-red-950/40 px-3 py-2 text-[12px] text-red-300">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-gray-800">
        <table className="min-w-full divide-y divide-gray-800 text-[12px]">
          <thead className="bg-gray-900/60 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            <tr>
              <th className="px-3 py-2 text-left">State</th>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Kind</th>
              <th className="px-3 py-2 text-left">Source</th>
              <th className="px-3 py-2 text-left">Model</th>
              <th className="px-3 py-2 text-left">Slug</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {agents.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-8 text-center text-gray-500"
                >
                  {loading ? "Loading…" : "No worker agents."}
                </td>
              </tr>
            ) : (
              agents.map((a) => (
                <tr key={a.id} className="hover:bg-gray-900/40">
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex h-2 w-2 rounded-full ${a.enabled ? "bg-emerald-500" : "bg-gray-600"}`}
                      title={a.enabled ? "enabled" : "disabled"}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-100">{a.name}</div>
                    {a.description && (
                      <div className="text-[11px] text-gray-500">
                        {a.description}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <code className="rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-300">
                      {kindLabel(a.kind)}
                    </code>
                  </td>
                  <td className="px-3 py-2">
                    {a.source === "builtin" ? (
                      <span className="rounded bg-indigo-950 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-300">
                        builtin
                      </span>
                    ) : (
                      <span className="rounded bg-gray-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                        user
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-gray-400">
                    {a.modelId ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-gray-500">
                    {a.builtinKey ?? a.id}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Default export kept so the existing
// `import WorkerAgentsPage from "./worker-agents-page.js"` site in
// client.tsx keeps working without a churn-y rename.
export default WorkerAgentsPage;
