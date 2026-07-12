// Core read-only API: `/api/me`, `/api/models`, `/api/tools`,
// `/api/skills`. These power the chat shell's identity badge,
// model picker, and worker-agents allow-list pickers.
//
// All four assume tenant middleware has run (req.ctx is set); each
// scopes to the calling user when appropriate. Side-effect-free \u2014
// no DB writes, no plugin state mutation.

import express, { type Express, type Request, type Response } from "express";
import { DEV_TENANT_ID, DEV_USER_ID } from "../core/dev-mode.js";
import { listModels, getDefaultModel } from "../core/llm.js";
import type { PluginRegistry } from "../core/plugins/registry.js";
import {
  loadGlobalConfig,
  writeGlobalConfig,
  type ProviderEntry,
  type ModelEntry,
} from "../core/config.js";
import { getTianshuHome } from "../core/paths.js";
import { resolveTenantRole } from "../core/auth/identity.js";
import { getUserStore } from "../core/auth/user-store.js";

// Sentinel the client echoes back for an apiKey field it did NOT
// change. Lets the UI edit other fields (or reorder models) without
// ever seeing or having to re-enter the real secret — we treat the
// sentinel as "keep the stored value".
const API_KEY_MASK = "__stored__";

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
    // Human-friendly identity for the UI. sessionResolver stashes the
    // authed name/email/provider in identityMeta; prefer name → email →
    // raw id so the sidebar shows "admin" not "ul_5457...". Role is
    // resolved against the current tenant (super-admin > db role >
    // member); in dev mode (no meta) it's the dev user.
    const meta = req.ctx.identityMeta ?? {};
    const displayName = meta.name || meta.email || userId;
    const authCfg = loadGlobalConfig().auth ?? {};
    const role = authCfg.enabled
      ? resolveTenantRole(authCfg, getUserStore(), {
          userId,
          tenantId: tenant.tenantId,
          email: meta.email,
          username: meta.provider === "local" ? meta.name : undefined,
        })
      : "admin"; // dev mode: de-facto admin
    res.json({
      tenantId: tenant.tenantId,
      userId,
      displayName,
      email: meta.email ?? null,
      provider: meta.provider ?? null,
      role,
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

  // ── Models / provider catalog admin ──────────────────────────────
  //
  // Read + maintain the provider catalog in the GLOBAL config
  // (~/.tianshu/config.json → models.providers), which is what the
  // Settings "Models" page edits. GET masks apiKeys (never leaked to
  // the browser); PUT preserves a stored key when the client sends
  // back the API_KEY_MASK sentinel. Config is re-read from disk on
  // every request (buildTenantContext → resolveTenantConfig), so an
  // external edit to config.json shows up on the next GET with no
  // restart, and a PUT here is visible to the next model resolution.

  app.get("/api/admin/models/providers", (req: Request, res: Response) => {
    if (!req.ctx) {
      res.status(500).json({ error: "no_ctx" });
      return;
    }
    try {
      const cfg = loadGlobalConfig(getTianshuHome());
      const providers = cfg.models?.providers ?? {};
      res.json({
        providers: maskProviders(providers),
        defaultModelId: cfg.models?.defaultModelId ?? null,
        defaultModel: cfg.defaultModel ?? null,
      });
    } catch (err) {
      res.status(500).json({
        error: "config_read_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.put(
    "/api/admin/models/providers",
    express.json({ limit: "1mb" }),
    (req: Request, res: Response) => {
      if (!req.ctx) {
        res.status(500).json({ error: "no_ctx" });
        return;
      }
      try {
        const cfg = loadGlobalConfig(getTianshuHome());
        const prev = cfg.models?.providers ?? {};
        const parsed = parseProvidersInput(
          (req.body as { providers?: unknown } | undefined)?.providers,
          prev,
        );
        if ("error" in parsed) {
          res.status(400).json(parsed);
          return;
        }
        const body = req.body as {
          defaultModelId?: unknown;
          defaultModel?: unknown;
        };
        const nextModels = {
          ...(cfg.models ?? {}),
          providers: parsed.value,
        };
        if (typeof body.defaultModelId === "string") {
          nextModels.defaultModelId = body.defaultModelId || undefined;
        }
        const nextCfg = { ...cfg, models: nextModels };
        if (typeof body.defaultModel === "string") {
          nextCfg.defaultModel = body.defaultModel || undefined;
        }
        writeGlobalConfig(nextCfg, getTianshuHome());
        res.json({
          providers: maskProviders(parsed.value),
          defaultModelId: nextModels.defaultModelId ?? null,
          defaultModel: nextCfg.defaultModel ?? null,
        });
      } catch (err) {
        res.status(500).json({
          error: "config_write_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}

// ── models-admin helpers ────────────────────────────────────────────

/** Return providers with every apiKey replaced by the mask sentinel
 *  (when a key is set) so the real secret never reaches the browser.
 *  Also surfaces `hasApiKey` so the UI can show "key set" state. */
function maskProviders(
  providers: Record<string, ProviderEntry>,
): Record<string, ProviderEntry & { hasApiKey?: boolean }> {
  const out: Record<string, ProviderEntry & { hasApiKey?: boolean }> = {};
  for (const [id, p] of Object.entries(providers)) {
    const hasKey = typeof p.apiKey === "string" && p.apiKey.length > 0;
    out[id] = {
      ...p,
      apiKey: hasKey ? API_KEY_MASK : "",
      hasApiKey: hasKey,
    };
  }
  return out;
}

type ParsedProviders =
  | { value: Record<string, ProviderEntry> }
  | { error: string; message: string };

/** Validate + normalise the providers object from a PUT body. Merges
 *  in stored apiKeys wherever the client echoed the mask sentinel, so
 *  editing non-secret fields never clobbers the real key. */
function parseProvidersInput(
  input: unknown,
  prev: Record<string, ProviderEntry>,
): ParsedProviders {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      error: "invalid_providers",
      message: "providers must be an object keyed by provider id",
    };
  }
  const out: Record<string, ProviderEntry> = {};
  for (const [id, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!id || typeof id !== "string") {
      return { error: "invalid_provider_id", message: `bad provider id: ${String(id)}` };
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        error: "invalid_provider",
        message: `provider "${id}" must be an object`,
      };
    }
    const r = raw as Record<string, unknown>;
    const entry: ProviderEntry = {};

    if (r.baseUrl !== undefined && r.baseUrl !== "") {
      if (typeof r.baseUrl !== "string") {
        return { error: "invalid_baseUrl", message: `provider "${id}" baseUrl must be a string` };
      }
      entry.baseUrl = r.baseUrl;
    }
    if (r.api !== undefined && r.api !== "") {
      if (typeof r.api !== "string") {
        return { error: "invalid_api", message: `provider "${id}" api must be a string` };
      }
      entry.api = r.api;
    }
    if (r.group !== undefined && r.group !== "") {
      if (typeof r.group !== "string") {
        return { error: "invalid_group", message: `provider "${id}" group must be a string` };
      }
      entry.group = r.group;
    }

    // apiKey: mask sentinel => keep stored; empty => clear; else set.
    if (typeof r.apiKey === "string") {
      if (r.apiKey === API_KEY_MASK) {
        const stored = prev[id]?.apiKey;
        if (typeof stored === "string" && stored.length > 0) entry.apiKey = stored;
      } else if (r.apiKey.length > 0) {
        entry.apiKey = r.apiKey;
      }
      // empty string => leave apiKey unset (cleared)
    } else {
      // no apiKey field sent => preserve stored to be safe
      const stored = prev[id]?.apiKey;
      if (typeof stored === "string" && stored.length > 0) entry.apiKey = stored;
    }

    const modelsParsed = parseModelsInput(r.models, id);
    if ("error" in modelsParsed) return modelsParsed;
    if (modelsParsed.value.length > 0) entry.models = modelsParsed.value;

    out[id] = entry;
  }
  return { value: out };
}

type ParsedModels =
  | { value: ModelEntry[] }
  | { error: string; message: string };

function parseModelsInput(input: unknown, providerId: string): ParsedModels {
  if (input === undefined || input === null) return { value: [] };
  if (!Array.isArray(input)) {
    return {
      error: "invalid_models",
      message: `provider "${providerId}" models must be an array`,
    };
  }
  const out: ModelEntry[] = [];
  for (const raw of input) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { error: "invalid_model", message: `provider "${providerId}" has a non-object model` };
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id.length === 0) {
      return { error: "invalid_model_id", message: `provider "${providerId}" has a model with no id` };
    }
    const m: ModelEntry = { id: r.id };
    if (typeof r.name === "string" && r.name) m.name = r.name;
    if (typeof r.reasoning === "boolean") m.reasoning = r.reasoning;
    if (typeof r.contextWindow === "number" && Number.isFinite(r.contextWindow))
      m.contextWindow = r.contextWindow;
    if (typeof r.maxTokens === "number" && Number.isFinite(r.maxTokens))
      m.maxTokens = r.maxTokens;
    if (typeof r.supportsImages === "boolean") m.supportsImages = r.supportsImages;
    if (typeof r.imageMaxBytes === "number" && Number.isFinite(r.imageMaxBytes))
      m.imageMaxBytes = r.imageMaxBytes;
    if (typeof r.mode === "string" && r.mode) m.mode = r.mode;
    if (r.compat && typeof r.compat === "object" && !Array.isArray(r.compat))
      m.compat = r.compat as Record<string, unknown>;
    out.push(m);
  }
  return { value: out };
}
