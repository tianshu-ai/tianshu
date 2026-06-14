// Capability shapes for the host's tool / skill catalogs.
//
// Plugins use these to populate allow-list defaults for built-in
// agents (workboard's Default LLM picks up every tool / skill the
// host knows about, instead of relying on the magic "null = no
// restriction" sentinel that's invisible in the UI).
//
// Both registered as exclusive host capabilities; see
// capabilities.ts.

export interface ToolCatalogEntry {
  name: string;
  /** Single-line description from the tool's schema. */
  description: string;
  /** Source plugin id, or "host" for tools registered by the
   *  server itself. Useful for UI grouping. */
  pluginId: string;
}

export interface ToolCatalogCapability {
  /** Read the full tool catalog for the current tenant. Synchronous;
   *  the host already has this loaded in memory. */
  list(): ToolCatalogEntry[];
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  pluginId: string;
  /** Frontmatter `scope:` field, if any. "main" hides the skill
   *  from worker runs; "worker" hides it from the main chat
   *  agent. Undefined means visible to both — the legacy
   *  default. Plugins / UIs that surface skills per-agent
   *  honour this filter themselves; the host doesn't strip
   *  scoped skills from the catalog. */
  scope?: "main" | "worker";
}

export interface SkillCatalogCapability {
  list(): SkillCatalogEntry[];
}

export interface ModelCatalogEntry {
  /** Provider-prefixed id passed to `modelId` fields, e.g.
   *  `sap-proxy/claude-sonnet-4-6`, `anthropic/claude-opus-4-7`,
   *  `sap-perplexity/sonar-pro`. This is the value an agent.json
   *  or task overrides should set. */
  id: string;
  /** Display name from the host config (`models[].name`). */
  name: string;
  /** Provider id (`anthropic`, `sap-proxy`, etc.). Already in the
   *  prefix of `id`; surfaced separately for UI grouping. */
  provider: string;
  /** Optional grouping label (`Cloud`, `Local`, ...). */
  group?: string;
  /** Context window in tokens, from host config. */
  contextWindow: number;
  /** True iff the model emits chain-of-thought / reasoning
   *  tokens we shouldn't show to the user verbatim. */
  reasoning: boolean;
}

export interface ModelCatalogCapability {
  /** Read the model catalog visible to the current tenant.
   *  Driven by `tenant.config.models.providers` resolved via
   *  `listModels()` in @tianshu/server. The default model id
   *  (used when `agent.json.modelId === null`) is exposed
   *  separately so worker-creator and other tools don't have
   *  to hard-code which entry is the fallback. */
  list(): { models: ModelCatalogEntry[]; defaultModelId: string | null };
}
