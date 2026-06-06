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
  /**
   * ADR-0004 §16: optional hook called by `POST /api/plugins/refresh`
   * before invalidating the registry cache. The host wires this up
   * to {@link buildReloadingBuiltinResolver}'s `reload()` so a
   * freshly-dropped plugin directory is picked up by the resolver
   * the same way the registry already picks up the manifest.
   *
   * Optional so existing tests / non-reloading wirings still work.
   */
  reloadResolver?: () => Promise<void>;
}

/**
 * Builds an Express router exposing `/plugins` (GET) and
 * `/plugins/:id` (PATCH). Mount it where you want it, e.g.
 *   app.use("/api", buildPluginsRouter({ registry, ops }));
 */
export function buildPluginsRouter(opts: PluginsRouterOpts): Router {
  const { registry, ops, catalog } = opts;
  const r = Router();

  // Plugin-contributed API routes are dispatched per-request so that
  // (a) we don't have to mount-once at boot (tenants are lazy) and
  // (b) enabling/disabling a plugin takes effect on the next request
  // without re-mounting Express. Manifest contracts:
  //   - declared path "/foo"          → /api/p/<plugin-id>/foo
  //   - declared path "/foo/bar/baz"  → /api/p/<plugin-id>/foo/bar/baz
  // We don't translate path params (`:id`) for v0 — plugins use
  // query strings.
  r.use("/p/:pluginId", async (req, res, next) => {
    if (!req.ctx) {
      res.status(500).json({ error: "no_ctx" });
      return;
    }
    const pluginId = req.params.pluginId;
    if (!PLUGIN_ID_RE.test(pluginId)) {
      res.status(404).json({ error: "plugin_not_found" });
      return;
    }
    try {
      await registry.ensureForTenant(req.ctx.tenant);
      const routes = collectRoutesForTenant(registry, req.ctx.tenant.tenantId);
      const subPath = req.path.length === 0 || req.path === "/" ? "/" : req.path;
      const match = routes.find(
        (rt) => rt.pluginId === pluginId && rt.method === req.method && rt.path === subPath,
      );
      if (!match) {
        res.status(404).json({ error: "plugin_route_not_found", pluginId, path: subPath });
        return;
      }
      await match.handler(req, res);
    } catch (err) {
      next(err);
    }
  });

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

  // ADR-0004 §16: explicit re-discovery. Useful after a manual
  // catalog install, a `git pull` that adds a new builtin in dev, or
  // any time the on-disk plugin set changed without a config edit.
  // PATCH /plugins/:id already invalidates the registry; this route
  // is for the no-config-change case.
  r.post("/plugins/refresh", async (req, res, next) => {
    if (!req.ctx) {
      res.status(500).json({ error: "no_ctx" });
      return;
    }
    try {
      // Re-scan the builtins directory before invalidating the
      // tenant registry, so a freshly-dropped plugin is reachable
      // by `server.entry` lookups when the next ensureForTenant()
      // re-activates everything.
      if (opts.reloadResolver) {
        await opts.reloadResolver();
      }
      // Await deactivate() so refreshing the plugin list while a
      // sandbox VM is running tears it down before the next
      // ensureForTenant brings up a fresh one.
      await registry.invalidate(req.ctx.tenant.tenantId);
      const fresh = ops.open(req.ctx.tenant.tenantId);
      const list = await listPluginsForTenant(registry, fresh);
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
      await registry.invalidate(tenantId);

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
    capabilities: {
      provided: e.capabilityInfo.provided,
      requires: e.capabilityInfo.requires,
      missing: e.capabilityInfo.missing,
    },
  }));
}
