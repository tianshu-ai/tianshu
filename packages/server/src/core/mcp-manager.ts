// McpManager — host-owned registry of MCP servers configured by the
// user (tenant config `mcp.servers[]`). Plugin-contributed MCP
// toolsets (manifest `contributes.toolsets[]`) land here too at
// query time, so any caller asking "what MCP servers does this
// tenant see?" gets a single unified answer regardless of source.
//
// Conceptually this is two stores joined on the fly:
//
//   1. `userToolsets`: this Map. McpToolset instances we own,
//      one per `mcp.servers[]` entry the user wrote. Refreshed
//      on tenant config change. We construct, hold, refresh.
//
//   2. `pluginToolsets`: looked up via PluginRegistry on demand.
//      Plugins own these instances; we only read them.
//
// Why bother? Two reasons —
//   - Agent tool surface: toolsForTenant() needs to merge both
//     sources into the model's per-turn tool list.
//   - Admin /admin/mcp: needs to list both sources with `source:
//     "user" | "plugin"` so the user can tell which ones are theirs
//     to edit/delete.
//
// Lifecycle:
//   - First call to ensureForTenant() loads tenant config and builds
//     toolsets (one McpToolset per enabled server entry).
//   - reload() rebuilds the user toolsets from the on-disk config.
//     Called by the routes after PATCH/POST/DELETE.
//   - shutdown() drops everything (no running connections to close
//     since each McpToolset opens a short-lived SDK Client per call).
//
// We do NOT live-watch the config file. The user goes through our
// API which calls reload(); hand-editing config.json + restart is
// also fine.

import {
  McpToolset,
  type ToolsetProvider,
} from "@tianshu-ai/plugin-sdk";
import { loadTenantConfig, type McpServerEntry } from "./config.js";
import { getTianshuHome } from "./paths.js";
import type { Database } from "better-sqlite3";

/** A tenant's user-configured toolsets keyed by server id. */
type TenantState = {
  /** Tenant id (denormalised so callers don't need a back-pointer). */
  tenantId: string;
  /** id → McpToolset, only for entries with `enabled !== false`. */
  toolsets: Map<string, McpToolset>;
  /** Snapshot of the entries we used to build `toolsets`, for
   *  diagnostics and the admin view. */
  entries: Map<string, McpServerEntry>;
};

export interface McpUserToolsetSnapshot {
  /** Server id from the tenant config entry. */
  id: string;
  /** Display name (defaults to id). */
  displayName: string;
  /** True when this id was present + enabled in tenant config and
   *  thus exists in the toolsets map. False when present-but-disabled. */
  enabled: boolean;
  /** McpToolset.snapshot() when enabled; null otherwise. */
  toolsetSnapshot: ReturnType<McpToolset["snapshot"]> | null;
  /** ToolsetProvider handle (only when enabled). Used by the
   *  registry to merge into agent tools. */
  provider: ToolsetProvider | null;
  /** Verbatim entry from tenant config, for the admin UI to render
   *  in edit dialogs. */
  entry: McpServerEntry;
}

/**
 * Per-host singleton. The PluginRegistry holds one too \u2014 we kept
 * the surface narrow on purpose so the registry can compose us
 * without becoming this class's friend.
 */
/** Cache key for per-user toolsets: "tenantId::userId" */
type UserKey = string;
function userKey(tenantId: string, userId: string): UserKey {
  return `${tenantId}::${userId}`;
}

export class McpManager {
  private state: Map<string, TenantState> = new Map();
  /** Per-user MCP toolsets, lazily built from the DB table. */
  private userState: Map<UserKey, Map<string, McpToolset>> = new Map();

  constructor(private readonly home: string = getTianshuHome()) {}

  /** Build (or rebuild) the toolset map for one tenant from disk. */
  reload(tenantId: string): void {
    const cfg = loadTenantConfig(tenantId, this.home);
    const entries = (cfg.mcp?.servers ?? []).filter(isValidEntry);
    const next: TenantState = {
      tenantId,
      toolsets: new Map(),
      entries: new Map(),
    };
    for (const e of entries) {
      next.entries.set(e.id, e);
      if (e.enabled === false) continue;
      next.toolsets.set(e.id, this.makeToolset(e));
    }
    this.state.set(tenantId, next);
    // Best-effort initial refresh so first call to listTools() has
    // something. Failures don't fault the manager; the toolset
    // self-records lastError.
    for (const ts of next.toolsets.values()) {
      void ts.refresh();
    }
  }

  /** First-call lazy init. Idempotent. */
  ensureForTenant(tenantId: string): void {
    if (this.state.has(tenantId)) return;
    this.reload(tenantId);
  }

  /** Snapshot of every user-configured server (enabled or not).
   *  Plugin-contributed servers are NOT included \u2014 callers merge
   *  with PluginRegistry.toolsetsForTenant() to get the unified
   *  view. */
  snapshotsForTenant(tenantId: string): McpUserToolsetSnapshot[] {
    this.ensureForTenant(tenantId);
    const st = this.state.get(tenantId)!;
    const out: McpUserToolsetSnapshot[] = [];
    for (const [id, entry] of st.entries) {
      const ts = st.toolsets.get(id);
      out.push({
        id,
        displayName: entry.displayName ?? id,
        enabled: entry.enabled !== false,
        toolsetSnapshot: ts ? ts.snapshot() : null,
        provider: ts ?? null,
        entry,
      });
    }
    return out;
  }

  /** Just the live ToolsetProviders. Used by PluginRegistry's
   *  toolsForTenant() to add user MCP tools to the agent surface. */
  providersForTenant(tenantId: string): ToolsetProvider[] {
    this.ensureForTenant(tenantId);
    const st = this.state.get(tenantId)!;
    return [...st.toolsets.values()];
  }

  /** Drop tenant state on tenant DB pool eviction. */
  invalidate(tenantId: string): void {
    this.state.delete(tenantId);
    // Also drop all user-level caches for this tenant.
    for (const k of this.userState.keys()) {
      if (k.startsWith(`${tenantId}::`)) this.userState.delete(k);
    }
  }

  // ─── user-level MCP servers ────────────────────────────────────

  /**
   * Load user-level MCP servers from the DB and return their
   * ToolsetProviders. Lazily cached per (tenant, user); call
   * `reloadUser()` after mutations.
   */
  providersForUser(
    tenantId: string,
    userId: string,
    db: Database,
  ): ToolsetProvider[] {
    const k = userKey(tenantId, userId);
    if (!this.userState.has(k)) {
      this.reloadUser(tenantId, userId, db);
    }
    return [...(this.userState.get(k)?.values() ?? [])];
  }

  /** Rebuild user-level toolsets from DB. */
  reloadUser(tenantId: string, userId: string, db: Database): void {
    const k = userKey(tenantId, userId);
    const rows = db
      .prepare(
        `SELECT id, config FROM user_mcp_servers
         WHERE tenant_id = ? AND user_id = ?`,
      )
      .all(tenantId, userId) as { id: string; config: string }[];
    const toolsets = new Map<string, McpToolset>();
    for (const row of rows) {
      let entry: McpServerEntry;
      try {
        entry = JSON.parse(row.config);
      } catch {
        continue;
      }
      if (!entry.url || entry.enabled === false) continue;
      entry.id = row.id; // ensure id matches the PK
      toolsets.set(row.id, this.makeToolset(entry));
    }
    this.userState.set(k, toolsets);
    for (const ts of toolsets.values()) {
      void ts.refresh();
    }
  }

  /** Invalidate one user's cache (after CRUD). */
  invalidateUser(tenantId: string, userId: string): void {
    this.userState.delete(userKey(tenantId, userId));
  }

  // ─── user-level CRUD helpers (DB operations) ──────────────────

  static listUserServers(
    db: Database,
    tenantId: string,
    userId: string,
  ): { id: string; config: McpServerEntry; createdAt: string; updatedAt: string }[] {
    const rows = db
      .prepare(
        `SELECT id, config, created_at, updated_at FROM user_mcp_servers
         WHERE tenant_id = ? AND user_id = ?`,
      )
      .all(tenantId, userId) as {
      id: string;
      config: string;
      created_at: string;
      updated_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      config: JSON.parse(r.config),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  static upsertUserServer(
    db: Database,
    tenantId: string,
    userId: string,
    entry: McpServerEntry,
  ): void {
    db.prepare(
      `INSERT INTO user_mcp_servers (tenant_id, user_id, id, config, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT (tenant_id, user_id, id)
       DO UPDATE SET config = excluded.config, updated_at = datetime('now')`,
    ).run(tenantId, userId, entry.id, JSON.stringify(entry));
  }

  static deleteUserServer(
    db: Database,
    tenantId: string,
    userId: string,
    serverId: string,
  ): boolean {
    const r = db
      .prepare(
        `DELETE FROM user_mcp_servers
         WHERE tenant_id = ? AND user_id = ? AND id = ?`,
      )
      .run(tenantId, userId, serverId);
    return r.changes > 0;
  }

  /** Build an McpToolset from one config entry. Pure factory \u2014 no
   *  side effects beyond instantiating the SDK toolset. */
  private makeToolset(e: McpServerEntry): McpToolset {
    return new McpToolset({
      name: e.displayName ?? e.id,
      prefix: e.prefix ?? `${e.id}_`,
      // User entries are static URLs; if the server is down we want
      // the toolset's lastError to surface, not for refresh() to
      // return undefined and look like a config-not-resolved case.
      resolve: () => e.url,
      upstreamHost: e.upstreamHost,
    });
  }
}

function isValidEntry(e: unknown): e is McpServerEntry {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  return typeof x.id === "string" && typeof x.url === "string";
}
