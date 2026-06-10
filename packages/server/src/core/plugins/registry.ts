// Server-side plugin registry: discovers + activates the plugins
// enabled for a given tenant. Cached per tenant, invalidated on
// tenant DB pool eviction or via PATCH /api/plugins/:id.
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
//
// ADR-0004 additions on top of ADR-0003:
//
// - Topological activation order based on `requires[]` edges. A
//   plugin's `activate()` only runs after every plugin providing its
//   required capabilities is already active. Cycles fail the whole
//   cycle (each member marked failed); plugins outside the cycle
//   continue.
// - Capability registry: a per-tenant map from capability name →
//   provider entry + value. Sandbox runners are values of type
//   `SandboxRunner` (registered under `sandbox.shell`); browser
//   sidecars piggyback on the same runner via `runner.browser`
//   (registered under `browser.cdp`).
// - Exclusivity enforcement: capabilities flagged `exclusive: true`
//   in `KNOWN_CAPABILITIES` reject a second provider; the second
//   plugin in topo order is marked failed.
// - Visibility (§17): builtin plugins NOT listed in tenant config
//   still appear in `listForTenant()` as `state: "disabled"`. Tenant
//   plugins on disk but not in config also appear as disabled.

import type {
  CapabilityHandle,
  AgentTool,
  CapabilityName,
  PluginContext,
  PluginLogger,
  PluginManifest,
  PluginRouteHandler,
  PluginServerExports,
  PluginServerModule,
  PluginWsHandler,
  SandboxRunner,
} from "@tianshu/plugin-sdk";
import { isCapabilityName, KNOWN_CAPABILITIES } from "@tianshu/plugin-sdk";
import type { TenantContext } from "../tenant-context.js";
import { discoverPlugins, type DiscoveredPlugin } from "./discovery.js";
import { loadSkillsForPlugin, type LoadedSkill } from "./skills.js";

export type PluginState = "active" | "disabled" | "failed" | "client-bundle-missing";

export interface ActivePluginEntry {
  manifest: PluginManifest;
  source: "builtin" | "tenant";
  dir: string;
  state: PluginState;
  failedReason?: string;
  /** Available iff state === "active" */
  exports?: PluginServerExports;
  /**
   * The resolved server module. Held so `invalidate()` can call
   * the plugin's `deactivate()` hook before dropping the cache;
   * without this, e.g. microsandbox VMs would orphan when a tenant
   * disables the plugin or evicts its DB pool entry.
   */
  module?: PluginServerModule;
  /** Capability inventory for this plugin, computed at activation
   *  time. Always present; empty arrays when nothing applies. */
  capabilityInfo: PluginCapabilityInfo;
}

export interface PluginCapabilityInfo {
  /** Capabilities this plugin provided successfully (registered in
   *  `byCapability`). Empty for non-active plugins. */
  provided: CapabilityName[];
  /** Capabilities the manifest's `requires[]` listed. Always present
   *  regardless of state. */
  requires: CapabilityName[];
  /** Subset of `requires` that no other plugin provided in this
   *  tenant. For active plugins this is always empty (we wouldn't
   *  have activated). For failed plugins it explains why. */
  missing: CapabilityName[];
}

export interface ProvidedCapability {
  capability: CapabilityName;
  pluginId: string;
  exclusive: boolean;
  value: unknown;
}

/**
 * Cross-source view of one MCP toolset surfaced through
 * `toolsetsForTenant()`. Either contributed by a plugin or
 * configured by the user; the consumer (admin UI / agent loop)
 * decides what to do with that distinction.
 */
export interface ToolsetSummary {
  /** Where the toolset came from. */
  source: "plugin" | "user";
  /** Plugin id when source==plugin; literal `"core"` when source==user. */
  sourceId: string;
  /** Local id within the source. */
  id: string;
  /** Display label for the admin UI. */
  displayName: string;
  /** False only for user entries explicitly marked enabled=false. */
  enabled: boolean;
  /** ToolsetProvider's `name` (often == displayName but sometimes
   *  finer-grained, e.g. McpToolset(name="playwright")). */
  providerName: string;
  /** McpToolset.snapshot() output when the provider exposes
   *  snapshot(); null otherwise. */
  snapshot:
    | import("@tianshu/plugin-sdk").McpToolsetSnapshot
    | null;
  /** Reflected tool count (snapshot.tools.length when known, else
   *  derived via listTools()). */
  toolCount: number;
  /** Verbatim user-config entry. Only present for source==user. */
  userEntry?: {
    id: string;
    displayName?: string;
    url: string;
    prefix?: string;
    upstreamHost?: string;
    enabled: boolean;
  };
}

function summariseToolset(args: {
  source: "plugin" | "user";
  sourceId: string;
  id: string;
  displayName: string;
  enabled: boolean;
  provider: import("@tianshu/plugin-sdk").ToolsetProvider;
  logTag: string;
}): ToolsetSummary {
  let snapshot:
    | import("@tianshu/plugin-sdk").McpToolsetSnapshot
    | null = null;
  try {
    snapshot = args.provider.snapshot ? args.provider.snapshot() : null;
  } catch (err) {
    console.warn(
      `[${args.logTag}] toolset "${args.id}" snapshot() threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  let toolCount = snapshot?.tools.length ?? 0;
  if (toolCount === 0) {
    try {
      toolCount = args.provider.listTools().length;
    } catch {
      toolCount = 0;
    }
  }
  return {
    source: args.source,
    sourceId: args.sourceId,
    id: args.id,
    displayName: args.displayName,
    enabled: args.enabled,
    providerName: args.provider.name,
    snapshot,
    toolCount,
  };
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
  /**
   * Optional host-owned MCP manager. When present, user-configured
   * MCP toolsets (`tenant config.mcp.servers[]`) are merged into
   * `toolsForTenant()` alongside plugin-contributed ones, and
   * surface in `toolsetsForTenant()` with `source: "user"`.
   *
   * Optional so tests / older wirings still work without it.
   */
  mcpManager?: import("../mcp-manager.js").McpManager;
  /** Optional discovery override (for tests). */
  discoveryDirs?: { builtinConfigDir?: string; home?: string };
  /** Optional broadcast hook for the plugin context. Default no-op. */
  broadcast?: (tenantId: string, type: string, payload: unknown) => void;
  /**
   * Capabilities the host itself provides (i.e. not coming from a
   * plugin's `provides[]`). Pre-seeded into every tenant's
   * capability map BEFORE plugin activation so plugins listing the
   * same name in `requires[]` can pick them up.
   *
   * Each entry is a factory: it gets the tenant context and
   * returns the capability value to expose. This lets host-side
   * capabilities bind per-tenant state (db, config) without the
   * plugin needing to know about it.
   *
   * Today the only entry is `host.agentLoop` (the workboard plugin
   * uses it to run LLM workers). Adding new ones is a host change,
   * not a plugin change.
   */
  hostCapabilities?: Partial<
    Record<CapabilityName, (ctx: TenantContext) => unknown>
  >;
}

interface CachedTenantRegistry {
  entries: ActivePluginEntry[];
  byWsType: Map<string, { entry: ActivePluginEntry; handler: PluginWsHandler }>;
  byCapability: Map<CapabilityName, ProvidedCapability>;
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
        capabilityInfo: emptyCapabilityInfo(),
      });
    }

    // Compute activation order over the subset enabled in tenant
    // config. `requires` edges only matter between enabled plugins;
    // a disabled plugin can't satisfy anything.
    const enabledIds = new Set(
      discovery.plugins
        .filter((p) => cfg[p.manifest.id]?.enabled === true)
        .map((p) => p.manifest.id),
    );

    const ordered = topologicalOrder(discovery.plugins, enabledIds);
    const enabledById = new Map(
      discovery.plugins.map((p) => [p.manifest.id, p] as const),
    );

    // Plugins that aren't enabled show up as disabled rows, with
    // their capabilityInfo precomputed for the UI.
    for (const p of discovery.plugins) {
      if (enabledIds.has(p.manifest.id)) continue;
      entries.push({
        manifest: p.manifest,
        source: p.source,
        dir: p.dir,
        state: "disabled",
        capabilityInfo: {
          provided: [],
          requires: capabilityList(p.manifest.requires),
          missing: [],
        },
      });
    }

    // Cycle members are precomputed so we can fail them in one shot.
    const cycleMembers = new Set(ordered.cycle);
    const byCapability = new Map<CapabilityName, ProvidedCapability>();

    // Pre-seed host-provided capabilities so plugins requiring
    // them can resolve. The synthetic provider id `__host__` makes
    // it obvious in logs that no plugin owns these.
    for (const [cap, factory] of Object.entries(this.opts.hostCapabilities ?? {})) {
      if (!isCapabilityName(cap) || !factory) continue;
      const value = factory(ctx);
      if (value === undefined || value === null) continue;
      byCapability.set(cap as CapabilityName, {
        capability: cap as CapabilityName,
        pluginId: "__host__",
        exclusive: KNOWN_CAPABILITIES[cap as CapabilityName].exclusive,
        value,
      });
    }

    // Activate plugins in topological order.
    for (const id of ordered.order) {
      const p = enabledById.get(id);
      if (!p) continue;

      // 1) Cycle members fail with a specific reason.
      if (cycleMembers.has(id)) {
        entries.push({
          manifest: p.manifest,
          source: p.source,
          dir: p.dir,
          state: "failed",
          failedReason: `circular requires: ${ordered.cycle.join(" → ")}`,
          capabilityInfo: {
            provided: [],
            requires: capabilityList(p.manifest.requires),
            missing: [],
          },
        });
        continue;
      }

      // 2) Resolve requires: every required capability must already
      //    be in byCapability.
      const requires = capabilityList(p.manifest.requires);
      const missing = requires.filter((c) => !byCapability.has(c));
      if (missing.length > 0) {
        entries.push({
          manifest: p.manifest,
          source: p.source,
          dir: p.dir,
          state: "failed",
          failedReason: `requires capability ${missing
            .map((c) => `"${c}"`)
            .join(", ")} — no provider enabled`,
          capabilityInfo: { provided: [], requires, missing },
        });
        continue;
      }

      // 3) Exclusivity check: if this plugin provides any exclusive
      //    capability already taken, fail it.
      const declared = capabilityList(p.manifest.provides);
      const conflict = declared.find((c) => {
        const spec = KNOWN_CAPABILITIES[c];
        return spec.exclusive && byCapability.has(c);
      });
      if (conflict) {
        const owner = byCapability.get(conflict)!.pluginId;
        entries.push({
          manifest: p.manifest,
          source: p.source,
          dir: p.dir,
          state: "failed",
          failedReason: `capability "${conflict}" already provided by plugin ${owner}`,
          capabilityInfo: { provided: [], requires, missing: [] },
        });
        continue;
      }

      // 4) Activate the plugin.
      const activated = await this.activate(ctx, p, byCapability);
      entries.push(activated);

      // 5) On success, register capabilities the plugin actually
      //    backed (sandboxes contribution + runner.browser for
      //    browser.cdp). If a declared capability has no backing
      //    runner, mark the plugin failed.
      if (activated.state === "active") {
        const ok = registerProvidedCapabilities(activated, byCapability);
        if (!ok.ok) {
          activated.state = "failed";
          activated.failedReason = ok.reason;
          delete activated.exports;
          activated.capabilityInfo = {
            provided: [],
            requires,
            missing: [],
          };
          // Roll back any partial registrations from this plugin.
          for (const cap of activated.capabilityInfo.provided) {
            const owner = byCapability.get(cap);
            if (owner?.pluginId === activated.manifest.id) byCapability.delete(cap);
          }
        }
      }
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

    this.cache.set(ctx.tenantId, { entries, byWsType, byCapability });
    return entries;
  }

  /**
   * Drop a tenant's cached registry. Calls each active plugin's
   * `deactivate()` hook (best-effort, sequential) so plugins can
   * release resources — sandbox VMs, child processes, file
   * watchers, etc. — before the next `ensureForTenant()` rebuilds
   * everything from scratch.
   *
   * Returns a promise so callers that want to ensure deactivation
   * finished before re-entering `ensureForTenant` can await it. The
   * existing `void`-returning callers (e.g. tenant softDelete on
   * pool eviction) ignore the promise and that's fine — the host
   * just won't wait for slow shutdowns to land.
   */
  invalidate(tenantId: string): Promise<void> {
    const cached = this.cache.get(tenantId);
    this.cache.delete(tenantId);
    if (!cached) return Promise.resolve();
    return this.runDeactivations(cached.entries);
  }

  private async runDeactivations(entries: ActivePluginEntry[]): Promise<void> {
    // Sequential, reverse-of-entries order. v0 ordering is
    // reverse id-sort (entries are sorted alphabetically); a
    // plugin's deactivate() should not rely on another plugin's
    // capabilities still being up. A future revision may promote
    // this to true reverse-topological if a real consumer needs
    // it.
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.state !== "active") continue;
      const fn = e.module?.deactivate;
      if (typeof fn !== "function") continue;
      try {
        await fn();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[plugin:${e.manifest.id}] deactivate() threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
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

  /** For agent / other host code: read the tenant capability registry. */
  capabilityFor<T = unknown>(tenantId: string, name: CapabilityName): T | undefined {
    return this.cache.get(tenantId)?.byCapability.get(name)?.value as T | undefined;
  }

  /**
   * Collect every tool every active plugin contributed for this
   * tenant. Each entry pairs the tool object with its source
   * plugin id (used for logging / Plugin Manager UI). The agent
   * loop further filters by each tool's `available()` gate before
   * registering with pi-ai.
   */
  toolsForTenant(tenantId: string): Array<{ pluginId: string; tool: AgentTool }> {
    const out: Array<{ pluginId: string; tool: AgentTool }> = [];
    const cached = this.cache.get(tenantId);
    if (!cached) return out;

    // (0) User-configured MCP toolsets (host-owned). These are
    // surfaced under a synthetic plugin id of `core` so the agent
    // logging + plugin manager UI can tell them apart from plugin
    // contributions.
    if (this.opts.mcpManager) {
      for (const provider of this.opts.mcpManager.providersForTenant(tenantId)) {
        try {
          for (const tool of provider.listTools()) {
            out.push({ pluginId: "core", tool });
          }
        } catch (err) {
          console.warn(
            `[mcp:user] toolset "${provider.name}" listTools() threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    for (const e of cached.entries) {
      if (e.state !== "active") continue;
      // (1) Static tool contributions: one AgentTool per
      // `manifest.contributes.tools[]` entry, looked up by `module`.
      const toolModules = e.exports?.tools ?? {};
      for (const t of e.manifest.contributes?.tools ?? []) {
        const tool = toolModules[t.module];
        if (!tool) {
          // Manifest claimed a tool but exports.tools didn't expose
          // the matching module. Mark plugin failed so the operator
          // sees it in /api/plugins; skip emission.
          e.state = "failed";
          e.failedReason = `tools["${t.module}"] missing in plugin ${e.manifest.id}`;
          delete e.exports;
          continue;
        }
        out.push({ pluginId: e.manifest.id, tool });
      }
      // (2) Dynamic toolset providers: each provider's listTools()
      // is read every turn so MCP servers can come/go without a
      // plugin reactivation. Errors inside listTools() are isolated
      // (logged + skipped) so a single misbehaving toolset doesn't
      // black out the agent's other tools.
      if (e.state !== "active") continue;
      const providerModules = e.exports?.toolsetProviders ?? {};
      for (const ts of e.manifest.contributes?.toolsets ?? []) {
        const provider = providerModules[ts.module];
        if (!provider) {
          e.state = "failed";
          e.failedReason = `toolsetProviders["${ts.module}"] missing in plugin ${e.manifest.id}`;
          delete e.exports;
          continue;
        }
        let dynamic: AgentTool[] = [];
        try {
          dynamic = provider.listTools();
        } catch (err) {
          // Same behaviour as a per-call error inside an AgentTool:
          // log and keep going. Don't poison the rest of the run.
          console.warn(
            `[plugins:${e.manifest.id}] toolset "${ts.id}" listTools() threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        for (const tool of dynamic) {
          out.push({ pluginId: e.manifest.id, tool });
        }
      }
    }
    return out;
  }

  /**
   * Collect every toolset provider every active plugin contributed
   * for this tenant. Powers the global `/admin/mcp` view, which
   * lists every connected MCP server (or other dynamic toolset)
   * across plugins. Each entry includes the snapshot if the
   * provider exposes one.
   */
  /**
   * Look up the live ToolsetProvider behind a toolset summary, so
   * routes can call refresh() on it. Returns null when the source
   * has gone away (plugin disabled, user entry deleted) since the
   * summary was generated.
   */
  toolsetProviderFor(
    summary: { source: "plugin" | "user"; sourceId: string; id: string },
    tenantId: string,
  ): import("@tianshu/plugin-sdk").ToolsetProvider | null {
    if (summary.source === "user") {
      if (!this.opts.mcpManager) return null;
      const snaps = this.opts.mcpManager.snapshotsForTenant(tenantId);
      return snaps.find((s) => s.id === summary.id)?.provider ?? null;
    }
    // source === "plugin"
    const cached = this.cache.get(tenantId);
    if (!cached) return null;
    const entry = cached.entries.find(
      (e) => e.manifest.id === summary.sourceId,
    );
    if (!entry || entry.state !== "active") return null;
    const ts = entry.manifest.contributes?.toolsets?.find(
      (t) => t.id === summary.id,
    );
    if (!ts) return null;
    return entry.exports?.toolsetProviders?.[ts.module] ?? null;
  }

  toolsetsForTenant(tenantId: string): ToolsetSummary[] {
    const out: ToolsetSummary[] = [];

    // (1) Plugin-contributed toolsets. Source: their plugin id.
    const cached = this.cache.get(tenantId);
    if (cached) {
      for (const e of cached.entries) {
        if (e.state !== "active") continue;
        const providers = e.exports?.toolsetProviders ?? {};
        for (const ts of e.manifest.contributes?.toolsets ?? []) {
          const provider = providers[ts.module];
          if (!provider) continue;
          out.push(summariseToolset({
            source: "plugin",
            sourceId: e.manifest.id,
            id: ts.id,
            displayName: ts.displayName ?? ts.id,
            enabled: true,
            provider,
            logTag: `plugins:${e.manifest.id}`,
          }));
        }
      }
    }

    // (2) User-configured toolsets (host-owned). Source: `"user"`.
    if (this.opts.mcpManager) {
      for (const snap of this.opts.mcpManager.snapshotsForTenant(tenantId)) {
        out.push({
          source: "user",
          sourceId: "core",
          id: snap.id,
          displayName: snap.displayName,
          enabled: snap.enabled,
          providerName: snap.provider?.name ?? snap.displayName,
          snapshot: snap.toolsetSnapshot,
          toolCount: snap.toolsetSnapshot?.tools.length ?? 0,
          // Round-trip the user's stored config so the admin UI can
          // show url / upstreamHost / prefix in edit dialogs.
          userEntry: {
            id: snap.entry.id,
            displayName: snap.entry.displayName,
            url: snap.entry.url,
            prefix: snap.entry.prefix,
            upstreamHost: snap.entry.upstreamHost,
            enabled: snap.entry.enabled !== false,
          },
        });
      }
    }

    return out;
  }

  /**
   * Collect every skill contributed by every active plugin for
   * this tenant. The host adds its own self-shipped skills on top
   * of these (they live under `<repoRoot>/skills/`, not in any
   * plugin). Caller filters by `when:` predicate against the
   * current tool/capability set; see `filterSkillsForTenant`.
   */
  skillsForTenant(tenantId: string): LoadedSkill[] {
    const out: LoadedSkill[] = [];
    const cached = this.cache.get(tenantId);
    if (!cached) return out;
    for (const e of cached.entries) {
      if (e.state !== "active" || !e.manifest.contributes?.skills) continue;
      const result = loadSkillsForPlugin({
        pluginId: e.manifest.id,
        pluginDir: e.dir,
        contributions: e.manifest.contributes.skills,
      });
      out.push(...result.skills);
      for (const f of result.failures) {
        // Surface skill load failures as plugin-failed so the Plugin
        // Manager UI shows them; we don't fail the whole plugin
        // because a missing skill file shouldn't kill its tools.
        // eslint-disable-next-line no-console
        console.warn(
          `[plugin:${f.source.pluginId}] skill ${f.source.contributionId} (${f.filePath}): ${f.reason}`,
        );
      }
    }
    return out;
  }

  /**
   * Build a small read-only capability lookup handle scoped to one
   * tenant. Same shape as `PluginContext.capabilities` but for
   * host-side consumers (agent loop, tool factories) that don't
   * have a `PluginContext`.
   */
  hostCapabilities(tenantId: string): HostCapabilityHandle {
    return {
      get: <T = unknown>(name: CapabilityName) =>
        this.capabilityFor<T>(tenantId, name),
      has: (name: CapabilityName) =>
        Boolean(this.cache.get(tenantId)?.byCapability.has(name)),
    };
  }

  // ─── internals ─────────────────────────────────────────────────

  private async activate(
    ctx: TenantContext,
    p: DiscoveredPlugin,
    byCapability: Map<CapabilityName, ProvidedCapability>,
  ): Promise<ActivePluginEntry> {
    const requires = capabilityList(p.manifest.requires);

    if (!p.manifest.server?.entry) {
      // No server entry → the plugin is client-only. v0 doesn't load
      // those (we'd need a registry for client-only plugins too); mark
      // as active with no exports.
      return {
        manifest: p.manifest,
        source: p.source,
        dir: p.dir,
        state: "active",
        capabilityInfo: { provided: [], requires, missing: [] },
      };
    }
    let mod: PluginServerModule | null = null;
    try {
      mod = await this.opts.resolver.resolve(p.manifest.server.entry);
    } catch (err) {
      return failed(p, requires, `module resolve threw: ${describe(err)}`);
    }
    if (!mod) {
      return failed(
        p,
        requires,
        `server.entry "${p.manifest.server.entry}" not registered`,
      );
    }
    if (typeof mod.activate !== "function") {
      return failed(p, requires, "server module does not export activate()");
    }
    const pluginCtx = makePluginContext({
      pluginId: p.manifest.id,
      ctx,
      broadcast: this.opts.broadcast,
      byCapability,
    });
    let exports_: PluginServerExports;
    try {
      exports_ = await mod.activate(pluginCtx);
    } catch (err) {
      return failed(p, requires, `activate() threw: ${describe(err)}`);
    }
    return {
      manifest: p.manifest,
      source: p.source,
      dir: p.dir,
      state: "active",
      exports: exports_,
      module: mod,
      capabilityInfo: { provided: [], requires, missing: [] },
    };
  }
}

/**
 * Read-only capability lookup handle for host code (agent loop,
 * tool builders). Subset of `CapabilityHandle` from the SDK — we
 * intentionally don't expose `on()` event subscription here so
 * registry-mutation paths stay inside the registry itself.
 */
export interface HostCapabilityHandle {
  get<T = unknown>(name: CapabilityName): T | undefined;
  has(name: CapabilityName): boolean;
}

function failed(
  p: DiscoveredPlugin,
  requires: CapabilityName[],
  reason: string,
): ActivePluginEntry {
  return {
    manifest: p.manifest,
    source: p.source,
    dir: p.dir,
    state: "failed",
    failedReason: reason,
    capabilityInfo: { provided: [], requires, missing: [] },
  };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function readPluginsConfig(
  ctx: TenantContext,
): Record<string, { enabled?: boolean; config?: Record<string, unknown> }> {
  const cfg = (ctx.config as { plugins?: unknown }).plugins;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return {};
  return cfg as Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
}

function readPluginConfig(ctx: TenantContext, pluginId: string): Record<string, unknown> {
  const all = readPluginsConfig(ctx);
  const c = all[pluginId]?.config;
  return c && typeof c === "object" && !Array.isArray(c) ? (c as Record<string, unknown>) : {};
}

function makePluginContext(args: {
  pluginId: string;
  ctx: TenantContext;
  broadcast?: (tenantId: string, type: string, payload: unknown) => void;
  byCapability: Map<CapabilityName, ProvidedCapability>;
}): PluginContext {
  const { pluginId, ctx, broadcast, byCapability } = args;
  const log: PluginLogger = bindLogger(pluginId, ctx.tenantId);
  const capabilities: CapabilityHandle = {
    get: <T = unknown>(name: CapabilityName) =>
      byCapability.get(name)?.value as T | undefined,
    has: (name: CapabilityName) => byCapability.has(name),
    on: () => () => {
      // v0: no-op. Lifecycle events are fired by registry.invalidate
      // → ensureForTenant rebuilds, but we don't yet plumb listeners
      // through. ADR-0004 §8 says v0 ships get/has only; on() is
      // declared so plugins can write code that targets v1 already.
    },
  };
  return {
    pluginId,
    tenantId: ctx.tenantId,
    db: ctx.db,
    tenantConfig: { defaultModel: ctx.config.defaultModel, branding: ctx.config.branding },
    // Deprecated alias kept until the next major SDK bump so v0
    // plugin code that read `ctx.config` still works.
    config: { defaultModel: ctx.config.defaultModel, branding: ctx.config.branding },
    log,
    workspaceDir: ctx.workspaceDir,
    userHomeDir: (userId: string) => ctx.userHomeDir(userId),
    broadcast: (type, payload) =>
      broadcast?.(ctx.tenantId, `${pluginId}:${type}`, payload),
    capabilities,
    pluginConfig: readPluginConfig(ctx, pluginId),
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

// ─── helpers ─────────────────────────────────────────────────────

function capabilityList(raw: string[] | undefined): CapabilityName[] {
  if (!raw) return [];
  // Manifest validator already filtered to known names, but be
  // defensive in case someone constructs a manifest in code (tests).
  return raw.filter(isCapabilityName) as CapabilityName[];
}

function emptyCapabilityInfo(): PluginCapabilityInfo {
  return { provided: [], requires: [], missing: [] };
}

interface TopoResult {
  /** Activation order by id, plugins outside any cycle first. Cycle
   *  members are appended in id order so they still get processed. */
  order: string[];
  /** Ids that participated in a cycle and must be marked failed. */
  cycle: string[];
}

/**
 * Kahn's algorithm over plugins in the enabled set. Edges are
 * `requires(provider)` (provider satisfies the required capability),
 * resolved by scanning every enabled plugin's `provides[]`. We don't
 * care which specific provider satisfies a capability — any works.
 */
function topologicalOrder(
  plugins: DiscoveredPlugin[],
  enabledIds: Set<string>,
): TopoResult {
  // capability → ids of providers (within enabled set)
  const providers = new Map<CapabilityName, string[]>();
  for (const p of plugins) {
    if (!enabledIds.has(p.manifest.id)) continue;
    for (const cap of capabilityList(p.manifest.provides)) {
      const arr = providers.get(cap) ?? [];
      arr.push(p.manifest.id);
      providers.set(cap, arr);
    }
  }

  // For each enabled plugin, compute the set of plugin-ids it depends
  // on (every provider of every required capability). Self-loops are
  // dropped — a plugin can both provide and require the same capability
  // (e.g. self-tests); we don't treat that as a cycle.
  const deps = new Map<string, Set<string>>();
  for (const p of plugins) {
    if (!enabledIds.has(p.manifest.id)) continue;
    const set = new Set<string>();
    for (const cap of capabilityList(p.manifest.requires)) {
      const provs = providers.get(cap) ?? [];
      for (const provId of provs) {
        if (provId !== p.manifest.id) set.add(provId);
      }
    }
    deps.set(p.manifest.id, set);
  }

  const order: string[] = [];
  const remaining = new Map(deps);
  const ids = [...remaining.keys()].sort();

  while (remaining.size > 0) {
    // Pick all plugins with zero remaining deps; sort for determinism.
    const ready = ids.filter((id) => remaining.has(id) && remaining.get(id)!.size === 0);
    if (ready.length === 0) break; // cycle
    for (const id of ready) {
      order.push(id);
      remaining.delete(id);
      for (const [other, set] of remaining) {
        if (set.delete(id) && set.size === 0) {
          // Will be picked next iteration.
        }
        void other;
      }
    }
  }

  // Anything left is in a cycle.
  const cycle = [...remaining.keys()].sort();
  for (const id of cycle) order.push(id);
  return { order, cycle };
}

/**
 * After a plugin's `activate()` returns successfully, map its
 * `provides[]` declarations to the actual values it exposes
 * (sandbox runners, optional browser sidecar) and register them.
 *
 * Returns `{ ok: true }` if every declared capability was backed,
 * or `{ ok: false, reason }` if a backing was missing.
 *
 * Side effects: mutates `entry.capabilityInfo.provided` and the
 * passed-in `byCapability` map.
 */
function registerProvidedCapabilities(
  entry: ActivePluginEntry,
  byCapability: Map<CapabilityName, ProvidedCapability>,
): { ok: true } | { ok: false; reason: string } {
  const declared = capabilityList(entry.manifest.provides);
  if (declared.length === 0) return { ok: true };

  const sandboxes = entry.manifest.contributes?.sandboxes ?? [];
  const sandboxModules = entry.exports?.sandboxes ?? {};

  // Lazily start the first matching sandbox runner per kind.
  // We only need one runner per provided sandbox.<kind> capability.
  // The sandbox module's start() returned the runner object eagerly
  // inside activate() — we expect plugins to surface ready runners
  // via exports.sandboxes after their start logic runs in activate.
  // Convention: exports.sandboxes is keyed by manifest.module string.

  for (const cap of declared) {
    if (cap.startsWith("sandbox.")) {
      const kind = cap.slice("sandbox.".length);
      const matching = sandboxes.find((s) => s.kind === kind);
      if (!matching) {
        return {
          ok: false,
          reason: `provides[\"${cap}\"] declared without a backing sandboxes[] entry of kind=${kind}`,
        };
      }
      const runner = sandboxModules[matching.module] as unknown;
      if (!runner || typeof runner !== "object") {
        return {
          ok: false,
          reason: `sandboxes["${matching.module}"] missing or not an object in plugin ${entry.manifest.id}`,
        };
      }
      byCapability.set(cap, {
        capability: cap,
        pluginId: entry.manifest.id,
        exclusive: KNOWN_CAPABILITIES[cap].exclusive,
        value: runner,
      });
      entry.capabilityInfo.provided.push(cap);
      continue;
    }

    if (cap === "browser.cdp") {
      // browser.cdp piggybacks on a sandbox runner with a populated
      // `.browser` field. Find the first runner that exposes one.
      let sidecar: unknown;
      for (const s of sandboxes) {
        const runner = sandboxModules[s.module] as
          | { browser?: SandboxRunner["browser"] }
          | undefined;
        if (runner && runner.browser) {
          sidecar = runner.browser;
          break;
        }
      }
      if (!sidecar) {
        return {
          ok: false,
          reason: `provides[\"browser.cdp\"] declared but no sandbox runner exposes a .browser sidecar`,
        };
      }
      byCapability.set(cap, {
        capability: cap,
        pluginId: entry.manifest.id,
        exclusive: KNOWN_CAPABILITIES[cap].exclusive,
        value: sidecar,
      });
      entry.capabilityInfo.provided.push(cap);
      continue;
    }

    return {
      ok: false,
      reason: `unknown capability "${cap}" in provides[] (KNOWN_CAPABILITIES is the single source of truth)`,
    };
  }

  return { ok: true };
}
