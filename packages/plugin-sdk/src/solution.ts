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
   *  Reserved for a future advanced "whitelist" mode; Phase 2's
   *  UI is deny-only and leaves this null. Plugin-contributed
   *  skills are always implicitly allowed regardless. */
  skillsAllow: string[] | null;
  /** Skill deny-list by skill name. The primary Phase-2 control:
   *  the operator excludes tenant-owned skills they don't want.
   *  Plugin-contributed skills can't be denied (they're locked). */
  skillsDeny: string[];
  /** Tool allow-list by tool name. null = no restriction.
   *  Reserved for the future whitelist mode like skillsAllow. */
  toolsAllow: string[] | null;
  /** Tool deny-list by tool name. Symmetric with skillsDeny. */
  toolsDeny: string[];
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

/** One main-agent prompt block as shown in the Solution view's
 *  block editor. Mirrors WorkforcePromptBlock from the snapshot,
 *  but adds the solution-editing semantics: read-only blocks
 *  (host / plugin sourced) are shown for context only; editable
 *  blocks (workspace context, tenant prompt override) carry a
 *  body the operator can change and we persist on save.
 *
 *  We duplicate the shape rather than import WorkforcePromptBlock
 *  so the solution surface stays self-contained — a solution
 *  block's editability is a solution concept, not a snapshot one. */
export interface SolutionPromptBlock {
  kind: string;
  title: string;
  /** "host" | "plugin:<id>" | "tenant" | "workspace". */
  source: string;
  /** Provenance bucket for the badge. */
  origin: "core" | "builtin-plugin" | "tenant-plugin" | "host" | "tenant" | "workspace";
  /** Whether the Solution editor lets the operator change this
   *  block. host / plugin blocks are false; workspace / tenant
   *  blocks are true. */
  editable: boolean;
  /** Block body. For editable blocks this is the current value
   *  (and the editor binds to it); for read-only blocks it's the
   *  reference text from reality. */
  text: string;
  note?: string;
}

/** One selectable skill / tool in the Solution editor's picker.
 *  The operator excludes (deny) the tenant-owned ones they don't
 *  want; plugin-locked entries are shown but can't be toggled. */
export interface SolutionResourceOption {
  name: string;
  description: string;
  /** Provenance bucket for the badge. */
  origin: "core" | "builtin-plugin" | "tenant-plugin" | "host";
  /** True iff the entry is contributed by a plugin / host and
   *  therefore can't be excluded — it's shown locked. tenant-
   *  owned entries are unlocked and can be denied. */
  locked: boolean;
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
  /** Main-agent prompt blocks for the block-style editor. The
   *  read-only host / plugin blocks come from current reality as
   *  reference; the editable workspace / tenant-prompt blocks
   *  carry the solution's own values. */
  mainBlocks: SolutionPromptBlock[];
  /** Full skill catalogue from reality, for the deny picker.
   *  plugin/host-sourced entries are locked; tenant ones can be
   *  excluded. */
  availableSkills: SolutionResourceOption[];
  /** Full tool catalogue from reality, for the deny picker. */
  availableTools: SolutionResourceOption[];
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
