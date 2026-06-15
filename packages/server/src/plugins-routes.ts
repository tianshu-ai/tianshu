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
  type McpServerEntry,
  McpManager,
  TenantConfigForbiddenFieldError,
  writeTenantConfig,
  type TenantContext,
} from "./core/index.js";
import {
  applyPluginSecretPatch,
  collectRoutesForTenant,
  loadPluginSecrets,
  PluginRegistry,
  redactSecretsInConfig,
} from "./core/plugins/index.js";
import { CatalogClient } from "./catalog.js";

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

/** Compiled form of a manifest-declared plugin route path. */
interface PluginPathPattern {
  /** RegExp anchored end-to-end against the request subPath. */
  re: RegExp;
  /** Capture-group order corresponds to occurrence in the
   *  declared path. */
  paramNames: string[];
}

/** Compiles `"/agents/:id/reset"` once and caches it. Plugin
 *  manifests are bounded so the cache stays small. */
const pluginPathCache = new Map<string, PluginPathPattern>();

function compilePluginPath(declared: string): PluginPathPattern {
  const cached = pluginPathCache.get(declared);
  if (cached) return cached;
  const paramNames: string[] = [];
  // Escape regex specials, then turn `:name` segments into capture
  // groups. We restrict the capture to a single URL segment
  // (`[A-Za-z0-9._~-]+`) so nested routes still work — a `/a/:id`
  // pattern shouldn't swallow `/a/b/c`.
  const escaped = declared
    .replace(/[.+*?^${}()|[\]\\]/g, (c) => `\\${c}`)
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
      paramNames.push(name);
      return "([A-Za-z0-9._~-]+)";
    });
  const re = new RegExp(`^${escaped}$`);
  const compiled = { re, paramNames };
  pluginPathCache.set(declared, compiled);
  return compiled;
}

/** Match `subPath` against a declared route path. Returns the
 *  param map (possibly empty) on success, or null on miss. */
function matchPluginPath(
  declared: string,
  subPath: string,
): Record<string, string> | null {
  const { re, paramNames } = compilePluginPath(declared);
  const m = re.exec(subPath);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < paramNames.length; i++) {
    const v = m[i + 1];
    if (v !== undefined) {
      out[paramNames[i]!] = decodeURIComponent(v);
    }
  }
  return out;
}

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
   * Host-owned MCP manager. Optional so tests skipping MCP routes
   * still mount this router cleanly. When omitted the
   * `/mcp/servers` POST/PATCH/DELETE routes return 503.
   */
  mcpManager?: McpManager;
  /**
   * Optional callback invoked when a plugin's enabled/disabled
   * state changes via PATCH /plugins/:id. The host wires this to
   * (a) broadcast a `plugins_changed` WS event so chat shells
   *     redraw + the agent gets told its tool surface moved, and
   * (b) append a synthetic system message into the user's active
   *     chat session so the LLM stops hallucinating tools that
   *     just got disabled.
   * Missing in tests — they don't run a chat surface.
   */
  onPluginsChanged?: (
    tenantId: string,
    delta: import("./chat/ws-protocol.js").PluginsChangedDelta,
    direction: "enabled" | "disabled",
  ) => void;
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
  //   - declared path "/foo"            → /api/p/<plugin-id>/foo
  //   - declared path "/foo/:id"        → /api/p/<plugin-id>/foo/<anything>
  //                                       and `:id` is exposed in
  //                                       req.params.id at handler
  //                                       time.
  // Path params accept `[A-Za-z0-9._~-]+` (one URL segment, no
  // slashes) which matches Express's default behaviour closely
  // enough for our handful of CRUD-style routes.
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
      let match: (typeof routes)[number] | null = null;
      let matchedParams: Record<string, string> | null = null;
      for (const rt of routes) {
        if (rt.pluginId !== pluginId || rt.method !== req.method) continue;
        const params = matchPluginPath(rt.path, subPath);
        if (params) {
          match = rt;
          matchedParams = params;
          break;
        }
      }
      if (!match) {
        res.status(404).json({ error: "plugin_route_not_found", pluginId, path: subPath });
        return;
      }
      // Express has already populated `req.params.pluginId` for the
      // outer mount; fold the inner route's params on top so the
      // handler sees them.
      if (matchedParams) {
        Object.assign(req.params, matchedParams);
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

  // ─── MCP servers view (host-owned) ──────────────────────────
  //
  // GET   /api/mcp/servers       — list every MCP server visible to the
  //                                tenant. Each entry has `source:
  //                                "plugin" | "user"` so the admin UI
  //                                can group + decide what's editable.
  // POST  /api/mcp/servers       — add a user-owned server. Body:
  //                                { id, url, displayName?, prefix?,
  //                                  upstreamHost?, enabled? }.
  // PATCH /api/mcp/servers/:id   — update a user-owned server.
  //                                Plugin-owned ids reject 403.
  // DELETE /api/mcp/servers/:id  — remove a user-owned server.
  //
  // Plugin-owned toolsets are read-only here — the admin UI tells
  // the user to enable/disable the owning plugin instead.
  r.get("/mcp/servers", async (req, res, next) => {
    if (!req.ctx) {
      res.status(500).json({ error: "no_ctx" });
      return;
    }
    try {
      await registry.ensureForTenant(req.ctx.tenant);
      const tenantId = req.ctx.tenant.tenantId;
      // Opportunistic refresh of stale entries: the toolset list
      // we get back may be empty / errored because the upstream
      // (e.g. sandbox MCP server) wasn't reachable at activate
      // time. Re-probe in parallel, capped by a short deadline so
      // the page render isn't blocked indefinitely. Anything that
      // fails again surfaces with `lastError`.
      const refreshed = await registry.refreshStaleToolsets(tenantId, 4000);
      void refreshed;
      res.json({ servers: registry.toolsetsForTenant(tenantId) });
    } catch (err) {
      next(err);
    }
  });

  r.post("/mcp/servers", express.json(), async (req, res, next) => {
    if (!req.ctx) {
      res.status(500).json({ error: "no_ctx" });
      return;
    }
    if (!opts.mcpManager) {
      res.status(503).json({ error: "mcp_manager_unavailable" });
      return;
    }
    try {
      const entry = parseUserEntry(req.body, { existingId: undefined });
      if ("error" in entry) {
        res.status(400).json(entry);
        return;
      }
      const tenantId = req.ctx.tenant.tenantId;
      const cfg = loadTenantConfig(tenantId, ops.homeDir);
      const servers = [...(cfg.mcp?.servers ?? [])];
      if (servers.some((s) => s.id === entry.value.id)) {
        res.status(409).json({ error: "id_in_use", id: entry.value.id });
        return;
      }
      servers.push(entry.value);
      writeTenantConfig(
        tenantId,
        { ...cfg, mcp: { ...(cfg.mcp ?? {}), servers } },
        ops.homeDir,
      );
      opts.mcpManager.reload(tenantId);
      const tsets = registry.toolsetsForTenant(tenantId);
      res.json({ servers: tsets });
    } catch (err) {
      if (err instanceof TenantConfigForbiddenFieldError) {
        res.status(400).json({ error: "forbidden_field", message: err.message });
        return;
      }
      next(err);
    }
  });

  r.patch("/mcp/servers/:id", express.json(), async (req, res, next) => {
    if (!req.ctx) {
      res.status(500).json({ error: "no_ctx" });
      return;
    }
    if (!opts.mcpManager) {
      res.status(503).json({ error: "mcp_manager_unavailable" });
      return;
    }
    try {
      const id = req.params.id;
      const tenantId = req.ctx.tenant.tenantId;
      const cfg = loadTenantConfig(tenantId, ops.homeDir);
      const servers = [...(cfg.mcp?.servers ?? [])];
      const idx = servers.findIndex((s) => s.id === id);
      if (idx === -1) {
        res.status(404).json({ error: "server_not_found", id });
        return;
      }
      const merged = parseUserEntry(
        { ...servers[idx], ...(req.body as Record<string, unknown>), id },
        { existingId: id },
      );
      if ("error" in merged) {
        res.status(400).json(merged);
        return;
      }
      servers[idx] = merged.value;
      writeTenantConfig(
        tenantId,
        { ...cfg, mcp: { ...(cfg.mcp ?? {}), servers } },
        ops.homeDir,
      );
      opts.mcpManager.reload(tenantId);
      const tsets = registry.toolsetsForTenant(tenantId);
      res.json({ servers: tsets });
    } catch (err) {
      next(err);
    }
  });

  r.delete("/mcp/servers/:id", async (req, res, next) => {
    if (!req.ctx) {
      res.status(500).json({ error: "no_ctx" });
      return;
    }
    if (!opts.mcpManager) {
      res.status(503).json({ error: "mcp_manager_unavailable" });
      return;
    }
    try {
      const id = req.params.id;
      const tenantId = req.ctx.tenant.tenantId;
      const cfg = loadTenantConfig(tenantId, ops.homeDir);
      const servers = (cfg.mcp?.servers ?? []).filter((s) => s.id !== id);
      writeTenantConfig(
        tenantId,
        { ...cfg, mcp: { ...(cfg.mcp ?? {}), servers } },
        ops.homeDir,
      );
      opts.mcpManager.reload(tenantId);
      const tsets = registry.toolsetsForTenant(tenantId);
      res.json({ servers: tsets });
    } catch (err) {
      next(err);
    }
  });

  // Force a refresh on one toolset for this tenant. Works for
  // both user-configured and plugin-contributed servers — the
  // admin UI doesn't know (or care) which is which, only that a
  // "Refresh" click should re-probe the upstream.
  r.post("/mcp/servers/:id/refresh", async (req, res, next) => {
    if (!req.ctx) {
      res.status(500).json({ error: "no_ctx" });
      return;
    }
    try {
      await registry.ensureForTenant(req.ctx.tenant);
      const id = req.params.id;
      const tenantId = req.ctx.tenant.tenantId;
      const tsets = registry.toolsetsForTenant(tenantId);
      const target = tsets.find((t) => t.id === id);
      if (!target) {
        res.status(404).json({ error: "server_not_found", id });
        return;
      }
      const provider = registry.toolsetProviderFor(target, tenantId);
      const refreshFn = (provider as { refresh?: () => Promise<void> } | null)
        ?.refresh;
      if (typeof refreshFn === "function") {
        await refreshFn.call(provider);
      }
      const fresh = registry.toolsetsForTenant(tenantId);
      res.json({ servers: fresh });
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

    const body = req.body as
      | { enabled?: unknown; config?: unknown }
      | undefined;
    if (!body) {
      res.status(400).json({ error: "empty_body" });
      return;
    }
    const hasEnabled = typeof body.enabled === "boolean";
    const hasConfig =
      body.config !== undefined &&
      body.config !== null &&
      typeof body.config === "object" &&
      !Array.isArray(body.config);
    if (!hasEnabled && !hasConfig) {
      res.status(400).json({
        error: "missing_enabled_or_config",
        message:
          "PATCH body must include `enabled: boolean` and/or `config: object`",
      });
      return;
    }

    try {
      const tenantId = req.ctx.tenant.tenantId;

      // Refuse to enable plugins we can't see at all (not on disk in
      // builtin or tenant). Disable is allowed even for unknown ids —
      // it's harmless and lets users prune stale entries from config.
      await registry.ensureForTenant(req.ctx.tenant);
      const knownEntry = registry
        .listForTenant(tenantId)
        .find((e) => e.manifest.id === pluginId);
      if (hasEnabled && body.enabled === true && !knownEntry) {
        res.status(404).json({ error: "plugin_not_found", pluginId });
        return;
      }
      if (hasConfig && !knownEntry) {
        res.status(404).json({ error: "plugin_not_found", pluginId });
        return;
      }

      // Capture the previous state BEFORE we mutate so we can
      // diff for the plugins_changed notification below.
      const wasEnabled = knownEntry?.state === "active";
      const willEnabled = hasEnabled
        ? (body.enabled as boolean)
        : wasEnabled;

      // Split the incoming config into (a) cleartext fields, kept
      // in tenant config.json, and (b) secret fields, sliced out
      // and persisted under <tenant>/secrets/plugin-<id>.json.
      // The split is driven by the manifest's configSchema: a
      // field with kind="secret" goes to secrets/, everything
      // else stays in config.json. Without a schema (no fields
      // declared) the body lands wholesale in config.json —
      // legacy plugins keep working unchanged.
      let plainConfig: Record<string, unknown> | undefined;
      let secretPatch:
        | Parameters<typeof applyPluginSecretPatch>[2]
        | undefined;
      if (hasConfig) {
        const fields = knownEntry?.manifest.configSchema?.fields ?? [];
        const secretKeys = new Set(
          fields.filter((f) => f.kind === "secret").map((f) => f.key),
        );
        if (secretKeys.size === 0) {
          plainConfig = body.config as Record<string, unknown>;
        } else {
          const split = splitSecrets(
            body.config as Record<string, unknown>,
            secretKeys,
          );
          plainConfig = split.plain;
          secretPatch = split.secrets;
        }
      }

      // Mutate the persisted tenant config.
      const cfg = loadTenantConfig(tenantId, ops.homeDir);
      const plugins = { ...(cfg.plugins ?? {}) };
      const existing = plugins[pluginId] ?? {};
      const next: { enabled?: boolean; config?: Record<string, unknown> } = {
        ...existing,
      };
      if (hasEnabled) next.enabled = body.enabled as boolean;
      if (plainConfig !== undefined) {
        next.config = plainConfig;
      }
      plugins[pluginId] = next;
      writeTenantConfig(tenantId, { ...cfg, plugins }, ops.homeDir);

      // And then persist the secret patch (if any) to the secrets/
      // file. Done AFTER config.json so a config write that
      // succeeded but a secrets write that failed leaves the
      // tenant in a recoverable state — the form just retries.
      if (secretPatch && Object.keys(secretPatch).length > 0) {
        const tenantForSecrets = ops.open(tenantId);
        applyPluginSecretPatch(
          tenantForSecrets.secretsDir,
          pluginId,
          secretPatch,
        );
      }

      // Invalidate cached registry so the next discovery + activation
      // sees the new config. TenantContext is rebuilt on every call
      // to ops.open() so config is always re-read from disk.
      await registry.invalidate(tenantId);

      const fresh = ops.open(tenantId);
      const list = await listPluginsForTenant(registry, fresh);

      // Notify the chat surface so (a) the WS gets a
      // `plugins_changed` event and (b) the active session gets
      // told the agent's tool list moved. We compute the delta from
      // the manifest — contributes.tools/toolsets is the source of
      // truth for what tools come and go with this plugin.
      if (
        opts.onPluginsChanged &&
        knownEntry &&
        hasEnabled &&
        wasEnabled !== willEnabled
      ) {
        const delta: import("./chat/ws-protocol.js").PluginsChangedDelta = {
          pluginId,
          displayName: knownEntry.manifest.displayName ?? pluginId,
          tools:
            knownEntry.manifest.contributes?.tools?.map((t) => t.id) ?? [],
          toolsets:
            knownEntry.manifest.contributes?.toolsets?.map((t) => t.id) ?? [],
        };
        try {
          opts.onPluginsChanged(
            tenantId,
            delta,
            willEnabled ? "enabled" : "disabled",
          );
        } catch (err) {
          // Notifications are non-fatal — the PATCH itself succeeded.
          console.warn(
            `[plugins-routes] onPluginsChanged threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
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

/**
 * Walk a posted plugin config object and split out the secret
 * fields. Secret keys are dotted paths (matching the form's flat
 * value map shape); we drop them from the cleartext object and
 * collect them into a SecretPatch the caller hands to
 * applyPluginSecretPatch.
 *
 * Two value shapes the form may submit per secret field:
 *   - string  — user typed a new value; persist it.
 *   - { __secret: true, set: <bool> }  — the redacted shape
 *     (form was rendered against an existing config and the user
 *     didn't touch the field). Treated as a no-op so saving the
 *     form without re-typing the key keeps the existing secret
 *     intact.
 *   - { __secret: true, clear: true }  — explicit clear; deletes
 *     the secret from secrets/. (The form's "clear" button sends
 *     this.)
 */
function splitSecrets(
  body: Record<string, unknown>,
  secretKeys: Set<string>,
): {
  plain: Record<string, unknown>;
  secrets: Parameters<typeof applyPluginSecretPatch>[2];
} {
  const plain: Record<string, unknown> = {};
  const secrets: Parameters<typeof applyPluginSecretPatch>[2] = {};
  // We only walk top-level keys for now — dotted secret keys
  // ("foo.bar") are nested by the form before being sent, so the
  // POST body contains nested objects. We recurse to find them.
  const visit = (
    obj: Record<string, unknown>,
    prefix: string,
    plainTarget: Record<string, unknown>,
  ) => {
    for (const [k, v] of Object.entries(obj)) {
      const dotted = prefix ? `${prefix}.${k}` : k;
      if (secretKeys.has(dotted)) {
        if (typeof v === "string") {
          secrets[dotted] = v;
        } else if (
          v &&
          typeof v === "object" &&
          (v as { __secret?: unknown }).__secret === true
        ) {
          if ((v as { clear?: unknown }).clear === true) {
            secrets[dotted] = { __secret: true, clear: true };
          }
          // else: redacted shape — no-op (leave existing secret).
        }
        // Don't write the secret to plain.
        continue;
      }
      if (v && typeof v === "object" && !Array.isArray(v)) {
        plainTarget[k] = {};
        visit(
          v as Record<string, unknown>,
          dotted,
          plainTarget[k] as Record<string, unknown>,
        );
      } else {
        plainTarget[k] = v;
      }
    }
  };
  visit(body, "", plain);
  return { plain, secrets };
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

  const tenantConfigPlugins =
    (tenant.config.plugins ?? {}) as Record<
      string,
      { config?: Record<string, unknown> }
    >;

  return registry.listForTenant(tenant.tenantId).map((e) => {
    const rawConfig = tenantConfigPlugins[e.manifest.id]?.config ?? {};
    // Redact any `secret`-kind fields before exposing the config
    // to the browser. The plugin admin form only needs to know
    // whether each secret is set; the cleartext stays on disk
    // under `<tenant>/secrets/plugin-<id>.json`.
    const fields = e.manifest.configSchema?.fields ?? [];
    const hasSecrets = fields.some((f) => f.kind === "secret");
    let safeConfig: Record<string, unknown> = rawConfig;
    if (hasSecrets) {
      const secrets = loadPluginSecrets(
        tenant.secretsDir,
        e.manifest.id,
      );
      safeConfig = redactSecretsInConfig(rawConfig, fields, secrets);
    }
    return {
    id: e.manifest.id,
    version: e.manifest.version,
    displayName: e.manifest.displayName,
    description: e.manifest.description ?? null,
    source: e.source,
    state: e.state,
    failedReason: e.failedReason ?? null,
    contributes: e.manifest.contributes ?? {},
    clientEntry: e.manifest.client?.entry ?? null,
    /** Declarative form schema; UI uses this to render the config
     *  panel. Null when the plugin doesn't expose user-editable
     *  config. */
    configSchema: e.manifest.configSchema ?? null,
    /** Current persisted config object — same shape the plugin sees
     *  via PluginContext.pluginConfig, except `secret`-kind values
     *  are replaced with `{ __secret: true, set: <bool> }` so the
     *  browser never sees cleartext. */
    config: safeConfig,
    capabilities: {
      provided: e.capabilityInfo.provided,
      requires: e.capabilityInfo.requires,
      missing: e.capabilityInfo.missing,
    },
    };
  });
}

// Validation for the body of POST/PATCH /mcp/servers. Returns either
// `{ value: <entry> }` or `{ error: <code>, message: ... }` so the
// caller can hand the latter straight to `res.json`.
function parseUserEntry(
  raw: unknown,
  ctx: { existingId: string | undefined },
): { value: McpServerEntry } | { error: string; message: string } {
  if (!raw || typeof raw !== "object") {
    return { error: "bad_body", message: "expected JSON object" };
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  if (!id) return { error: "bad_id", message: "id is required" };
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id)) {
    return {
      error: "bad_id",
      message: "id must be 1-31 chars: lowercase letters, digits, dashes",
    };
  }
  if (ctx.existingId !== undefined && id !== ctx.existingId) {
    return {
      error: "id_immutable",
      message: "id cannot be changed via PATCH",
    };
  }
  const url = typeof r.url === "string" ? r.url.trim() : "";
  if (!url) return { error: "bad_url", message: "url is required" };
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { error: "bad_url", message: "url must be http(s)" };
    }
  } catch {
    return { error: "bad_url", message: "url is not a valid URL" };
  }
  const entry: McpServerEntry = { id, url };
  if (typeof r.displayName === "string" && r.displayName.length) {
    entry.displayName = r.displayName.slice(0, 80);
  }
  if (typeof r.prefix === "string") {
    entry.prefix = r.prefix.slice(0, 32);
  }
  if (typeof r.upstreamHost === "string" && r.upstreamHost.length) {
    entry.upstreamHost = r.upstreamHost.slice(0, 200);
  }
  if (typeof r.enabled === "boolean") entry.enabled = r.enabled;
  return { value: entry };
}
