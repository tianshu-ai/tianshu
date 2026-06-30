// Solution view — shared types + the edit-state hook.
//
// ADR-0008 Phase 2/3 lifted the whole edit surface (name,
// description, tenantPrompt, skill/tool deny sets, host-block
// overrides, custom fragments, per-worker edits, enabled plugin
// set) into one place: SolutionDetailPanel. The IDE-layout rework
// (studio-ide-rework-plan.md) splits the *render* across three
// panes (tree / editors / inspector) but keeps the *state*
// identical. `useSolutionEdits()` is that lifted state, extracted
// verbatim so the tree + editors + inspector can share it.
//
// save() also lives here: its payload shape is the frozen
// `/solutions/save` contract and must not change.

import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useState } from "react";

// ─── wire shapes (mirror SDK solution.ts via duck-typing) ───────

export interface SolutionSummary {
  slug: string;
  name: string;
  description: string;
  updatedAt: number;
  workerCount: number;
  pluginCount: number;
  isCurrent: boolean;
  kind: "extracted" | "authored";
}
export interface SolutionWorker {
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
export interface SolutionSpec {
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
export type BlockOrigin =
  | "core"
  | "builtin-plugin"
  | "tenant-plugin"
  | "host"
  | "tenant"
  | "workspace";
export type OverrideKey = "executionBias" | "replyStyle" | "userOnboarding";
export interface SolutionPromptBlock {
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
export interface ResourceOption {
  name: string;
  description: string;
  origin: "core" | "builtin-plugin" | "tenant-plugin" | "host";
  pluginId: string;
  locked: boolean;
}
export interface SolutionWorkerView {
  blocks: SolutionPromptBlock[];
  availableSkills: ResourceOption[];
  availableTools: ResourceOption[];
}
export interface PluginOption {
  id: string;
  displayName: string;
  description: string;
  origin: "builtin-plugin" | "tenant-plugin";
  state: "active" | "failed" | "disabled" | "loading";
}
export interface SolutionDetail {
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
export interface DiffEntry {
  path: string;
  op: "add" | "remove" | "change";
  before: string | null;
  after: string | null;
}
export interface SolutionDiff {
  baseLabel: string;
  targetLabel: string;
  entries: DiffEntry[];
}

export interface CustomFragmentEdit {
  id: string;
  title: string;
  body: string;
}

export interface WorkerEdit {
  name: string;
  description: string | null;
  modelId: string | null;
  enabled: boolean;
  soul: string;
  /** Per-worker execution-bias override. null = host default;
   *  string = override text. Independent of the main agent's
   *  override (the "B" model). */
  executionBias: string | null;
  skillsDeny: Set<string>;
  toolsDeny: Set<string>;
}

// ─── api helper ─────────────────────────────────────────────────

export const API_BASE = "/api/p/workforce-studio";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
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

// ─── seed helpers ───────────────────────────────────────────────

export function seedOverrides(
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

export function seedFragments(
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

export function seedWorkerEdits(
  workers: SolutionWorker[],
  workerPrompts: Record<string, string>,
  workerViews: Record<string, SolutionWorkerView>,
): Record<string, WorkerEdit> {
  const out: Record<string, WorkerEdit> = {};
  for (const w of workers) {
    // Seed the override from the worker view's execution-bias
    // block: when the host marked it overridden, its `text` is the
    // override body; otherwise null (host default).
    const ebBlock = workerViews[w.slug]?.blocks.find(
      (b) => b.overrideKey === "executionBias",
    );
    out[w.slug] = {
      name: w.name,
      description: w.description,
      modelId: w.modelId,
      enabled: w.enabled,
      soul: workerPrompts[w.slug] ?? "",
      executionBias: ebBlock?.overridden ? ebBlock.text : null,
      // Deny sets start empty: a freshly-extracted worker includes
      // everything in its effective set. The operator excludes
      // from there.
      skillsDeny: new Set(),
      toolsDeny: new Set(),
    };
  }
  return out;
}

export function toggleInSet(prev: Set<string>, name: string): Set<string> {
  const next = new Set(prev);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}

// ─── edit-state hook ────────────────────────────────────────────

export interface SolutionEdits {
  // metadata
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  // main agent
  tenantPrompt: string;
  setTenantPrompt: (v: string) => void;
  skillsDeny: Set<string>;
  setSkillsDeny: Dispatch<SetStateAction<Set<string>>>;
  toolsDeny: Set<string>;
  setToolsDeny: Dispatch<SetStateAction<Set<string>>>;
  overrides: Record<OverrideKey, string | null>;
  setOverrides: Dispatch<SetStateAction<Record<OverrideKey, string | null>>>;
  fragments: CustomFragmentEdit[];
  setFragments: Dispatch<SetStateAction<CustomFragmentEdit[]>>;
  // workers
  workerEdits: Record<string, WorkerEdit>;
  setWorkerEdits: Dispatch<SetStateAction<Record<string, WorkerEdit>>>;
  // plugins
  pluginsEnabled: Set<string>;
  setPluginsEnabled: Dispatch<SetStateAction<Set<string>>>;
  // derived / actions
  diff: SolutionDiff | null;
  setDiff: Dispatch<SetStateAction<SolutionDiff | null>>;
  busy: boolean;
  runDiff: () => Promise<void>;
  apply: () => Promise<void>;
  save: () => Promise<void>;
}

/**
 * The single source of edit state for the Solution view. Lifted
 * out of the former SolutionDetailPanel unchanged; the tree,
 * editors, and inspector all read/write through this hook so the
 * `/solutions/save` + `/solutions/:slug/apply` contracts stay
 * identical to today.
 */
export function useSolutionEdits(
  detail: SolutionDetail,
  onSaved: () => void,
): SolutionEdits {
  const { spec } = detail;

  const [name, setName] = useState(spec.name);
  const [description, setDescription] = useState(spec.description);
  const [tenantPrompt, setTenantPrompt] = useState(detail.tenantPrompt ?? "");
  const [skillsDeny, setSkillsDeny] = useState<Set<string>>(
    () => new Set(spec.mainAgent.skillsDeny),
  );
  const [toolsDeny, setToolsDeny] = useState<Set<string>>(
    () => new Set(spec.mainAgent.toolsDeny ?? []),
  );
  const [overrides, setOverrides] = useState<
    Record<OverrideKey, string | null>
  >(() => seedOverrides(detail.mainBlocks));
  const [fragments, setFragments] = useState<CustomFragmentEdit[]>(() =>
    seedFragments(detail.mainBlocks),
  );
  const [workerEdits, setWorkerEdits] = useState<Record<string, WorkerEdit>>(
    () =>
      seedWorkerEdits(spec.workers, detail.workerPrompts, detail.workerViews),
  );
  const [pluginsEnabled, setPluginsEnabled] = useState<Set<string>>(
    () => new Set(spec.plugins.enabled),
  );
  const [diff, setDiff] = useState<SolutionDiff | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPluginsEnabled(new Set(spec.plugins.enabled));
  }, [spec.slug, spec.plugins.enabled]);
  useEffect(() => {
    setWorkerEdits(
      seedWorkerEdits(spec.workers, detail.workerPrompts, detail.workerViews),
    );
  }, [spec.slug, spec.workers, detail.workerPrompts, detail.workerViews]);
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

  const apply = useCallback(async () => {
    if (
      !window.confirm(
        `Apply "${spec.name}" to the running system?\n\nThis writes the main-agent config + worker files into the tenant. The live agent picks them up on its next turn. (Plugins aren't changed in this phase.)`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ appliedWorkers: string[] }>(
        `/solutions/${encodeURIComponent(spec.slug)}/apply`,
        { method: "POST" },
      );
      window.alert(
        `Applied "${spec.name}". Workers updated: ${
          r.appliedWorkers.length
        }. The change takes effect on the next agent turn.`,
      );
    } catch (err) {
      window.alert(
        `Apply failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }, [spec.slug, spec.name]);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      // Round-trip the spec back through save(), swapping in the
      // edited metadata + inlining the prompt bodies the host
      // expects on the write path. Payload shape is the frozen
      // `/solutions/save` contract — do not change.
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
              overrides: { executionBias: null },
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
            opts
              .filter((o) => !deny.has(o.name))
              .map((o) => o.name)
              .sort();
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
            overrides: {
              executionBias:
                e.executionBias && e.executionBias.trim().length > 0
                  ? e.executionBias
                  : null,
            },
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

  return {
    name,
    setName,
    description,
    setDescription,
    tenantPrompt,
    setTenantPrompt,
    skillsDeny,
    setSkillsDeny,
    toolsDeny,
    setToolsDeny,
    overrides,
    setOverrides,
    fragments,
    setFragments,
    workerEdits,
    setWorkerEdits,
    pluginsEnabled,
    setPluginsEnabled,
    diff,
    setDiff,
    busy,
    runDiff,
    apply,
    save,
  };
}
