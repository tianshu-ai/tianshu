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
  /** Per-block overrides of host-generated prompt text. Each key
   *  maps to a relative sidecar path (main-agent/<key>.md) when
   *  set, or null to fall back to the host default. Only the
   *  blocks the host marks overridable appear here:
   *    - executionBias
   *    - replyStyle
   *    - userOnboarding
   *  Reserved for Phase 3 (Apply) — stored but not yet wired into
   *  the host renderer. */
  overrides: SolutionPromptOverrides;
  /** Operator-authored extra prompt fragments appended to the
   *  main-agent prompt. Each is free-form markdown the user added
   *  in the studio (not from a plugin). Phase 2 stores them;
   *  Phase 3 injects them. */
  customFragments: SolutionCustomFragment[];
}

/** Override sidecar paths for host-generated blocks. null = use
 *  the host default. */
export interface SolutionPromptOverrides {
  executionBias: string | null;
  replyStyle: string | null;
  userOnboarding: string | null;
}

/** A user-authored prompt fragment. id is a stable slug used for
 *  the sidecar filename (main-agent/fragments/<id>.md). */
export interface SolutionCustomFragment {
  id: string;
  title: string;
  /** Relative sidecar path holding the fragment body. */
  path: string;
}

/** The override keys the studio understands. Kept as a const-ish
 *  union so SDK consumers and the host agree on the set. */
export type SolutionOverrideKey =
  | "executionBias"
  | "replyStyle"
  | "userOnboarding";

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
  /** Per-worker host-block overrides. Independent of the main
   *  agent's overrides — a worker can replace the host default
   *  execution-bias block for itself without affecting the main
   *  agent or sibling workers. Each maps to a relative sidecar
   *  path (workers/<slug>/<key>.md) when set, or null to fall
   *  back to the host default. Only `executionBias` is wired
   *  today; the shape leaves room for the other overridable host
   *  blocks later. */
  overrides?: SolutionWorkerOverrides;
  source: "builtin" | "user";
}

/** Override sidecar paths for a worker's host-generated blocks.
 *  null = use the host default. */
export interface SolutionWorkerOverrides {
  executionBias: string | null;
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
   *  block. plugin blocks + pure code-generated blocks (brand,
   *  runtime context, available-skills) are false; tenant prompt,
   *  workspace files, and the overridable host blocks (execution
   *  bias, reply style, user onboarding) are true. */
  editable: boolean;
  /** Block body shown in the editor. For an overridable block
   *  this is the override value if set, else the host default. */
  text: string;
  /** The host-generated default text for an overridable block,
   *  shown as the reset target + the read-only reference. null
   *  for non-overridable blocks. */
  defaultText?: string | null;
  /** For overridable host blocks: the override key the studio
   *  uses to persist this block's override (executionBias /
   *  replyStyle / userOnboarding). Absent for tenant-prompt /
   *  workspace / custom-fragment blocks, which persist through
   *  their own dedicated fields. */
  overrideKey?: SolutionOverrideKey;
  /** True iff this block currently carries a solution override
   *  (text differs from / supersedes defaultText). */
  overridden?: boolean;
  /** For a user-authored custom fragment block: its stable id, so
   *  the UI can edit / remove it. Absent for all other blocks. */
  customFragmentId?: string;
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
  /** Concrete contributor id: the plugin id (`wechat`,
   *  `workboard`, …) for plugin-sourced entries, or "core" /
   *  "host" for host-owned ones. Surfaced so the picker can show
   *  exactly which plugin a skill / tool came from, not just the
   *  origin bucket. */
  pluginId: string;
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
  /** Per-worker editor views, keyed by worker slug. Each carries
   *  the worker's block decomposition (mirroring the agent-loop
   *  worker prompt) + its own skill / tool catalogue for the deny
   *  picker — the worker equivalent of mainBlocks +
   *  availableSkills/Tools. */
  workerViews: Record<string, SolutionWorkerView>;
  /** Every plugin discovered for the tenant, for the include /
   *  exclude picker. The solution's `plugins.enabled` decides
   *  which are ticked; this list is the full menu. */
  availablePlugins: SolutionPluginOption[];
  /** True for the reserved `current` slug — the studio renders it
   *  read-only (it's a live mirror of reality, regenerated on
   *  extract) and hides Apply. */
  isCurrent: boolean;
  /** True iff this is the currently-active (live) solution. */
  isActive: boolean;
}

/** Editor view data for one worker in the Solution view. */
export interface SolutionWorkerView {
  blocks: SolutionPromptBlock[];
  availableSkills: SolutionResourceOption[];
  availableTools: SolutionResourceOption[];
}

/** One plugin in the solution's plugin include/exclude picker. */
export interface SolutionPluginOption {
  id: string;
  displayName: string;
  description: string;
  origin: "builtin-plugin" | "tenant-plugin";
  /** Live state in reality — surfaced so the operator sees what's
   *  currently active vs failed, independent of the solution's
   *  own enable choice. */
  state: "active" | "failed" | "disabled" | "loading";
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
  /** Whether this solution is the currently-active (live) one
   *  — i.e. the one last activated into reality. At most one
   *  named solution is active at a time. */
  isActive: boolean;
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
  /** Activate a solution: write its config into the tenant (so
   *  the live chat path picks it up) AND mark it as the active
   *  solution. This is the user-facing "go live" action (the
   *  button is labelled Activate). Non-destructive subset — does
   *  not touch plugin enable/disable. Rejects the `current`
   *  mirror. Supersedes the old `apply`, which remains as an
   *  alias for back-compat. */
  activate(
    userId: string,
    slug: string,
  ): { ok: true; appliedWorkers: string[]; activeSlug: string };
  /** @deprecated use activate. Writes config without (re)setting
   *  the active pointer's intent — kept so older callers don't
   *  break. */
  apply(
    userId: string,
    slug: string,
  ): { ok: true; appliedWorkers: string[] };
  /** Slug of the currently-active solution, or null when none has
   *  been activated (fresh tenant). */
  getActive(userId: string): string | null;
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
  mainAgent: Omit<
    SolutionMainAgent,
    "tenantPromptPath" | "overrides" | "customFragments"
  > & {
    /** Inline body; host writes to main-agent/prompt.md. Empty /
     *  null clears the override. */
    tenantPrompt: string | null;
    /** Inline override bodies for the host blocks. null / empty
     *  clears that override (falls back to host default). */
    overrides: {
      executionBias: string | null;
      replyStyle: string | null;
      userOnboarding: string | null;
    };
    /** Inline custom fragments. id stable across saves; empty
     *  body drops the fragment. */
    customFragments: Array<{ id: string; title: string; body: string }>;
  };
  workers: Array<
    Omit<SolutionWorker, "systemPromptPath" | "overrides"> & {
      /** Inline SOUL.md body; host writes to
       *  workers/<slug>/SOUL.md. */
      systemPrompt: string | null;
      /** Inline per-worker host-block override bodies. null /
       *  empty clears that override (falls back to host default).
       *  Optional for backward compatibility with older clients. */
      overrides?: {
        executionBias: string | null;
      };
    }
  >;
}
