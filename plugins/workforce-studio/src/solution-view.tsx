// Solution view (ADR-0008 Phase 2) — the designtime half of the
// studio. Lists named solutions + the reserved `current` mirror,
// lets the operator extract reality into a new named solution,
// inspect a solution's declared config, edit basic metadata +
// allow-lists, delete, and diff against reality.
//
// No Apply in Phase 2: saving writes solution.json to disk but
// has no runtime effect. The UI says so explicitly so nobody
// expects a saved solution to change behaviour.

import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  GitCompare,
  Layers,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";

// ─── wire shapes (mirror SDK solution.ts via duck-typing) ───────

interface SolutionSummary {
  slug: string;
  name: string;
  description: string;
  updatedAt: number;
  workerCount: number;
  pluginCount: number;
  isCurrent: boolean;
  kind: "extracted" | "authored";
}
interface SolutionWorker {
  slug: string;
  kind: string;
  name: string;
  description: string | null;
  modelId: string | null;
  enabled: boolean;
  systemPromptPath: string | null;
  toolsAllow: string[] | null;
  skillsAllow: string[] | null;
  source: "builtin" | "user";
}
interface SolutionSpec {
  schema: string;
  slug: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  extractedFrom: {
    tenantId: string;
    tianshuVersion: string;
    extractedAt: number;
  } | null;
  plugins: { enabled: string[] };
  mainAgent: {
    tenantPromptPath: string | null;
    skillsAllow: string[] | null;
    skillsDeny: string[];
    toolsAllow: string[] | null;
    toolsDeny: string[];
  };
  workers: SolutionWorker[];
}
type BlockOrigin =
  | "core"
  | "builtin-plugin"
  | "tenant-plugin"
  | "host"
  | "tenant"
  | "workspace";
type OverrideKey = "executionBias" | "replyStyle" | "userOnboarding";
interface SolutionPromptBlock {
  kind: string;
  title: string;
  source: string;
  origin: BlockOrigin;
  editable: boolean;
  text: string;
  defaultText?: string | null;
  overrideKey?: OverrideKey;
  overridden?: boolean;
  customFragmentId?: string;
  note?: string;
}
interface ResourceOption {
  name: string;
  description: string;
  origin: "core" | "builtin-plugin" | "tenant-plugin" | "host";
  pluginId: string;
  locked: boolean;
}
interface SolutionWorkerView {
  blocks: SolutionPromptBlock[];
  availableSkills: ResourceOption[];
  availableTools: ResourceOption[];
}
interface PluginOption {
  id: string;
  displayName: string;
  description: string;
  origin: "builtin-plugin" | "tenant-plugin";
  state: "active" | "failed" | "disabled" | "loading";
}
interface SolutionDetail {
  spec: SolutionSpec;
  tenantPrompt: string | null;
  workerPrompts: Record<string, string>;
  mainBlocks: SolutionPromptBlock[];
  availableSkills: ResourceOption[];
  availableTools: ResourceOption[];
  workerViews: Record<string, SolutionWorkerView>;
  availablePlugins: PluginOption[];
  isCurrent: boolean;
}
interface DiffEntry {
  path: string;
  op: "add" | "remove" | "change";
  before: string | null;
  after: string | null;
}
interface SolutionDiff {
  baseLabel: string;
  targetLabel: string;
  entries: DiffEntry[];
}

const API_BASE = "/api/p/workforce-studio";

async function api<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = (await res.json()) as { ok: boolean; error?: string } & Record<
    string,
    unknown
  >;
  if (!body.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body as unknown as T;
}

// ─── main solution view ─────────────────────────────────────────

export function SolutionView(): ReactElement {
  const [summaries, setSummaries] = useState<SolutionSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SolutionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    setError(null);
    try {
      const r = await api<{ solutions: SolutionSummary[] }>("/solutions");
      setSummaries(r.solutions);
      // Default selection: current mirror if nothing selected.
      setSelected((cur) => cur ?? r.solutions[0]?.slug ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadDetail = useCallback(async (slug: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ solution: SolutionDetail }>(
        `/solutions/${encodeURIComponent(slug)}`,
      );
      setDetail(r.solution);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);
  useEffect(() => {
    if (selected) void loadDetail(selected);
  }, [selected, loadDetail]);

  const onExtract = useCallback(async () => {
    const slug = window.prompt(
      "New solution slug (lowercase, digits, - or _):",
      "",
    );
    if (!slug) return;
    setError(null);
    try {
      const name = window.prompt("Display name:", slug) || slug;
      await api("/solutions/extract", {
        method: "POST",
        body: JSON.stringify({ slug, name }),
      });
      await refreshList();
      setSelected(slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshList]);

  const onDelete = useCallback(
    async (slug: string) => {
      if (!window.confirm(`Delete solution "${slug}"? This cannot be undone.`))
        return;
      try {
        await api(`/solutions/${encodeURIComponent(slug)}`, {
          method: "DELETE",
        });
        setSelected(null);
        setDetail(null);
        await refreshList();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshList],
  );

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div className="rounded-md border border-danger-fg/40 bg-danger-fg/5 p-3 text-sm text-danger-fg">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4" />
            Solution error
          </div>
          <div className="mt-1 font-mono text-xs opacity-80">{error}</div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[280px_1fr]">
        <SolutionList
          summaries={summaries}
          selected={selected}
          onSelect={setSelected}
          onExtract={onExtract}
          onRefresh={() => void refreshList()}
        />
        <div>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              <Loader2 className="size-4 animate-spin" /> Loading solution…
            </div>
          ) : detail ? (
            <SolutionDetailPanel
              detail={detail}
              onDelete={onDelete}
              onSaved={async () => {
                await refreshList();
                if (selected) await loadDetail(selected);
              }}
            />
          ) : (
            <div className="text-sm text-fg-muted">
              Select a solution to inspect.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SolutionList({
  summaries,
  selected,
  onSelect,
  onExtract,
  onRefresh,
}: {
  summaries: SolutionSummary[] | null;
  selected: string | null;
  onSelect: (slug: string) => void;
  onExtract: () => void;
  onRefresh: () => void;
}): ReactElement {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-elevated">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <Layers className="size-4 text-fg-muted" />
        <span className="text-sm font-semibold">Solutions</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onRefresh}
            className="rounded p-1 hover:bg-bg-raised"
            title="Refresh"
          >
            <RefreshCw className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onExtract}
            className="inline-flex items-center gap-1 rounded bg-fg-default px-2 py-1 text-xs font-medium text-bg-base hover:opacity-90"
            title="Extract current reality into a new named solution"
          >
            <Plus className="size-3.5" /> Extract
          </button>
        </div>
      </div>
      {summaries === null ? (
        <div className="p-3 text-xs text-fg-muted">Loading…</div>
      ) : (
        <ul className="max-h-[70vh] overflow-auto">
          {summaries.map((s) => (
            <li key={s.slug}>
              <button
                type="button"
                onClick={() => onSelect(s.slug)}
                className={`flex w-full flex-col items-start gap-0.5 border-b border-border-subtle px-3 py-2 text-left text-xs hover:bg-bg-raised ${
                  selected === s.slug ? "bg-bg-raised" : ""
                }`}
              >
                <div className="flex w-full items-center gap-2">
                  <span className="font-medium">{s.name}</span>
                  {s.isCurrent ? (
                    <span className="rounded bg-info-fg/10 px-1 text-[10px] text-info-fg">
                      live
                    </span>
                  ) : (
                    <span className="rounded bg-fg-muted/10 px-1 text-[10px]">
                      {s.kind}
                    </span>
                  )}
                </div>
                <code className="text-[10px] text-fg-muted">{s.slug}</code>
                <span className="text-[10px] text-fg-muted">
                  {s.workerCount} workers · {s.pluginCount} plugins
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SolutionDetailPanel({
  detail,
  onDelete,
  onSaved,
}: {
  detail: SolutionDetail;
  onDelete: (slug: string) => void;
  onSaved: () => void;
}): ReactElement {
  const { spec, isCurrent } = detail;
  const [diff, setDiff] = useState<SolutionDiff | null>(null);
  const [busy, setBusy] = useState(false);

  // Editable fields (named solutions only). Phase 2 surface:
  // name, description, the main-agent tenant-prompt override,
  // and — in the deny-only model — the set of excluded skills /
  // tools. The operator excludes what they don't want; everything
  // else is included by default. Plugin / host resources are
  // locked and never enter these sets.
  const [name, setName] = useState(spec.name);
  const [description, setDescription] = useState(spec.description);
  const [tenantPrompt, setTenantPrompt] = useState(detail.tenantPrompt ?? "");
  const [skillsDeny, setSkillsDeny] = useState<Set<string>>(
    () => new Set(spec.mainAgent.skillsDeny),
  );
  const [toolsDeny, setToolsDeny] = useState<Set<string>>(
    () => new Set(spec.mainAgent.toolsDeny ?? []),
  );
  // Host-block overrides: null = use host default; string = the
  // override text. Seeded from the blocks the host marked as
  // overridden.
  const [overrides, setOverrides] = useState<Record<OverrideKey, string | null>>(
    () => seedOverrides(detail.mainBlocks),
  );
  // Custom fragments: { id, title, body }. Seeded from existing
  // custom-fragment blocks.
  const [fragments, setFragments] = useState<CustomFragmentEdit[]>(() =>
    seedFragments(detail.mainBlocks),
  );
  // Per-worker edits, keyed by slug. Each holds the editable
  // worker fields + SOUL prompt + skill/tool deny sets.
  const [workerEdits, setWorkerEdits] = useState<Record<string, WorkerEdit>>(
    () => seedWorkerEdits(spec.workers, detail.workerPrompts),
  );
  // Enabled plugin ids (include/exclude picker).
  const [pluginsEnabled, setPluginsEnabled] = useState<Set<string>>(
    () => new Set(spec.plugins.enabled),
  );
  useEffect(() => {
    setPluginsEnabled(new Set(spec.plugins.enabled));
  }, [spec.slug, spec.plugins.enabled]);
  useEffect(() => {
    setWorkerEdits(seedWorkerEdits(spec.workers, detail.workerPrompts));
  }, [spec.slug, spec.workers, detail.workerPrompts]);
  useEffect(() => {
    setName(spec.name);
    setDescription(spec.description);
    setTenantPrompt(detail.tenantPrompt ?? "");
    setSkillsDeny(new Set(spec.mainAgent.skillsDeny));
    setToolsDeny(new Set(spec.mainAgent.toolsDeny ?? []));
    setOverrides(seedOverrides(detail.mainBlocks));
    setFragments(seedFragments(detail.mainBlocks));
    setDiff(null);
  }, [
    spec.slug,
    spec.name,
    spec.description,
    detail.tenantPrompt,
    detail.mainBlocks,
    spec.mainAgent.skillsDeny,
    spec.mainAgent.toolsDeny,
  ]);

  const runDiff = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api<{ diff: SolutionDiff }>(
        `/solutions/${encodeURIComponent(spec.slug)}/diff?against=reality`,
      );
      setDiff(r.diff);
    } finally {
      setBusy(false);
    }
  }, [spec.slug]);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      // Round-trip the spec back through save(), swapping in the
      // edited metadata + inlining the prompt bodies the host
      // expects on the write path.
      const input = {
        slug: spec.slug,
        name,
        description,
        plugins: { enabled: [...pluginsEnabled].sort() },
        mainAgent: {
          tenantPrompt: tenantPrompt.trim().length > 0 ? tenantPrompt : null,
          // Deny-only model: allow lists stay null (no whitelist).
          // The deny sets carry the operator's exclusions.
          skillsAllow: null,
          skillsDeny: [...skillsDeny].sort(),
          toolsAllow: null,
          toolsDeny: [...toolsDeny].sort(),
          overrides: {
            executionBias: overrides.executionBias,
            replyStyle: overrides.replyStyle,
            userOnboarding: overrides.userOnboarding,
          },
          customFragments: fragments.map((f) => ({
            id: f.id,
            title: f.title,
            body: f.body,
          })),
        },
        workers: spec.workers.map((w) => {
          const e = workerEdits[w.slug];
          const view = detail.workerViews[w.slug];
          if (!e || !view) {
            // No edit state (shouldn't happen) — pass through.
            return {
              slug: w.slug,
              kind: w.kind,
              name: w.name,
              description: w.description,
              modelId: w.modelId,
              enabled: w.enabled,
              systemPrompt: detail.workerPrompts[w.slug] ?? null,
              toolsAllow: w.toolsAllow,
              skillsAllow: w.skillsAllow,
              source: w.source,
            };
          }
          // Deny picker over the worker's effective set → persist
          // as an allow-list (effective minus excluded). Only the
          // unlocked entries can be excluded; locked ones always
          // stay in.
          const allowFrom = (
            opts: ResourceOption[],
            deny: Set<string>,
          ): string[] =>
            opts.filter((o) => !deny.has(o.name)).map((o) => o.name).sort();
          return {
            slug: w.slug,
            kind: w.kind,
            name: e.name,
            description: e.description,
            modelId: e.modelId,
            enabled: e.enabled,
            systemPrompt: e.soul.trim().length > 0 ? e.soul : null,
            toolsAllow: allowFrom(view.availableTools, e.toolsDeny),
            skillsAllow: allowFrom(view.availableSkills, e.skillsDeny),
            source: w.source,
          };
        }),
      };
      await api("/solutions/save", {
        method: "POST",
        body: JSON.stringify(input),
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  }, [
    spec,
    name,
    description,
    detail,
    tenantPrompt,
    skillsDeny,
    toolsDeny,
    overrides,
    fragments,
    workerEdits,
    pluginsEnabled,
    onSaved,
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border-subtle bg-bg-elevated p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Layers className="size-4 text-fg-muted" />
          <h3 className="text-sm font-semibold">{spec.name}</h3>
          <code className="text-xs text-fg-muted">{spec.slug}</code>
          {isCurrent ? (
            <span className="rounded bg-info-fg/10 px-1.5 py-0.5 text-[10px] text-info-fg">
              live mirror · read-only
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => void runDiff()}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-xs hover:bg-bg-raised disabled:opacity-50"
            >
              <GitCompare className="size-3.5" /> Diff vs reality
            </button>
            {!isCurrent ? (
              <>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded bg-fg-default px-2 py-1 text-xs font-medium text-bg-base hover:opacity-90 disabled:opacity-50"
                >
                  <Save className="size-3.5" /> Save
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(spec.slug)}
                  className="inline-flex items-center gap-1 rounded border border-danger-fg/40 px-2 py-1 text-xs text-danger-fg hover:bg-danger-fg/5"
                >
                  <Trash2 className="size-3.5" /> Delete
                </button>
              </>
            ) : null}
          </div>
        </div>

        {spec.extractedFrom ? (
          <div className="mt-2 text-[11px] text-fg-muted">
            Extracted from tenant{" "}
            <code>{spec.extractedFrom.tenantId}</code> · v
            {spec.extractedFrom.tianshuVersion} ·{" "}
            {new Date(spec.extractedFrom.extractedAt).toLocaleString()}
          </div>
        ) : (
          <div className="mt-2 text-[11px] text-fg-muted">
            Hand-authored solution.
          </div>
        )}

        {/* Editable metadata (named solutions only) */}
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Name">
            <input
              value={name}
              disabled={isCurrent}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1 text-xs disabled:opacity-60"
            />
          </Field>
          <Field label="Description">
            <input
              value={description}
              disabled={isCurrent}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1 text-xs disabled:opacity-60"
            />
          </Field>
        </div>

        <div className="mt-3 rounded border border-warning-fg/30 bg-warning-fg/5 px-3 py-2 text-[11px] text-warning-fg">
          Phase 2: saving writes the solution to disk but does
          <strong> not </strong>
          change the running system. Apply lands in a later phase.
        </div>
      </div>

      {/* Main agent — block-style editor (ADR-0008): host /
          plugin blocks are read-only reference; the tenant prompt
          block is editable. */}
      <Section title="Main agent">
        <div className="flex flex-col gap-2">
          {detail.mainBlocks.map((b, idx) => (
            <SolutionBlockCard
              key={`${b.kind}-${b.customFragmentId ?? idx}`}
              index={idx + 1}
              block={b}
              isCurrent={isCurrent}
              tenantPrompt={tenantPrompt}
              onTenantPromptChange={setTenantPrompt}
              overrideValue={
                b.overrideKey ? overrides[b.overrideKey] : undefined
              }
              onOverrideChange={(val) => {
                if (!b.overrideKey) return;
                setOverrides((prev) => ({ ...prev, [b.overrideKey!]: val }));
              }}
              fragmentValue={
                b.customFragmentId
                  ? fragments.find((f) => f.id === b.customFragmentId)?.body ??
                    ""
                  : undefined
              }
              onFragmentChange={(val) => {
                if (!b.customFragmentId) return;
                setFragments((prev) =>
                  prev.map((f) =>
                    f.id === b.customFragmentId ? { ...f, body: val } : f,
                  ),
                );
              }}
              onFragmentRemove={() => {
                if (!b.customFragmentId) return;
                setFragments((prev) =>
                  prev.filter((f) => f.id !== b.customFragmentId),
                );
              }}
            />
          ))}
          {/* Custom fragments added this session but not yet in
              detail.mainBlocks (which only refreshes after save)
              render here so the operator sees them immediately. */}
          {fragments
            .filter(
              (f) =>
                !detail.mainBlocks.some(
                  (b) => b.customFragmentId === f.id,
                ),
            )
            .map((f) => (
              <NewFragmentCard
                key={f.id}
                fragment={f}
                disabled={isCurrent}
                onTitleChange={(title) =>
                  setFragments((prev) =>
                    prev.map((x) =>
                      x.id === f.id ? { ...x, title } : x,
                    ),
                  )
                }
                onBodyChange={(body) =>
                  setFragments((prev) =>
                    prev.map((x) => (x.id === f.id ? { ...x, body } : x)),
                  )
                }
                onRemove={() =>
                  setFragments((prev) => prev.filter((x) => x.id !== f.id))
                }
              />
            ))}
          {!isCurrent ? (
            <button
              type="button"
              onClick={() =>
                setFragments((prev) => [
                  ...prev,
                  {
                    id: `frag-${Date.now()}`,
                    title: "Custom fragment",
                    body: "",
                  },
                ])
              }
              className="self-start rounded-md border border-dashed border-border-subtle px-3 py-1.5 text-xs text-fg-muted hover:border-fg-muted hover:text-fg-default"
            >
              + Add custom fragment
            </button>
          ) : null}
        </div>
        {/* Skill / tool allow-lists are config, not prompt text,
            so they stay as their own editable controls below the
            block list. */}
        {isCurrent ? (
          <div className="mt-4 rounded border border-info-fg/30 bg-info-fg/5 px-3 py-2 text-[11px] text-info-fg">
            This is the live <strong>Current</strong> mirror — it's
            read-only. To exclude skills or tools, click{" "}
            <strong>Extract</strong> in the Solutions list to create
            a named solution, then edit that.
          </div>
        ) : null}
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <ResourcePicker
            title="Skills"
            options={detail.availableSkills}
            excluded={skillsDeny}
            disabled={isCurrent}
            onToggle={(name) =>
              setSkillsDeny((prev) => toggleInSet(prev, name))
            }
          />
          <ResourcePicker
            title="Tools"
            options={detail.availableTools}
            excluded={toolsDeny}
            disabled={isCurrent}
            onToggle={(name) =>
              setToolsDeny((prev) => toggleInSet(prev, name))
            }
          />
        </div>
      </Section>

      {/* Plugins — include / exclude picker over the full set of
          discovered plugins. */}
      <Section
        title={`Plugins (${pluginsEnabled.size} / ${detail.availablePlugins.length})`}
      >
        <ul className="flex flex-col gap-1">
          {detail.availablePlugins.map((p) => {
            const enabled = pluginsEnabled.has(p.id);
            return (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-bg-elevated"
              >
                <span className={enabled ? "font-medium" : "text-fg-muted line-through"}>
                  {p.displayName}
                </span>
                <code className="text-[10px] text-fg-muted">{p.id}</code>
                <SolutionOriginBadge origin={p.origin} />
                {p.state !== "active" ? (
                  <span className="rounded bg-danger-fg/10 px-1.5 py-0.5 text-[10px] text-danger-fg">
                    {p.state}
                  </span>
                ) : null}
                <button
                  type="button"
                  disabled={isCurrent}
                  onClick={() =>
                    setPluginsEnabled((prev) => toggleInSet(prev, p.id))
                  }
                  className={`ml-auto rounded-md border px-2 py-0.5 text-[10px] font-medium shadow-sm transition-colors active:translate-y-px disabled:opacity-50 ${
                    enabled
                      ? "border-border-subtle bg-bg-elevated text-fg-default hover:border-danger-fg/40 hover:bg-danger-fg/10 hover:text-danger-fg"
                      : "border-success-fg/40 bg-success-fg/10 text-success-fg hover:bg-success-fg/20"
                  }`}
                  title={
                    enabled
                      ? "Included — click to exclude from this solution."
                      : "Excluded — click to include."
                  }
                >
                  {enabled ? "Exclude" : "Include"}
                </button>
              </li>
            );
          })}
        </ul>
      </Section>

      {/* Workers — each gets the same block-style editor as the
          main agent (SOUL block + read-only host/plugin reference
          blocks + skill/tool deny pickers + basic fields). */}
      <Section title={`Workers (${spec.workers.length})`}>
        <div className="flex flex-col gap-3">
          {spec.workers.map((w) => {
            const e = workerEdits[w.slug];
            const view = detail.workerViews[w.slug];
            if (!e || !view) return null;
            return (
              <WorkerEditor
                key={w.slug}
                worker={w}
                view={view}
                edit={e}
                isCurrent={isCurrent}
                onChange={(next) =>
                  setWorkerEdits((prev) => ({ ...prev, [w.slug]: next }))
                }
              />
            );
          })}
        </div>
      </Section>

      {diff ? <DiffPanel diff={diff} /> : null}
    </div>
  );
}

function DiffPanel({ diff }: { diff: SolutionDiff }): ReactElement {
  return (
    <Section
      title={`Diff: ${diff.baseLabel} vs ${diff.targetLabel} (${diff.entries.length})`}
    >
      {diff.entries.length === 0 ? (
        <div className="text-xs text-fg-muted">
          No differences — solution matches reality.
        </div>
      ) : (
        <ul className="flex flex-col gap-1 text-[11px]">
          {diff.entries.map((e) => (
            <li
              key={e.path}
              className="rounded border border-border-subtle bg-bg-base px-2 py-1"
            >
              <div className="flex items-center gap-2">
                <span
                  className={
                    e.op === "add"
                      ? "rounded bg-success-fg/10 px-1 text-success-fg"
                      : e.op === "remove"
                      ? "rounded bg-danger-fg/10 px-1 text-danger-fg"
                      : "rounded bg-warning-fg/10 px-1 text-warning-fg"
                  }
                >
                  {e.op}
                </span>
                <code className="font-mono">{e.path}</code>
              </div>
              <div className="mt-0.5 grid grid-cols-2 gap-2 font-mono text-fg-muted">
                <span className="truncate">base: {e.before ?? "—"}</span>
                <span className="truncate">target: {e.after ?? "—"}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="rounded-lg border border-border-subtle bg-bg-elevated">
      <div className="border-b border-border-subtle px-4 py-2 text-sm font-semibold">
        {title}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

// Block card for the Solution view's main-agent editor. Mirrors
// the Reality view's BlockCard but: editable blocks (tenant
// prompt) render a textarea bound to the parent's state instead
// of read-only <pre>. Plugin / host blocks stay collapsed +
// read-only with the same origin badge as Reality.
interface CustomFragmentEdit {
  id: string;
  title: string;
  body: string;
}

function SolutionBlockCard({
  index,
  block,
  isCurrent,
  tenantPrompt,
  onTenantPromptChange,
  overrideValue,
  onOverrideChange,
  fragmentValue,
  onFragmentChange,
  onFragmentRemove,
}: {
  index: number;
  block: SolutionPromptBlock;
  isCurrent: boolean;
  tenantPrompt: string;
  onTenantPromptChange: (next: string) => void;
  /** Present only for overridable host blocks. */
  overrideValue?: string | null;
  onOverrideChange?: (next: string | null) => void;
  /** Present only for custom-fragment blocks. */
  fragmentValue?: string;
  onFragmentChange?: (next: string) => void;
  onFragmentRemove?: () => void;
}): ReactElement {
  const isTenantPrompt = block.kind === "tenant-prompt";
  const isOverride = !!block.overrideKey;
  const isFragment = !!block.customFragmentId;
  const isOverridden = isOverride && overrideValue !== null && overrideValue !== undefined;
  const [open, setOpen] = useState(block.editable);
  const borderTone = block.editable
    ? "border-border-subtle"
    : "border-border-subtle/60 border-dashed";
  return (
    <div className={`rounded-md border bg-bg-base ${borderTone}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs"
      >
        {open ? (
          <ChevronDown className="size-3.5 text-fg-muted" />
        ) : (
          <ChevronRight className="size-3.5 text-fg-muted" />
        )}
        <span className="text-[10px] text-fg-muted">#{index}</span>
        <span className="font-medium">{block.title}</span>
        <SolutionOriginBadge origin={block.origin} />
        {isOverride ? (
          isOverridden ? (
            <span className="rounded bg-warning-fg/10 px-1.5 py-0.5 text-[10px] font-medium text-warning-fg">
              overridden
            </span>
          ) : (
            <span className="rounded bg-fg-muted/15 px-1.5 py-0.5 text-[10px] font-medium">
              host default
            </span>
          )
        ) : (
          <span
            className={
              block.editable
                ? "rounded bg-success-fg/10 px-1.5 py-0.5 text-[10px] font-medium text-success-fg"
                : "rounded bg-fg-muted/15 px-1.5 py-0.5 text-[10px] font-medium"
            }
          >
            {block.editable ? "editable" : "read-only"}
          </span>
        )}
        <span className="ml-auto text-[10px] text-fg-muted">{block.source}</span>
      </button>
      {open ? (
        <div className="border-t border-border-subtle px-3 py-2">
          {block.note ? (
            <div className="mb-2 text-[11px] text-fg-muted">{block.note}</div>
          ) : null}

          {/* Tenant prompt block: plain editable textarea. */}
          {isTenantPrompt ? (
            <textarea
              value={tenantPrompt}
              disabled={isCurrent}
              onChange={(e) => onTenantPromptChange(e.target.value)}
              rows={8}
              placeholder={
                isCurrent
                  ? ""
                  : "Main-agent prompt text for this solution. Leave empty for none."
              }
              className="w-full rounded border border-border-subtle bg-bg-elevated px-2 py-1.5 font-mono text-[11px] leading-snug disabled:opacity-60"
            />
          ) : null}

          {/* Overridable host block: show default + Override /
              Reset, edit only when overriding. */}
          {isOverride ? (
            isOverridden ? (
              <>
                <textarea
                  value={overrideValue ?? ""}
                  disabled={isCurrent}
                  onChange={(e) => onOverrideChange?.(e.target.value)}
                  rows={8}
                  className="w-full rounded border border-border-subtle bg-bg-elevated px-2 py-1.5 font-mono text-[11px] leading-snug disabled:opacity-60"
                />
                {!isCurrent ? (
                  <button
                    type="button"
                    onClick={() => onOverrideChange?.(null)}
                    className="mt-2 rounded border border-border-subtle px-2 py-0.5 text-[10px] hover:bg-bg-raised"
                  >
                    Reset to host default
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border-subtle bg-bg-elevated p-2 font-mono text-[11px] leading-snug">
                  {block.defaultText ?? block.text}
                </pre>
                {!isCurrent ? (
                  <button
                    type="button"
                    onClick={() =>
                      onOverrideChange?.(block.defaultText ?? block.text)
                    }
                    className="mt-2 rounded border border-border-subtle px-2 py-0.5 text-[10px] hover:bg-bg-raised"
                  >
                    Override…
                  </button>
                ) : null}
              </>
            )
          ) : null}

          {/* Custom fragment block: editable body + remove. */}
          {isFragment ? (
            <>
              <textarea
                value={fragmentValue ?? ""}
                disabled={isCurrent}
                onChange={(e) => onFragmentChange?.(e.target.value)}
                rows={6}
                className="w-full rounded border border-border-subtle bg-bg-elevated px-2 py-1.5 font-mono text-[11px] leading-snug disabled:opacity-60"
              />
              {!isCurrent ? (
                <button
                  type="button"
                  onClick={() => onFragmentRemove?.()}
                  className="mt-2 rounded border border-danger-fg/40 px-2 py-0.5 text-[10px] text-danger-fg hover:bg-danger-fg/5"
                >
                  Remove fragment
                </button>
              ) : null}
            </>
          ) : null}

          {/* Plain read-only block. */}
          {!isTenantPrompt && !isOverride && !isFragment ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border-subtle bg-bg-elevated p-2 font-mono text-[11px] leading-snug">
              {block.text}
            </pre>
          ) : null}

          {block.editable && isCurrent ? (
            <div className="mt-2 text-[10px] text-fg-muted">
              The live mirror is read-only. Extract a named solution
              to edit this block.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Card for a freshly-added custom fragment not yet persisted
 *  (so it has no server block). Lets the operator name + fill it
 *  before the first save. */
function NewFragmentCard({
  fragment,
  disabled,
  onTitleChange,
  onBodyChange,
  onRemove,
}: {
  fragment: CustomFragmentEdit;
  disabled: boolean;
  onTitleChange: (next: string) => void;
  onBodyChange: (next: string) => void;
  onRemove: () => void;
}): ReactElement {
  return (
    <div className="rounded-md border border-border-subtle bg-bg-base">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="rounded bg-warning-fg/10 px-1.5 py-0.5 text-[10px] font-medium text-warning-fg">
          new fragment
        </span>
        <input
          value={fragment.title}
          disabled={disabled}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="Fragment title"
          className="flex-1 rounded border border-border-subtle bg-bg-elevated px-2 py-1 text-xs disabled:opacity-60"
        />
      </div>
      <div className="px-3 pb-2">
        <textarea
          value={fragment.body}
          disabled={disabled}
          onChange={(e) => onBodyChange(e.target.value)}
          rows={6}
          placeholder="Fragment text injected into the main agent prompt…"
          className="w-full rounded border border-border-subtle bg-bg-elevated px-2 py-1.5 font-mono text-[11px] leading-snug disabled:opacity-60"
        />
        {!disabled ? (
          <button
            type="button"
            onClick={onRemove}
            className="mt-2 rounded border border-danger-fg/40 px-2 py-0.5 text-[10px] text-danger-fg hover:bg-danger-fg/5"
          >
            Remove fragment
          </button>
        ) : null}
      </div>
    </div>
  );
}

function seedOverrides(
  blocks: SolutionPromptBlock[],
): Record<OverrideKey, string | null> {
  const out: Record<OverrideKey, string | null> = {
    executionBias: null,
    replyStyle: null,
    userOnboarding: null,
  };
  for (const b of blocks) {
    if (b.overrideKey && b.overridden) out[b.overrideKey] = b.text;
  }
  return out;
}

function seedFragments(
  blocks: SolutionPromptBlock[],
): CustomFragmentEdit[] {
  return blocks
    .filter((b) => b.customFragmentId)
    .map((b) => ({
      id: b.customFragmentId!,
      title: b.title,
      body: b.text,
    }));
}

// ─── worker editor ──────────────────────────────────────────────

interface WorkerEdit {
  name: string;
  description: string | null;
  modelId: string | null;
  enabled: boolean;
  soul: string;
  skillsDeny: Set<string>;
  toolsDeny: Set<string>;
}

function seedWorkerEdits(
  workers: SolutionWorker[],
  workerPrompts: Record<string, string>,
): Record<string, WorkerEdit> {
  const out: Record<string, WorkerEdit> = {};
  for (const w of workers) {
    out[w.slug] = {
      name: w.name,
      description: w.description,
      modelId: w.modelId,
      enabled: w.enabled,
      soul: workerPrompts[w.slug] ?? "",
      // Deny sets start empty: a freshly-extracted worker includes
      // everything in its effective set. The operator excludes
      // from there.
      skillsDeny: new Set(),
      toolsDeny: new Set(),
    };
  }
  return out;
}

function WorkerEditor({
  worker,
  view,
  edit,
  isCurrent,
  onChange,
}: {
  worker: SolutionWorker;
  view: SolutionWorkerView;
  edit: WorkerEdit;
  isCurrent: boolean;
  onChange: (next: WorkerEdit) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<WorkerEdit>) => onChange({ ...edit, ...patch });
  const excluded = !edit.enabled;
  return (
    <div
      className={`rounded-lg border bg-bg-base ${
        excluded ? "border-border-subtle/60 border-dashed" : "border-border-subtle"
      }`}
    >
      {/* Header: toggle region + standalone Exclude button (not
          one big <button> so the Exclude control isn't nested). */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex flex-1 items-center gap-2 text-left"
        >
          {open ? (
            <ChevronDown className="size-3.5 text-fg-muted" />
          ) : (
            <ChevronRight className="size-3.5 text-fg-muted" />
          )}
          <span
            className={`font-medium ${
              excluded ? "text-fg-muted line-through" : ""
            }`}
          >
            {edit.name}
          </span>
          <code className="text-[10px] text-fg-muted">{worker.slug}</code>
          <span className="text-[10px] text-fg-muted">{worker.kind}</span>
          <span className="text-[10px] text-fg-muted">
            {edit.modelId ? edit.modelId : "default model"}
          </span>
        </button>
        <button
          type="button"
          disabled={isCurrent}
          onClick={() => set({ enabled: !edit.enabled })}
          className={`rounded-md border px-2 py-0.5 text-[10px] font-medium shadow-sm transition-colors active:translate-y-px disabled:opacity-50 ${
            excluded
              ? "border-success-fg/40 bg-success-fg/10 text-success-fg hover:bg-success-fg/20"
              : "border-border-subtle bg-bg-elevated text-fg-default hover:border-danger-fg/40 hover:bg-danger-fg/10 hover:text-danger-fg"
          }`}
          title={
            excluded
              ? "Excluded from this solution — click to include."
              : "Included — click to exclude this worker from the solution."
          }
        >
          {excluded ? "Include" : "Exclude"}
        </button>
      </div>
      {open ? (
        <div className="flex flex-col gap-3 border-t border-border-subtle p-3">
          {/* Basic fields */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Name">
              <input
                value={edit.name}
                disabled={isCurrent}
                onChange={(ev) => set({ name: ev.target.value })}
                className="w-full rounded border border-border-subtle bg-bg-elevated px-2 py-1 text-xs disabled:opacity-60"
              />
            </Field>
            <Field label="Model id (empty = default)">
              <input
                value={edit.modelId ?? ""}
                disabled={isCurrent}
                onChange={(ev) =>
                  set({
                    modelId:
                      ev.target.value.trim().length > 0
                        ? ev.target.value
                        : null,
                  })
                }
                className="w-full rounded border border-border-subtle bg-bg-elevated px-2 py-1 font-mono text-xs disabled:opacity-60"
              />
            </Field>
            <Field label="Description">
              <input
                value={edit.description ?? ""}
                disabled={isCurrent}
                onChange={(ev) =>
                  set({
                    description:
                      ev.target.value.trim().length > 0
                        ? ev.target.value
                        : null,
                  })
                }
                className="w-full rounded border border-border-subtle bg-bg-elevated px-2 py-1 text-xs disabled:opacity-60"
              />
            </Field>
          </div>

          {/* Prompt blocks (SOUL editable, rest read-only) */}
          <div className="flex flex-col gap-2">
            {view.blocks.map((b, idx) => (
              <WorkerBlockCard
                key={`${b.kind}-${idx}`}
                index={idx + 1}
                block={b}
                isCurrent={isCurrent}
                soul={edit.soul}
                onSoulChange={(v) => set({ soul: v })}
              />
            ))}
          </div>

          {/* Skill / tool deny pickers */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <ResourcePicker
              title="Skills"
              options={view.availableSkills}
              excluded={edit.skillsDeny}
              disabled={isCurrent}
              onToggle={(n) =>
                set({ skillsDeny: toggleInSet(edit.skillsDeny, n) })
              }
            />
            <ResourcePicker
              title="Tools"
              options={view.availableTools}
              excluded={edit.toolsDeny}
              disabled={isCurrent}
              onToggle={(n) =>
                set({ toolsDeny: toggleInSet(edit.toolsDeny, n) })
              }
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Worker block card: like SolutionBlockCard but only the SOUL
// block is editable; everything else is read-only reference.
function WorkerBlockCard({
  index,
  block,
  isCurrent,
  soul,
  onSoulChange,
}: {
  index: number;
  block: SolutionPromptBlock;
  isCurrent: boolean;
  soul: string;
  onSoulChange: (next: string) => void;
}): ReactElement {
  const isSoul = block.kind === "worker-soul";
  const [open, setOpen] = useState(isSoul);
  const borderTone = block.editable
    ? "border-border-subtle"
    : "border-border-subtle/60 border-dashed";
  return (
    <div className={`rounded-md border bg-bg-elevated ${borderTone}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs"
      >
        {open ? (
          <ChevronDown className="size-3.5 text-fg-muted" />
        ) : (
          <ChevronRight className="size-3.5 text-fg-muted" />
        )}
        <span className="text-[10px] text-fg-muted">#{index}</span>
        <span className="font-medium">{block.title}</span>
        <SolutionOriginBadge origin={block.origin} />
        <span
          className={
            block.editable
              ? "rounded bg-success-fg/10 px-1.5 py-0.5 text-[10px] font-medium text-success-fg"
              : "rounded bg-fg-muted/15 px-1.5 py-0.5 text-[10px] font-medium"
          }
        >
          {block.editable ? "editable" : "read-only"}
        </span>
        <span className="ml-auto text-[10px] text-fg-muted">{block.source}</span>
      </button>
      {open ? (
        <div className="border-t border-border-subtle px-3 py-2">
          {block.note ? (
            <div className="mb-2 text-[11px] text-fg-muted">{block.note}</div>
          ) : null}
          {isSoul ? (
            <textarea
              value={soul}
              disabled={isCurrent}
              onChange={(ev) => onSoulChange(ev.target.value)}
              rows={8}
              placeholder={
                isCurrent ? "" : "Worker SOUL.md — the worker's persona + rules."
              }
              className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1.5 font-mono text-[11px] leading-snug disabled:opacity-60"
            />
          ) : (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border-subtle bg-bg-base p-2 font-mono text-[11px] leading-snug">
              {block.text}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  );
}

function SolutionOriginBadge({
  origin,
}: {
  origin: BlockOrigin;
}): ReactElement {
  const map: Record<BlockOrigin, { label: string; className: string }> = {
    core: { label: "core", className: "bg-info-fg/10 text-info-fg" },
    "builtin-plugin": {
      label: "built-in",
      className: "bg-success-fg/10 text-success-fg",
    },
    "tenant-plugin": {
      label: "tenant plugin",
      className: "bg-warning-fg/10 text-warning-fg",
    },
    host: { label: "host", className: "bg-info-fg/10 text-info-fg" },
    workspace: {
      label: "workspace",
      className: "bg-warning-fg/10 text-warning-fg",
    },
    tenant: { label: "tenant", className: "bg-warning-fg/10 text-warning-fg" },
  };
  const { label, className } = map[origin];
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${className}`}
    >
      {label}
    </span>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-fg-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

// ─── resource deny picker ───────────────────────────────────────
// Deny-only model (Yu's choice): plugin / host resources come in
// by default and are LOCKED (shown, can't be removed). tenant-
// owned resources are Included by default and can be Excluded
// with a single toggle. There's no whitelist UI — the operator
// just removes what they don't want.

function ResourcePicker({
  title,
  options,
  excluded,
  disabled,
  onToggle,
}: {
  title: string;
  options: ResourceOption[];
  excluded: Set<string>;
  disabled: boolean;
  onToggle: (name: string) => void;
}): ReactElement {
  const excludedCount = options.filter(
    (o) => !o.locked && excluded.has(o.name),
  ).length;
  // Group by contributor so the operator scans by source. Sort
  // groups: core / host first (host-owned), then plugin ids
  // alphabetically. Within a group, names stay alphabetical (the
  // host already sorted the flat list).
  const groups = new Map<string, ResourceOption[]>();
  for (const o of options) {
    const key = o.pluginId || groupKeyFromOrigin(o.origin);
    const cur = groups.get(key);
    if (cur) cur.push(o);
    else groups.set(key, [o]);
  }
  const orderedKeys = [...groups.keys()].sort((a, b) => {
    const rank = (k: string) => (k === "core" || k === "host" ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return a.localeCompare(b);
  });
  return (
    <div className="overflow-hidden rounded-lg border border-border-subtle">
      <div className="flex items-center gap-2 bg-bg-elevated px-3 py-2">
        <span className="text-sm font-semibold">{title}</span>
        <span className="text-[11px] text-fg-muted">{options.length}</span>
        {excludedCount > 0 ? (
          <span className="ml-auto rounded-full bg-danger-fg/10 px-2 py-0.5 text-[10px] font-medium text-danger-fg">
            {excludedCount} excluded
          </span>
        ) : null}
      </div>
      <div className="max-h-80 overflow-auto bg-bg-base">
        {orderedKeys.map((key) => {
          const items = groups.get(key)!;
          return (
            <div key={key}>
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-bg-base/95 px-3 pb-1 pt-2 backdrop-blur">
                <span className="text-[11px] font-semibold text-fg-default">
                  {groupLabel(key)}
                </span>
                <span className="rounded-full bg-fg-muted/10 px-1.5 text-[10px] text-fg-muted">
                  {items.length}
                </span>
              </div>
              <ul className="px-1.5 pb-1">
                {items.map((o) => (
                  <ResourceRow
                    key={o.name}
                    option={o}
                    isExcluded={excluded.has(o.name)}
                    disabled={disabled}
                    onToggle={onToggle}
                  />
                ))}
              </ul>
            </div>
          );
        })}
        {options.length === 0 ? (
          <div className="px-3 py-3 text-xs text-fg-muted">None.</div>
        ) : null}
      </div>
    </div>
  );
}

function ResourceRow({
  option: o,
  isExcluded,
  disabled,
  onToggle,
}: {
  option: ResourceOption;
  isExcluded: boolean;
  disabled: boolean;
  onToggle: (name: string) => void;
}): ReactElement {
  // Clean row: name on the left, a single trailing affordance on
  // the right. Locked entries get a faint lock glyph (no loud
  // pill); excludable entries get a quiet toggle that only turns
  // loud (red) once actually excluded. Origin is conveyed by the
  // group header, so no per-row origin badge.
  return (
    <li
      className={`group flex items-center gap-2 rounded px-2 py-1 ${
        o.locked ? "" : "hover:bg-bg-elevated"
      }`}
    >
      <code
        className={`font-mono text-[11px] ${
          isExcluded
            ? "text-fg-muted line-through"
            : o.locked
            ? "text-fg-muted"
            : "text-fg-default"
        }`}
      >
        {o.name}
      </code>
      {o.locked ? (
        <span
          className="ml-auto"
          title="Contributed by a plugin or the host — always included."
        >
          <Lock className="size-3 text-fg-muted/50" aria-label="locked" />
        </span>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onToggle(o.name)}
          className={`ml-auto rounded-md border px-2 py-0.5 text-[10px] font-medium shadow-sm transition-colors active:translate-y-px disabled:opacity-50 ${
            isExcluded
              ? "border-success-fg/40 bg-success-fg/10 text-success-fg hover:bg-success-fg/20"
              : "border-border-subtle bg-bg-elevated text-fg-default hover:border-danger-fg/40 hover:bg-danger-fg/10 hover:text-danger-fg"
          }`}
          title={
            isExcluded
              ? "Currently excluded — click to include again."
              : "Currently included — click to exclude from this solution."
          }
        >
          {isExcluded ? "Include" : "Exclude"}
        </button>
      )}
    </li>
  );
}

function groupKeyFromOrigin(origin: ResourceOption["origin"]): string {
  return origin === "core" ? "core" : "host";
}

function groupLabel(key: string): string {
  if (key === "core") return "Core";
  if (key === "host") return "Host";
  return key;
}

function toggleInSet(prev: Set<string>, name: string): Set<string> {
  const next = new Set(prev);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}
