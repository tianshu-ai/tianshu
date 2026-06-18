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
  /** Server-computed list of skills this worker will actually
   *  see in `<available_skills>` at run-time. Combines host +
   *  plugin + tenant shared + per-worker fs layers, then
   *  applies the agent's allow-list. Always present in the
   *  GET /agents response post PR-C. */
  effectiveSkills?: string[];
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

interface CatalogEntry {
  name: string;
  description: string;
  pluginId: string;
}

export function WorkerAgentsPage(): ReactElement {
  const [agents, setAgents] = useState<WorkerAgent[]>([]);
  const [kinds, setKinds] = useState<WorkerKindDef[]>([]);
  // Effective host catalogues. Used to resolve `toolsAllow=null`
  // / `skillsAllow=null` to a concrete list in the detail panel
  // — "no restriction" means "every entry the host currently
  // exposes", and we show those entries explicitly so the user
  // can answer "what can this worker actually call?".
  const [toolCatalog, setToolCatalog] = useState<CatalogEntry[] | null>(
    null,
  );
  const [skillCatalog, setSkillCatalog] = useState<CatalogEntry[] | null>(
    null,
  );
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

  // While a PATCH is in flight we disable the dot so the operator
  // can't queue overlapping toggles. State stays per-slug instead
  // of global because two operators (or two tabs) might toggle
  // different agents at the same time.
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const toggleEnabled = useCallback(
    async (slug: string, currentEnabled: boolean) => {
      setTogglingId(slug);
      setError(null);
      try {
        const r = await fetch(
          `/api/p/workboard/agents/${encodeURIComponent(slug)}/enabled`,
          {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: !currentEnabled }),
          },
        );
        if (!r.ok) {
          const text = await r.text().catch(() => "");
          setError(`PATCH /agents/${slug}/enabled → HTTP ${r.status}${text ? ": " + text : ""}`);
          return;
        }
        // Optimistic local update + a refresh to pick up any
        // server-side reconciliation (timestamps, etc.).
        setAgents((prev) =>
          prev.map((a) => (a.id === slug ? { ...a, enabled: !currentEnabled } : a)),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setTogglingId(null);
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Three independent endpoints, parallel.
      const [agentsR, toolsR, skillsR] = await Promise.all([
        fetch("/api/p/workboard/agents", { credentials: "include" }),
        fetch("/api/tools", { credentials: "include" }),
        fetch("/api/skills", { credentials: "include" }),
      ]);
      if (!agentsR.ok) {
        setError(`GET /agents → HTTP ${agentsR.status}`);
        return;
      }
      const j = (await agentsR.json()) as AgentsResponse;
      setAgents(j.agents);
      setKinds(j.kinds);
      // Catalog endpoints are best-effort — if they fail we just
      // skip the "effective" expansion in the detail panel.
      if (toolsR.ok) {
        const tj = (await toolsR.json()) as { tools?: CatalogEntry[] };
        setToolCatalog(tj.tools ?? []);
      }
      if (skillsR.ok) {
        const sj = (await skillsR.json()) as { skills?: CatalogEntry[] };
        setSkillCatalog(sj.skills ?? []);
      }
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
                        <button
                          type="button"
                          disabled={togglingId === a.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            void toggleEnabled(a.id, a.enabled);
                          }}
                          className={`relative inline-flex h-2.5 w-2.5 items-center justify-center rounded-full transition-colors ${a.enabled ? "bg-emerald-500 hover:bg-emerald-400" : "bg-gray-600 hover:bg-gray-500"} disabled:opacity-50`}
                          title={
                            a.enabled
                              ? "Click to disable: pool will stop claiming new tasks for this agent"
                              : "Click to enable: pool will start claiming tasks again"
                          }
                        >
                          <span className="sr-only">
                            {a.enabled ? "Disable" : "Enable"} {a.name}
                          </span>
                        </button>
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
                        <AgentDetail
                          agent={a}
                          slotUri={slotUri(a)}
                          toolCatalog={toolCatalog}
                          skillCatalog={skillCatalog}
                        />
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

// Workboard's runtime-enforced deny set, mirrored client-side so
// the "effective tools" expansion is honest about what the worker
// actually gets to call. Source of truth is
// `plugins/workboard/src/worker/tool-policy.ts:WORKER_DENY_TOOLS`.
const WORKER_DENY_TOOLS_CLIENT = new Set<string>([
  "task_list",
  "task_create",
  "task_update",
  "task_move",
  "task_delete",
  "task_get_history",
]);

type EffectiveList =
  | { kind: "explicit"; items: string[] }
  | { kind: "effective"; items: string[] }
  | { kind: "unknown" };

function effective(
  allow: string[] | null,
  catalog: CatalogEntry[] | null,
  applyDeny: boolean,
): EffectiveList {
  if (allow) {
    const items = applyDeny
      ? allow.filter((n) => !WORKER_DENY_TOOLS_CLIENT.has(n))
      : [...allow];
    return { kind: "explicit", items: items.sort() };
  }
  if (catalog === null) return { kind: "unknown" };
  const items = catalog
    .map((e) => e.name)
    .filter((n) => (applyDeny ? !WORKER_DENY_TOOLS_CLIENT.has(n) : true))
    .sort();
  return { kind: "effective", items };
}

function AgentDetail({
  agent,
  slotUri,
  toolCatalog,
  skillCatalog,
}: {
  agent: WorkerAgent;
  slotUri: string;
  toolCatalog: CatalogEntry[] | null;
  skillCatalog: CatalogEntry[] | null;
}): ReactElement {
  const tools = useMemo(
    () => effective(agent.toolsAllow, toolCatalog, /* applyDeny */ true),
    [agent.toolsAllow, toolCatalog],
  );
  // Skills are now resolved server-side (server walks every
  // visible skill layer, applies the allow-list, returns names).
  // We keep `effective(...)` for tools because the catalog there
  // is genuinely global; for skills the per-worker layer matters
  // and only the server can see the right slug.
  const skills = useMemo<EffectiveList>(() => {
    if (agent.effectiveSkills) {
      const items = [...agent.effectiveSkills].sort();
      // "explicit" badge when the agent.json carries an
      // allow-list, else "effective".
      return agent.skills
        ? { kind: "explicit", items }
        : { kind: "effective", items };
    }
    // Older server (pre PR-C) didn't ship effectiveSkills.
    // Fall back to the tools-style catalog expansion so the UI
    // doesn't go blank.
    return effective(agent.skills, skillCatalog, /* applyDeny */ false);
  }, [agent.effectiveSkills, agent.skills, skillCatalog]);
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

      <DetailSection title="Allowed tools" data={tools} />
      <DetailSection title="Allowed skills" data={skills} />

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
  data,
}: {
  title: string;
  data: EffectiveList;
}): ReactElement {
  let badge: ReactElement | null = null;
  if (data.kind === "explicit") {
    badge = (
      <span
        className="rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300"
        title="agent.json declared this list explicitly"
      >
        explicit
      </span>
    );
  } else if (data.kind === "effective") {
    badge = (
      <span
        className="rounded bg-amber-950 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300"
        title="agent.json has no allow-list — worker sees every entry below"
      >
        effective (no restriction)
      </span>
    );
  }
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          {title}
        </span>
        {data.kind !== "unknown" && (
          <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">
            {data.items.length}
          </span>
        )}
        {badge}
      </div>
      {data.kind === "unknown" ? (
        <div className="text-[11px] italic text-gray-500">
          (catalog not loaded — reload the page)
        </div>
      ) : data.items.length === 0 ? (
        <div className="text-[11px] italic text-gray-500">
          (empty list — worker can call nothing)
        </div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {data.items.map((name) => (
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
