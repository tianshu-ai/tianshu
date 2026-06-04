// HTTP surface for the plugin runtime: GET /plugins + PATCH /plugins/:id.
//
// Factored out of `index.ts` so integration tests can mount the
// router on a fresh Express app with a controllable home dir +
// resolver — no socket, no shutdown plumbing.
//
// Mounted by the host at `/api`, so the actual paths are
// `/api/plugins` and `/api/plugins/:id`.

import express, { Router } from "express";
import {
  GlobalOps,
  loadTenantConfig,
  TenantConfigForbiddenFieldError,
  writeTenantConfig,
  type TenantContext,
} from "./core/index.js";
import {
  collectRoutesForTenant,
  PluginRegistry,
} from "./core/plugins/index.js";
import { CatalogClient } from "./catalog.js";

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

export interface PluginsRouterOpts {
  registry: PluginRegistry;
  ops: GlobalOps;
  /**
   * Optional catalog client. When provided, mounts GET
   * /plugins/catalog (and POST /plugins/catalog/refresh) so the
   * Plugin Manager UI can list installable plugins. Tests skip this
   * by leaving it undefined.
   */
  catalog?: CatalogClient;
}

/**
 * Builds an Express router exposing `/plugins` (GET) and
 * `/plugins/:id` (PATCH). Mount it where you want it, e.g.
 *   app.use("/api", buildPluginsRouter({ registry, ops }));
 */
export function buildPluginsRouter(opts: PluginsRouterOpts): Router {
  const { registry, ops, catalog } = opts;
  const r = Router();

  // Catalog endpoints. Mounted before /plugins/:id so the static
  // segment wins over the param route in Express's router order.
  if (catalog) {
    r.get("/plugins/catalog", async (_req, res, next) => {
      try {
        const snap = await catalog.get();
        res.json(snap);
      } catch (err) {
        next(err);
      }
    });
    r.post("/plugins/catalog/refresh", async (_req, res, next) => {
      try {
        catalog.invalidate();
        const snap = await catalog.get({ force: true });
        res.json(snap);
      } catch (err) {
        next(err);
      }
    });
  }

  r.get("/plugins", async (req, res, next) => {
    if (!req.ctx) {
      res.status(500).json({ error: "no_ctx" });
      return;
    }
    try {
      const list = await listPluginsForTenant(registry, req.ctx.tenant);
      res.json({ plugins: list });
    } catch (err) {
      next(err);
    }
  });

  r.patch("/plugins/:id", express.json(), async (req, res, next) => {
    if (!req.ctx) {
      res.status(500).json({ error: "no_ctx" });
      return;
    }

    const pluginId = req.params.id;
    if (!PLUGIN_ID_RE.test(pluginId)) {
      res.status(400).json({ error: "bad_plugin_id" });
      return;
    }

    const body = req.body as { enabled?: unknown } | undefined;
    if (!body || typeof body.enabled !== "boolean") {
      res.status(400).json({ error: "missing_enabled_boolean" });
      return;
    }

    try {
      const tenantId = req.ctx.tenant.tenantId;

      // Refuse to enable plugins we can't see at all (not on disk in
      // builtin or tenant). Disable is allowed even for unknown ids —
      // it's harmless and lets users prune stale entries from config.
      await registry.ensureForTenant(req.ctx.tenant);
      const known = registry
        .listForTenant(tenantId)
        .some((e) => e.manifest.id === pluginId);
      if (body.enabled && !known) {
        res.status(404).json({ error: "plugin_not_found", pluginId });
        return;
      }

      // Mutate the persisted tenant config.
      const cfg = loadTenantConfig(tenantId, ops.homeDir);
      const plugins = { ...(cfg.plugins ?? {}) };
      plugins[pluginId] = { ...(plugins[pluginId] ?? {}), enabled: body.enabled };
      writeTenantConfig(tenantId, { ...cfg, plugins }, ops.homeDir);

      // Invalidate cached registry so the next discovery + activation
      // sees the new config. TenantContext is rebuilt on every call
      // to ops.open() so config is always re-read from disk.
      registry.invalidate(tenantId);

      const fresh = ops.open(tenantId);
      const list = await listPluginsForTenant(registry, fresh);
      res.json({ plugins: list });
    } catch (err) {
      if (err instanceof TenantConfigForbiddenFieldError) {
        res.status(400).json({ error: "forbidden_field", message: err.message });
        return;
      }
      next(err);
    }
  });

  return r;
}

export async function listPluginsForTenant(
  registry: PluginRegistry,
  tenant: TenantContext,
) {
  await registry.ensureForTenant(tenant);
  // Calling collectRoutesForTenant here is intentional: it both
  // surfaces the route shape AND lazily marks any plugin whose
  // manifest claims a missing route handler as failed.
  collectRoutesForTenant(registry, tenant.tenantId);
  return registry.listForTenant(tenant.tenantId).map((e) => ({
    id: e.manifest.id,
    version: e.manifest.version,
    displayName: e.manifest.displayName,
    description: e.manifest.description ?? null,
    source: e.source,
    state: e.state,
    failedReason: e.failedReason ?? null,
    contributes: e.manifest.contributes ?? {},
    clientEntry: e.manifest.client?.entry ?? null,
  }));
}
