// Solution model (ADR-0008) — declarative description of "what the
// operator wants the agent system to look like" for a tenant.
//
// A Solution is distinct from current reality (the
// WorkforceSnapshot): reality is observation, a solution is intent.
// Phase 2 (this file's first consumer) implements extract / save /
// list / edit / diff — no Apply yet, so a solution on disk has no
// runtime effect.
//
// Storage (per ADR-0008 §2):
//   <home>/_tenant/solutions/<slug>/
//     solution.json            (this shape, serialised)
//     main-agent/prompt.md     (optional, referenced by tenantPromptPath)
//     workers/<slug>/SOUL.md   (optional, referenced by systemPromptPath)

/** Provenance stamped onto a solution that was extracted from a
 *  live tenant snapshot rather than authored by hand. null for
 *  hand-authored solutions. */
export interface SolutionExtractedFrom {
  tenantId: string;
  tianshuVersion: string;
  /** ms epoch of the extraction. */
  extractedAt: number;
}

/** Plugin selection for a solution. Phase 2 stores it; Phase 4
 *  acts on it (enable/disable on Apply). */
export interface SolutionPlugins {
  /** Explicit enable-list of plugin ids. On Apply (Phase 4) the
   *  reconciler enables exactly these and disables the rest. */
  enabled: string[];
}

export interface SolutionMainAgent {
  /** Relative path (within the solution dir) to a markdown
   *  override block injected into the main agent prompt, or null
   *  for no override. */
  tenantPromptPath: string | null;
  /** Skill allow-list by skill name. null = no restriction.
   *  Plugin-contributed skills are always implicitly allowed;
   *  this list only further-restricts tenant-owned skills. */
  skillsAllow: string[] | null;
  /** Skill deny-list by skill name. Applied after allow. */
  skillsDeny: string[];
  /** Tool allow-list by tool name. null = no restriction. */
  toolsAllow: string[] | null;
}

export interface SolutionWorker {
  slug: string;
  kind: string;
  name: string;
  description: string | null;
  modelId: string | null;
  enabled: boolean;
  /** Relative path (within the solution dir) to the worker's
   *  SOUL.md, or null. */
  systemPromptPath: string | null;
  toolsAllow: string[] | null;
  skillsAllow: string[] | null;
  source: "builtin" | "user";
}

/** The on-disk `solution.json` shape (schema v1). */
export interface SolutionSpec {
  /** Always "tianshu.solution.v1" for this version. */
  schema: "tianshu.solution.v1";
  slug: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  extractedFrom: SolutionExtractedFrom | null;
  plugins: SolutionPlugins;
  mainAgent: SolutionMainAgent;
  workers: SolutionWorker[];
}

/** A solution as returned to the studio: the spec plus the
 *  resolved bodies of its sidecar files, so the UI can render
 *  prompt content without a second round-trip. */
export interface SolutionDetail {
  spec: SolutionSpec;
  /** Resolved tenant prompt override body (from tenantPromptPath),
   *  or null. */
  tenantPrompt: string | null;
  /** Resolved worker SOUL.md bodies, keyed by worker slug. */
  workerPrompts: Record<string, string>;
  /** True for the reserved `current` slug — the studio renders it
   *  read-only (it's a live mirror of reality, regenerated on
   *  extract) and hides Apply. */
  isCurrent: boolean;
}

/** Lightweight summary for the solution list / picker. */
export interface SolutionSummary {
  slug: string;
  name: string;
  description: string;
  updatedAt: number;
  workerCount: number;
  pluginCount: number;
  /** Whether this is the reserved `current` mirror. */
  isCurrent: boolean;
  /** Provenance: "extracted" when extractedFrom is set,
   *  "authored" otherwise. */
  kind: "extracted" | "authored";
}

/** One structural difference between two solutions, or between a
 *  solution and current reality. */
export interface SolutionDiffEntry {
  /** Dot-path of the changed field, e.g. "mainAgent.skillsAllow"
   *  or "workers.researcher.modelId". */
  path: string;
  /** add = present in target, absent in base; remove = inverse;
   *  change = present in both but different. */
  op: "add" | "remove" | "change";
  /** Human-readable before / after, JSON-stringified for
   *  scalars and arrays. */
  before: string | null;
  after: string | null;
}

export interface SolutionDiff {
  /** What we compared against. */
  baseLabel: string;
  targetLabel: string;
  entries: SolutionDiffEntry[];
}

/** Capability surface the studio plugin uses to manage solutions.
 *  Registered host-side as `host.solutions`. All methods are
 *  scoped to the calling tenant; userId is passed where per-user
 *  context (extraction) matters. */
export interface SolutionsCapability {
  /** List every solution (including the reserved `current`). */
  list(userId: string): SolutionSummary[];
  /** Read one solution with resolved sidecar bodies. Returns null
   *  when the slug doesn't exist (other than `current`, which is
   *  always materialised on read). */
  get(userId: string, slug: string): SolutionDetail | null;
  /** Extract current reality into a named solution. When slug is
   *  omitted or "current", refreshes the live mirror. Overwrites
   *  an existing slug (the route layer asks for confirmation). */
  extract(
    userId: string,
    args: { slug: string; name?: string; description?: string },
  ): SolutionDetail;
  /** Persist edits to an existing solution. Rejects the reserved
   *  `current` slug. Returns the saved detail. */
  save(userId: string, detail: SolutionSpecInput): SolutionDetail;
  /** Delete a solution. Rejects `current`. No-op when absent. */
  remove(userId: string, slug: string): void;
  /** Diff a solution against current reality (target="reality")
   *  or against another solution slug. */
  diff(
    userId: string,
    args: { slug: string; against: string },
  ): SolutionDiff;
}

/** Input shape for save(): the spec plus inline prompt bodies the
 *  host writes out to sidecar files. We accept inline strings (not
 *  paths) on the write path so the UI doesn't have to manage file
 *  layout; the host decides where bodies live. */
export interface SolutionSpecInput {
  slug: string;
  name: string;
  description: string;
  plugins: SolutionPlugins;
  mainAgent: Omit<SolutionMainAgent, "tenantPromptPath"> & {
    /** Inline body; host writes to main-agent/prompt.md. Empty /
     *  null clears the override. */
    tenantPrompt: string | null;
  };
  workers: Array<
    Omit<SolutionWorker, "systemPromptPath"> & {
      /** Inline SOUL.md body; host writes to
       *  workers/<slug>/SOUL.md. */
      systemPrompt: string | null;
    }
  >;
}
