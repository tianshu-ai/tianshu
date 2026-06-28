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
import {
  Bot,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Settings,
  X,
} from "lucide-react";
import { PluginConfigForm } from "@tianshu-ai/plugin-sdk/client";

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
  // "Configure" modal toggle. Click the gear button in the page
  // header to open the auto-generated PluginConfigForm (pool
  // concurrency caps + echo/llm worker type defaults). Modal
  // mirrors the microsandbox plugin's ConfigureSandboxDialog
  // pattern so the page itself stays focused on the worker list.
  const [configOpen, setConfigOpen] = useState(false);
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
          <h1 className="flex items-center gap-2 text-xl font-semibold text-fg-default">
            <Bot size={18} className="text-brand-400" />
            Worker agents
          </h1>
          <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-fg-faint">
            Inventory the workboard pool currently sees. Filesystem rows
            shadow same-slug DB rows; legacy DB rows still present here
            haven't been edited or aren't yet picked up by the merger.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setConfigOpen(true)}
            className="flex items-center gap-1 rounded-md border border-border-default px-2.5 py-1.5 text-[12px] text-fg-muted hover:bg-bg-raised"
            title="Edit pool concurrency caps and worker type defaults"
          >
            <Settings size={12} />
            Configure
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="flex items-center gap-1 rounded-md border border-border-default px-2.5 py-1.5 text-[12px] text-fg-muted hover:bg-bg-raised disabled:opacity-50"
            title="Reload"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            Reload
          </button>
        </div>
      </div>

      <ConfigureWorkboardDialog
        open={configOpen}
        onClose={() => setConfigOpen(false)}
      />

      {error && (
        <div className="mb-4 rounded-md border border-red-900/40 bg-red-950/40 px-3 py-2 text-[12px] text-red-300">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-border-subtle">
        <table className="min-w-full divide-y divide-gray-800 text-[12px]">
          <thead className="bg-bg-elevated/60 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
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
                  className="px-3 py-8 text-center text-fg-faint"
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
                    className="cursor-pointer hover:bg-bg-elevated/40"
                    onClick={() => toggle(a.id)}
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-3">
                        {isOpen ? (
                          <ChevronDown size={12} className="text-fg-faint" />
                        ) : (
                          <ChevronRight size={12} className="text-fg-faint" />
                        )}
                        {/* iOS-style toggle: clearly affords "this
                            is a switch you can flip". Replaces the
                            old static green/grey dot, which was a
                            common point of confusion (operators
                            didn't realise it was clickable). */}
                        <button
                          type="button"
                          role="switch"
                          aria-checked={a.enabled}
                          disabled={togglingId === a.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            void toggleEnabled(a.id, a.enabled);
                          }}
                          className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border transition-colors ${
                            a.enabled
                              ? "border-emerald-500/60 bg-emerald-500/80 hover:bg-emerald-500"
                              : "border-border-default bg-bg-hover hover:bg-border-strong"
                          } disabled:cursor-not-allowed disabled:opacity-50`}
                          title={
                            a.enabled
                              ? "Enabled — click to disable. The pool will stop claiming new tasks for this agent."
                              : "Disabled — click to enable. The pool will resume claiming tasks."
                          }
                        >
                          <span className="sr-only">
                            {a.enabled ? "Disable" : "Enable"} {a.name}
                          </span>
                          <span
                            className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${
                              a.enabled ? "translate-x-3" : "translate-x-0.5"
                            }`}
                          />
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-fg-default">{a.name}</div>
                      {a.description && (
                        <div className="text-[11px] text-fg-faint">
                          {a.description}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <code className="rounded bg-bg-raised px-1.5 py-0.5 text-[11px] text-fg-muted">
                        {kindLabel(a.kind)}
                      </code>
                    </td>
                    <td className="px-3 py-2">
                      {a.source === "builtin" ? (
                        <span className="rounded bg-indigo-950 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-300">
                          builtin
                        </span>
                      ) : (
                        <span className="rounded bg-bg-raised px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
                          user
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-fg-muted">
                      {a.modelId ?? "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-fg-faint">
                      {a.builtinKey ?? a.id}
                    </td>
                  </tr>,
                  isOpen ? (
                    <tr key={`${a.id}-detail`} className="bg-bg-base">
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
    <div className="mt-1 space-y-3 rounded-md border border-border-subtle bg-bg-elevated/40 p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-fg-faint">
        <span>
          slot:{" "}
          <code className="rounded bg-bg-raised px-1.5 py-0.5 text-fg-muted">
            {slotUri}
          </code>
        </span>
        {agent.modelId && (
          <span>
            model:{" "}
            <code className="rounded bg-bg-raised px-1.5 py-0.5 text-fg-muted">
              {agent.modelId}
            </code>
          </span>
        )}
      </div>

      <DetailSection title="Allowed tools" data={tools} />
      <DetailSection title="Allowed skills" data={skills} />

      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
          System prompt (SOUL.md)
        </div>
        {agent.systemPrompt ? (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-bg-base p-2 text-[11px] leading-relaxed text-fg-muted">
            {agent.systemPrompt}
          </pre>
        ) : (
          <div className="text-[11px] italic text-fg-faint">
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
        className="rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success"
        title="agent.json declared this list explicitly"
      >
        explicit
      </span>
    );
  } else if (data.kind === "effective") {
    badge = (
      <span
        className="rounded bg-amber-950 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning"
        title="agent.json has no allow-list — worker sees every entry below"
      >
        effective (no restriction)
      </span>
    );
  }
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
          {title}
        </span>
        {data.kind !== "unknown" && (
          <span className="rounded bg-bg-raised px-1.5 py-0.5 text-[10px] text-fg-muted">
            {data.items.length}
          </span>
        )}
        {badge}
      </div>
      {data.kind === "unknown" ? (
        <div className="text-[11px] italic text-fg-faint">
          (catalog not loaded — reload the page)
        </div>
      ) : data.items.length === 0 ? (
        <div className="text-[11px] italic text-fg-faint">
          (empty list — worker can call nothing)
        </div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {data.items.map((name) => (
            <code
              key={name}
              className="rounded bg-bg-raised px-1.5 py-0.5 text-[11px] text-fg-muted"
            >
              {name}
            </code>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Modal wrapper around the auto-generated PluginConfigForm for
 * the workboard plugin. The form covers pool-level concurrency
 * caps (maxConcurrentRuns, maxConcurrentRunsPerUser) plus echo /
 * llm worker type defaults — a surface large enough that pinning
 * it to the page header would dominate the table the user
 * actually came here to read.
 *
 * Pattern mirrors microsandbox's ConfigureSandboxDialog (same
 * sticky-action trick to keep Save reachable when the form is
 * taller than the dialog). Kept inline rather than promoted to a
 * shared component because the plugin-sdk's PluginConfigForm
 * already does the heavy lifting; the dialog chrome is just
 * presentation we'd otherwise have to coordinate across plugins.
 */
function ConfigureWorkboardDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-base shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-4 py-3">
          <div>
            <div className="text-sm font-medium text-fg-default">
              Workboard configuration
            </div>
            <div className="mt-0.5 text-[11px] text-fg-faint">
              Pool caps apply on the next run acquire. Worker type
              defaults (echo / llm) re-activate the plugin so
              changes take effect on the next request.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-fg-muted hover:bg-bg-raised hover:text-fg-default"
            aria-label="Close configure dialog"
          >
            <X size={14} />
          </button>
        </div>
        {/* Form scroll region.
         *
         * DOM under us (verified live with `Array.from` walk on
         * a Save button click, see PR #248 review):
         *
         *   div.flex-1.overflow-y-auto          ← (this element)
         *     div                                ← PluginConfigFormById's `<div className={className}>` wrapper
         *       div.space-y-5                    ← PluginConfigForm root
         *         …field groups…
         *         div.border-t.pt-3              ← Reset/Save action row (LAST child of .space-y-5)
         *
         * We want the action row pinned to the bottom of the
         * scroll viewport so Save stays reachable while the
         * fields above scroll. Selector chain (3 levels deep):
         *
         *   & > div > div > div:last-child
         *
         * Microsandbox uses a 4-deep version of the same trick;
         * its dialog wraps the SDK form in one extra container.
         * If the SDK changes its internal layout this degrades
         * gracefully (the action row stops being sticky but the
         * form still works — user just scrolls to the bottom).
         *
         * px-4 pt-3 only (no pb-3): if the scroll container had
         * padding-bottom, sticky bottom-0 would stop above that
         * padding strip and fields scrolling up would peek
         * through below the sticky row. The pinned row carries
         * its own pb-3 to give Save breathing room instead.
         */}
        <div
          className={
            // px-4 pt-3 only (no pb-3): if the scroll container
            // had bottom padding, sticky bottom-0 would stop
            // above the padding strip and fields scrolling up
            // would peek below the pinned row. The sticky row
            // owns its own pb-3 (further below) for breathing room.
            "flex-1 overflow-y-auto px-4 pt-3 " +
            // Pin Reset/Save row to bottom; sit it on top of the
            // scrolling fields with a solid bg so they don't show
            // through. -mx-4/px-4 extends the row's background
            // edge-to-edge inside the scroll viewport so the
            // border-t the form already draws on this row reads
            // as a real footer divider rather than a half-width
            // line. The small bottom shadow gives a hint that
            // there's content scrolling under it.
            "[&>div>div>div:last-child]:sticky " +
            "[&>div>div>div:last-child]:bottom-0 " +
            "[&>div>div>div:last-child]:z-10 " +
            "[&>div>div>div:last-child]:-mx-4 " +
            "[&>div>div>div:last-child]:px-4 " +
            "[&>div>div>div:last-child]:pb-3 " +
            "[&>div>div>div:last-child]:bg-bg-base " +
            "[&>div>div>div:last-child]:shadow-[0_-8px_8px_-8px_rgba(0,0,0,0.4)] "
          }
        >
          <PluginConfigForm pluginId="workboard" />
        </div>
      </div>
    </div>
  );
}

// Default export kept so the existing
// `import WorkerAgentsPage from "./worker-agents-page.js"` site in
// client.tsx keeps working without a churn-y rename.
export default WorkerAgentsPage;
