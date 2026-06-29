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
}

export interface WorkforceMainAgent {
  /** Brand name from tenant config. */
  brandName: string;
  /** Default model id (provider-prefixed). May be null when the
   *  tenant has no models configured. */
  defaultModelId: string | null;
  /** Composed system prompt the agent would receive on the next
   *  turn if it ran right now. Includes plugin fragments + the
   *  current skill catalog block; static enough to diff across
   *  upgrades. */
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
  /** Composed system prompt the worker actually runs with.
   *  Comparable to WorkforceMainAgent.systemPrompt but built
   *  via the workboard's worker prompt logic. */
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
