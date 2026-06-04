// Server-side plugin registry: discovers + activates the plugins
// enabled for a given tenant. Cached per tenant, invalidated on
// tenant DB pool eviction.
//
// State machine for a discovered plugin id:
//
//   discovered → enabled-in-config? → activate() resolves
//        │           │                      │
//        │           └─ no  → state: "disabled"
//        │                                  │
//        │                                  ├─ ok → state: "active"
//        │                                  │
//        │                                  └─ throws → state: "failed"
//        │
//        └─ manifest.json invalid → state: "failed" (collected by discovery)
//
// "client-bundle-missing" is reserved for v1 — we'll set it once
// dynamic-import client loading lands. Today we always return
// "active" / "disabled" / "failed".

import type {
  PluginContext,
  PluginLogger,
  PluginManifest,
  PluginRouteHandler,
  PluginServerExports,
  PluginServerModule,
  PluginWsHandler,
} from "@tianshu/plugin-sdk";
import type { TenantContext } from "../tenant-context.js";
import { discoverPlugins, type DiscoveredPlugin } from "./discovery.js";

export type PluginState = "active" | "disabled" | "failed" | "client-bundle-missing";

export interface ActivePluginEntry {
  manifest: PluginManifest;
  source: "builtin" | "tenant";
  dir: string;
  state: PluginState;
  failedReason?: string;
  /** Available iff state === "active" */
  exports?: PluginServerExports;
}

export interface ServerPluginModuleResolver {
  /**
   * Given a plugin's `manifest.server.entry` string, return the
   * corresponding module. The host (server bin) wires the resolver up
   * with a static map of builtin entries; v1 will add dynamic
   * `import()` for tenant plugins.
   */
  resolve(entry: string): Promise<PluginServerModule | null> | PluginServerModule | null;
}

export interface RegistryOpts {
  resolver: ServerPluginModuleResolver;
  /** Optional discovery override (for tests). */
  discoveryDirs?: { builtinConfigDir?: string; home?: string };
  /** Optional broadcast hook for the plugin context. Default no-op. */
  broadcast?: (tenantId: string, type: string, payload: unknown) => void;
}

interface CachedTenantRegistry {
  entries: ActivePluginEntry[];
  byWsType: Map<string, { entry: ActivePluginEntry; handler: PluginWsHandler }>;
}

export class PluginRegistry {
  private readonly cache = new Map<string, CachedTenantRegistry>();

  constructor(private readonly opts: RegistryOpts) {}

  /** Idempotent: returns cached if already initialised for this tenant. */
  async ensureForTenant(ctx: TenantContext): Promise<ActivePluginEntry[]> {
    const cached = this.cache.get(ctx.tenantId);
    if (cached) return cached.entries;

    const cfg = readPluginsConfig(ctx);
    const discovery = discoverPlugins(ctx.tenantId, this.opts.discoveryDirs);

    const entries: ActivePluginEntry[] = [];

    // Failed manifests come through as failed entries with whatever id we
    // could parse from the manifest (if any).
    for (const f of discovery.failed) {
      entries.push({
        manifest: {
          id: f.pluginId ?? `(invalid:${f.dir})`,
          version: "0.0.0",
          displayName: f.pluginId ?? "(invalid manifest)",
        },
        source: f.source,
        dir: f.dir,
        state: "failed",
        failedReason: f.issues.join("; "),
      });
    }

    // Now process valid manifests against the tenant config.
    for (const p of discovery.plugins) {
      const enabled = cfg[p.manifest.id]?.enabled === true;
      if (!enabled) {
        entries.push({
          manifest: p.manifest,
          source: p.source,
          dir: p.dir,
          state: "disabled",
        });
        continue;
      }
      const activated = await this.activate(ctx, p);
      entries.push(activated);
    }

    // Build the WS dispatch map. Duplicate `wsMessages.type` registrations
    // mean the second plugin is rejected (state: failed).
    const byWsType = new Map<string, { entry: ActivePluginEntry; handler: PluginWsHandler }>();
    for (const e of entries) {
      if (e.state !== "active" || !e.manifest.contributes?.wsMessages) continue;
      const wsHandlers = e.exports?.wsHandlers ?? {};
      for (const ws of e.manifest.contributes.wsMessages) {
        const existing = byWsType.get(ws.type);
        if (existing) {
          e.state = "failed";
          e.failedReason = `ws message type "${ws.type}" already registered by plugin ${existing.entry.manifest.id}`;
          delete e.exports;
          continue;
        }
        const fn = wsHandlers[ws.handler];
        if (!fn) {
          // Manifest claimed a handler that isn't exported. Mark failed
          // but keep other plugins alive.
          e.state = "failed";
          e.failedReason = `wsHandlers["${ws.handler}"] missing in plugin ${e.manifest.id}`;
          delete e.exports;
          continue;
        }
        byWsType.set(ws.type, { entry: e, handler: fn });
      }
    }

    // Sort entries deterministically by id.
    entries.sort((a, b) =>
      a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0,
    );

    this.cache.set(ctx.tenantId, { entries, byWsType });
    return entries;
  }

  /** Drop a tenant's cached registry — call on tenant softDelete or DB eviction. */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  /** For routes layer: look up the WS handler for a {tenant, type}. */
  resolveWsHandler(
    tenantId: string,
    type: string,
  ): { entry: ActivePluginEntry; handler: PluginWsHandler } | undefined {
    return this.cache.get(tenantId)?.byWsType.get(type);
  }

  /** For routes layer: list all plugins (active + disabled + failed). */
  listForTenant(tenantId: string): ActivePluginEntry[] {
    return this.cache.get(tenantId)?.entries ?? [];
  }

  // ─── internals ─────────────────────────────────────────────────

  private async activate(
    ctx: TenantContext,
    p: DiscoveredPlugin,
  ): Promise<ActivePluginEntry> {
    if (!p.manifest.server?.entry) {
      // No server entry → the plugin is client-only. v0 doesn't load
      // those (we'd need a registry for client-only plugins too); mark
      // as active with no exports.
      return { manifest: p.manifest, source: p.source, dir: p.dir, state: "active" };
    }
    let mod: PluginServerModule | null = null;
    try {
      mod = await this.opts.resolver.resolve(p.manifest.server.entry);
    } catch (err) {
      return failed(p, `module resolve threw: ${describe(err)}`);
    }
    if (!mod) {
      return failed(p, `server.entry "${p.manifest.server.entry}" not registered`);
    }
    if (typeof mod.activate !== "function") {
      return failed(p, "server module does not export activate()");
    }
    const pluginCtx = makePluginContext({
      pluginId: p.manifest.id,
      ctx,
      broadcast: this.opts.broadcast,
    });
    let exports_: PluginServerExports;
    try {
      exports_ = await mod.activate(pluginCtx);
    } catch (err) {
      return failed(p, `activate() threw: ${describe(err)}`);
    }
    return {
      manifest: p.manifest,
      source: p.source,
      dir: p.dir,
      state: "active",
      exports: exports_,
    };
  }
}

function failed(p: DiscoveredPlugin, reason: string): ActivePluginEntry {
  return { manifest: p.manifest, source: p.source, dir: p.dir, state: "failed", failedReason: reason };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function readPluginsConfig(
  ctx: TenantContext,
): Record<string, { enabled?: boolean }> {
  const cfg = (ctx.config as { plugins?: unknown }).plugins;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return {};
  return cfg as Record<string, { enabled?: boolean }>;
}

function makePluginContext(args: {
  pluginId: string;
  ctx: TenantContext;
  broadcast?: (tenantId: string, type: string, payload: unknown) => void;
}): PluginContext {
  const { pluginId, ctx, broadcast } = args;
  const log: PluginLogger = bindLogger(pluginId, ctx.tenantId);
  return {
    pluginId,
    tenantId: ctx.tenantId,
    db: ctx.db,
    config: { defaultModel: ctx.config.defaultModel, branding: ctx.config.branding },
    log,
    workspaceDir: ctx.workspaceDir,
    userHomeDir: (userId: string) => ctx.userHomeDir(userId),
    broadcast: (type, payload) =>
      broadcast?.(ctx.tenantId, `${pluginId}:${type}`, payload),
  };
}

function bindLogger(pluginId: string, tenantId: string): PluginLogger {
  const prefix = `[plugin:${pluginId}] [tenant:${tenantId}]`;
  return {
    info: (msg, meta) => console.log(`${prefix} ${msg}`, meta ?? ""),
    warn: (msg, meta) => console.warn(`${prefix} ${msg}`, meta ?? ""),
    error: (msg, meta) => console.error(`${prefix} ${msg}`, meta ?? ""),
  };
}

/** A handler resolver from a plain server-module map (used by tests +
 *  builtin module wiring). */
export function moduleMapResolver(
  map: Record<string, PluginServerModule>,
): ServerPluginModuleResolver {
  return {
    resolve: (entry) => map[entry] ?? null,
  };
}

/** Build the API surface exposed via /api/p/<plugin-id>/<path>. */
export function collectRoutesForTenant(
  registry: PluginRegistry,
  tenantId: string,
): Array<{
  pluginId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  handler: PluginRouteHandler;
}> {
  const out: Array<{
    pluginId: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    handler: PluginRouteHandler;
  }> = [];
  for (const e of registry.listForTenant(tenantId)) {
    if (e.state !== "active" || !e.manifest.contributes?.apiRoutes) continue;
    const routeHandlers = e.exports?.routes ?? {};
    for (const r of e.manifest.contributes.apiRoutes) {
      const fn = routeHandlers[r.handler];
      if (!fn) {
        e.state = "failed";
        e.failedReason = `routes["${r.handler}"] missing in plugin ${e.manifest.id}`;
        delete e.exports;
        continue;
      }
      out.push({
        pluginId: e.manifest.id,
        method: r.method,
        path: r.path,
        handler: fn,
      });
    }
  }
  return out;
}
