// Capability shape for `host.workforceSnapshot` — used by the
// Workforce Studio plugin to introspect + export the tenant's
// agent configuration in one call.
//
// The host returns a complete read-only snapshot covering:
//   - the main agent's identity (brand, default model) + the
//     skills it actually sees (after scope/when filtering)
//   - every active tool's schema, source plugin, and since
//     version
//   - every worker agent's prompt, allowed tools, allowed skills
//
// Unlike the catalog capabilities (host.toolCatalog,
// host.skillCatalog) this surface includes the FULL skill body
// so the studio's zip export can ship every skill .md file as
// part of the bundle. The catalog capabilities stay slim for
// the cases that only need names + descriptions.

/** Where a tool / skill comes from. Studio renders this as a
 *  coloured badge so the operator can tell at a glance whether
 *  a capability is part of the core install, a built-in plugin,
 *  or something a tenant administrator added later.
 *
 *   - "core"           Host-owned tools registered directly by
 *                       the server (e.g. worker_analytics).
 *   - "builtin-plugin" A plugin shipped under `plugins/<id>/`
 *                       inside this Tianshu install. Always
 *                       available without operator action.
 *   - "tenant-plugin"  A plugin discovered under the tenant's
 *                       `<home>/_tenant/config/plugins/<id>/`
 *                       — installed/edited per-tenant.
 */
export type WorkforceOrigin = "core" | "builtin-plugin" | "tenant-plugin";

/** Tool the agent has access to, with enough detail to render a
 *  studio detail panel + write a `tools.md` entry in the zip. */
export interface WorkforceToolEntry {
  /** Schema name the model calls. */
  name: string;
  /** One-line description from the tool's schema. */
  description: string;
  /** JSON schema for the tool's parameters, exactly as the model
   *  sees it. Studio renders this for documentation. */
  parameters: unknown;
  /** Plugin that contributes the tool, or "core" for host-owned
   *  tools like worker_analytics. */
  pluginId: string;
  /** Manifest `since` version (string semver). null when the
   *  plugin didn't declare it. */
  since: string | null;
  /** Provenance bucket. Computed from `pluginId` against the
   *  plugin inventory so the studio can group/colour by origin. */
  origin: WorkforceOrigin;
}

/** Skill the agent has access to. Includes the markdown body so
 *  the zip export can reproduce the file the agent reads when it
 *  decides to load the skill. */
export interface WorkforceSkillEntry {
  /** Frontmatter `name`. Unique across enabled skills. */
  name: string;
  /** Frontmatter `description`. */
  description: string;
  /** Plugin id that owns the contribution, or "host" for
   *  built-in skills shipped under packages/server/host-skills. */
  pluginId: string;
  /** "main" / "worker" / undefined (visible to both). */
  scope?: "main" | "worker";
  /** Path of the skill file as seen by the agent. Studio mirrors
   *  this into the zip under `skills/<path>` so the export is a
   *  faithful reproduction of what the model reads. */
  relativePath: string;
  /** Full markdown body, frontmatter included. */
  body: string;
  /** Same provenance bucket as tools; computed from `pluginId`. */
  origin: WorkforceOrigin;
}

/** One row in the plugin inventory the studio displays at the top
 *  of the snapshot. The host derives this from the active plugin
 *  registry; non-active (failed / disabled) plugins are still
 *  surfaced so admins can see why a missing tool/skill is missing. */
export interface WorkforcePluginInfo {
  id: string;
  displayName: string;
  version: string;
  description: string;
  /** Where the plugin manifest was found. Maps directly to
   *  WorkforceOrigin so the studio can colour-match plugin rows
   *  against tool/skill badges. */
  origin: "builtin-plugin" | "tenant-plugin";
  /** Lifecycle state: "active" means the registry activated it;
   *  "failed" / "disabled" / etc. mean the plugin is known but
   *  not currently contributing anything. Studio displays the
   *  reason for non-active states. */
  state: "active" | "failed" | "disabled" | "loading";
  /** Populated for non-active states; null when state===active. */
  failureReason: string | null;
  /** Number of tools this plugin currently contributes to the
   *  main agent. Useful for a quick "weight" view. */
  toolCount: number;
  /** Number of skills this plugin currently contributes. */
  skillCount: number;
}

/** Why a block is in the system prompt. The studio renders the
 *  block in two distinct views:
 *
 *   - DEVELOP view: every block is listed, tagged with its
 *     source + editability. Plugin-injected blocks are
 *     read-only; tenant-owned blocks are editable (write
 *     support lands later).
 *   - RENDERED view: the blocks are concatenated through the
 *     same join() the host actually uses, producing the literal
 *     text the model sees on its next turn.
 *
 *  We keep this enum closed: any new injection point must teach
 *  the studio about itself rather than sneaking in as a vague
 *  "other" bucket. */
export type WorkforcePromptBlockKind =
  | "brand"
  | "runtime-context"
  | "execution-bias"
  | "workspace-context"
  | "reply-style"
  | "plugin-fragment"
  | "available-skills"
  | "user-onboarding"
  | "tenant-prompt"
  | "custom-fragment"
  | "worker-soul"
  | "worker-context";

/** One contiguous chunk of the composed system prompt. */
export interface WorkforcePromptBlock {
  /** Stable kind used by the UI to decide grouping / iconography
   *  / editability defaults. */
  kind: WorkforcePromptBlockKind;
  /** Short human label shown in the Develop view's accordion
   *  header. */
  title: string;
  /** Where this block came from, for the badge:
   *    - "host"     : hard-coded in the server, always present
   *    - "plugin:<id>" : a plugin's systemPromptFragments[]
   *    - "tenant"  : tenant-owned override (config / fs file)
   *    - "workspace" : tenant/user-authored .md context files
   *  We use a stringly-typed `source` so plugin ids appear inline
   *  without us inventing a separate field. */
  source: string;
  /** Origin bucket reused from the tool / skill provenance enum
   *  so badges stay visually consistent across the page. */
  origin: WorkforceOrigin | "host" | "tenant" | "workspace";
  /** True iff the studio's editor will accept changes to this
   *  block. Plugin / host blocks stay false; tenant-owned
   *  blocks (tenant prompt, SOUL.md, AGENTS.md, USER.md, …) are
   *  true. */
  editable: boolean;
  /** Block body, exactly as it appears in the composed prompt. */
  text: string;
  /** Optional one-line hint shown under the block header in the
   *  Develop view. Used for things like "managed by plugin
   *  files" or "sourced from <home>/SOUL.md". */
  note?: string;
}

export interface WorkforceMainAgent {
  /** Brand name from tenant config. */
  brandName: string;
  /** Default model id (provider-prefixed). May be null when the
   *  tenant has no models configured. */
  defaultModelId: string | null;
  /** Block-by-block decomposition of the system prompt. Used by
   *  the Develop view; concatenating `blocks.map(b => b.text).
   *  join("\n\n")` reproduces (a close approximation of) the
   *  rendered text the model sees. */
  blocks: WorkforcePromptBlock[];
  /** Composed system prompt the agent would receive on the next
   *  turn if it ran right now. This is the authoritative rendered
   *  text — the studio shows it in the Rendered view as-is. */
  systemPrompt: string;
  /** Every tool currently visible to the main agent. Already
   *  filtered for `available()` and skill-aware gating. */
  tools: WorkforceToolEntry[];
  /** Every skill visible to the main agent after
   *  scope/when filtering. */
  skills: WorkforceSkillEntry[];
}

export interface WorkforceWorkerAgent {
  /** Slug (directory name under
   *  `_tenant/config/workers/<slug>/`). Used as the agent id
   *  everywhere else in the system. */
  slug: string;
  /** Display name from the worker's agent.json. */
  name: string;
  /** One-line description from agent.json. */
  description: string | null;
  /** Functional category (default-llm / code / research / ...). */
  kind: string;
  /** "builtin" or "user" — user-authored workers can be edited;
   *  builtins are the ones the host ships and the studio surfaces
   *  read-only. */
  source: "builtin" | "user";
  /** Whether the workboard pool actually dispatches to this
   *  worker. Disabled workers still appear in the studio so admins
   *  can inspect why they aren't running. */
  enabled: boolean;
  /** Bound model id, or null when the worker uses whatever the
   *  pool/agent loop picks. */
  modelId: string | null;
  /** Block-by-block decomposition of the worker prompt for the
   *  Develop view. Phase 1 reports the stored SOUL.md as a
   *  single editable block + worker context fragments; richer
   *  decomposition lands when the worker prompt builder is
   *  refactored out of agent-loop.ts. */
  blocks: WorkforcePromptBlock[];
  /** Composed system prompt the worker actually runs with.
   *  Comparable to WorkforceMainAgent.systemPrompt but built
   *  via the workboard's worker prompt logic. Phase 1 reports
   *  the stored SOUL.md verbatim; runtime decomposition is
   *  Phase 2 work. */
  systemPrompt: string;
  /** Tools the worker is allowed to call after WORKER_DENY_TOOLS
   *  + agent.json toolsAllow filtering. */
  tools: WorkforceToolEntry[];
  /** Skills the worker can load (agent.json `skills:` allow-list
   *  intersected with the host catalog, scope-filtered for
   *  worker visibility). */
  skills: WorkforceSkillEntry[];
}

export interface WorkforceSnapshot {
  /** Tenant id this snapshot represents. */
  tenantId: string;
  /** User id this snapshot represents. Per-user surfaces (chat
   *  user prompt, etc.) are pinned to this id. */
  userId: string;
  /** ms epoch when the host built the snapshot. */
  generatedAt: number;
  /** Tianshu version that produced the snapshot. Surfaced in the
   *  zip's README so future re-imports know what era the export
   *  belongs to. */
  tianshuVersion: string;
  /** Inventory of every plugin currently visible to the tenant.
   *  Each tool/skill entry's `origin` field is derived from this
   *  list, so a UI can correlate a badge back to a concrete row. */
  plugins: WorkforcePluginInfo[];
  main: WorkforceMainAgent;
  workers: WorkforceWorkerAgent[];
}

export interface WorkforceSnapshotCapability {
  /** Build a complete snapshot of the tenant's agent configuration
   *  for the given user. Synchronous — every dependency is
   *  already in memory or backed by quick fs reads.
   *
   *  The userId pins per-user context (user home AGENTS/SOUL/USER
   *  blocks the agent would actually see), so callers must pass it
   *  through from the authenticated request rather than letting
   *  the capability default. */
  build(userId: string): WorkforceSnapshot;
}
