// Core read-only API: `/api/me`, `/api/models`, `/api/tools`,
// `/api/skills`. These power the chat shell's identity badge,
// model picker, and worker-agents allow-list pickers.
//
// All four assume tenant middleware has run (req.ctx is set); each
// scopes to the calling user when appropriate. Side-effect-free \u2014
// no DB writes, no plugin state mutation.

import type { Express, Request, Response } from "express";
import { DEV_TENANT_ID, DEV_USER_ID } from "../core/dev-mode.js";
import { listModels, getDefaultModel } from "../core/llm.js";
import type { PluginRegistry } from "../core/plugins/registry.js";

export interface MountCoreRoutesDeps {
  /** Registry used by /api/tools and /api/skills to enumerate the
   *  current tenant's catalog. Closures resolve it at request time
   *  so plugin enable/disable cycles take effect immediately. */
  pluginRegistry: PluginRegistry;
}

export function mountCoreRoutes(
  app: Express,
  deps: MountCoreRoutesDeps,
): void {
  const { pluginRegistry } = deps;

  app.get("/api/me", (req: Request, res: Response) => {
    if (!req.ctx) {
      res.status(500).json({ error: "no_ctx" });
      return;
    }
    const { tenant, userId } = req.ctx;
    const def = getDefaultModel(tenant.config);
    res.json({
      tenantId: tenant.tenantId,
      userId,
      config: { branding: tenant.config.branding ?? null },
      defaultModel: def
        ? { id: def.id, name: def.name, provider: def.providerId }
        : null,
      devTenant:
        tenant.tenantId === DEV_TENANT_ID && userId === DEV_USER_ID,
    });
  });

  app.get("/api/models", (req: Request, res: Response) => {
    if (!req.ctx) {
      res.status(500).json({ error: "no_ctx" });
      return;
    }
    const list = listModels(req.ctx.tenant.config).map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.providerId,
      group: m.group ?? null,
      contextWindow: m.contextWindow,
      reasoning: m.reasoning,
    }));
    res.json({
      models: list,
      defaultModel: req.ctx.tenant.config.defaultModel ?? null,
    });
  });

  /**
   * Tool catalog for the current tenant. Used by the worker-agents
   * settings page to render an allow-list picker instead of the
   * old comma-separated freetext field.
   *
   * Returns ALL tools the host registry knows about (host built-ins
   * + every active plugin's contributions). Per-agent allow-list
   * filtering happens at the worker; this endpoint is just the
   * universe to pick from.
   */
  app.get("/api/tools", (req: Request, res: Response) => {
    if (!req.ctx) {
      res.status(500).json({ error: "no_ctx" });
      return;
    }
    const entries = pluginRegistry.toolsForTenant(req.ctx.tenant.tenantId);
    // De-dupe by tool name; if two plugins shipped the same name we
    // still only show it once. Stable sort by name for the UI.
    const byName = new Map<
      string,
      { name: string; description: string; pluginId: string }
    >();
    for (const { pluginId, tool } of entries) {
      if (byName.has(tool.schema.name)) continue;
      byName.set(tool.schema.name, {
        name: tool.schema.name,
        description: tool.schema.description ?? "",
        pluginId,
      });
    }
    const tools = [...byName.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    res.json({ tools });
  });

  /**
   * Skill catalog for the current tenant. Same role as /api/tools \u2014
   * the universe of skills available (host-shipped + plugin-shipped)
   * for the worker-agents allow-list picker.
   */
  app.get("/api/skills", (req: Request, res: Response) => {
    if (!req.ctx) {
      res.status(500).json({ error: "no_ctx" });
      return;
    }
    const skills = pluginRegistry.skillsForTenant(
      req.ctx.tenant.tenantId,
    );
    // Same shape as /api/tools \u2014 just the bits the picker UI needs.
    // Description is the SKILL.md frontmatter so the picker can render
    // a tooltip; the body markdown stays server-side.
    const out = skills
      .map((s) => ({
        name: s.name,
        description: s.description,
        pluginId: s.source.pluginId,
        // Surface frontmatter `scope:` so the worker-agents page can
        // hide \"scope: main\" skills from a worker's effective list.
        // Undefined = visible to both.
        scope: s.scope,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ skills: out });
  });
}
