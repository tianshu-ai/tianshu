// Worker agents — read-only listing.
//
// Edits used to live here. After PR-B / PR-C of the DB → fs
// migration, worker config is authored as files under
// `<tenant>/_tenant/config/workers/<slug>/` (`agent.json` +
// optional `SOUL.md` + optional `skills/` bundle). The chat
// agent's `tenant_config_*` tools are the canonical write
// surface; this page just shows what the loader sees so the user
// can sanity-check.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import { Bot, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";

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
  // Set of expanded slugs. UI is per-row collapsible like a
  // stacked accordion — we deliberately allow multiple open at
  // once because comparing two workers' tool sets is the
  // common task.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggle = useCallback((slug: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

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

  // Pre-derive a stable URI for the slot, used in the detail
  // banner so the user can copy-paste it into a chat to ask the
  // agent to edit the worker.
  const slotUri = (a: WorkerAgent): string =>
    `tenant-config:///workers/${a.builtinKey ?? a.id}/`;

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
              agents.flatMap((a) => {
                const isOpen = expanded.has(a.id);
                return [
                  <tr
                    key={`${a.id}-row`}
                    className="cursor-pointer hover:bg-gray-900/40"
                    onClick={() => toggle(a.id)}
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        {isOpen ? (
                          <ChevronDown size={12} className="text-gray-500" />
                        ) : (
                          <ChevronRight size={12} className="text-gray-500" />
                        )}
                        <span
                          className={`inline-flex h-2 w-2 rounded-full ${a.enabled ? "bg-emerald-500" : "bg-gray-600"}`}
                          title={a.enabled ? "enabled" : "disabled"}
                        />
                      </div>
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
                  </tr>,
                  isOpen ? (
                    <tr key={`${a.id}-detail`} className="bg-gray-950">
                      <td colSpan={6} className="px-3 pb-4 pt-1">
                        <AgentDetail agent={a} slotUri={slotUri(a)} />
                      </td>
                    </tr>
                  ) : null,
                ];
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AgentDetail({
  agent,
  slotUri,
}: {
  agent: WorkerAgent;
  slotUri: string;
}): ReactElement {
  const tools = useMemo(
    () => (agent.toolsAllow ? [...agent.toolsAllow].sort() : null),
    [agent.toolsAllow],
  );
  const skills = useMemo(
    () => (agent.skills ? [...agent.skills].sort() : null),
    [agent.skills],
  );
  return (
    <div className="mt-1 space-y-3 rounded-md border border-gray-800 bg-gray-900/40 p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500">
        <span>
          slot:{" "}
          <code className="rounded bg-gray-800 px-1.5 py-0.5 text-gray-300">
            {slotUri}
          </code>
        </span>
        {agent.modelId && (
          <span>
            model:{" "}
            <code className="rounded bg-gray-800 px-1.5 py-0.5 text-gray-300">
              {agent.modelId}
            </code>
          </span>
        )}
      </div>

      <DetailSection
        title="Allowed tools"
        empty="No restriction — every host tool the worker layer permits."
        items={tools}
      />
      <DetailSection
        title="Allowed skills"
        empty="No restriction — every host / plugin / tenant skill is visible."
        items={skills}
      />

      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          System prompt (SOUL.md)
        </div>
        {agent.systemPrompt ? (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-gray-950 p-2 text-[11px] leading-relaxed text-gray-300">
            {agent.systemPrompt}
          </pre>
        ) : (
          <div className="text-[11px] italic text-gray-500">
            (none — worker uses the kind default)
          </div>
        )}
      </div>
    </div>
  );
}

function DetailSection({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: readonly string[] | null;
}): ReactElement {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          {title}
        </span>
        {items && (
          <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">
            {items.length}
          </span>
        )}
      </div>
      {items === null ? (
        <div className="text-[11px] italic text-gray-500">{empty}</div>
      ) : items.length === 0 ? (
        <div className="text-[11px] italic text-gray-500">
          (empty list — worker can call nothing)
        </div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {items.map((name) => (
            <code
              key={name}
              className="rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-300"
            >
              {name}
            </code>
          ))}
        </div>
      )}
    </div>
  );
}

// Default export kept so the existing
// `import WorkerAgentsPage from "./worker-agents-page.js"` site in
// client.tsx keeps working without a churn-y rename.
export default WorkerAgentsPage;
