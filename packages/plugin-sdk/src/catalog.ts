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
