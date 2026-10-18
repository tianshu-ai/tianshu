// Migration 021 — per-user MCP server registrations.
//
// Enables user-level MCP server configuration independent of the
// tenant-level `config.mcp.servers[]`. Each user can register their
// own MCP endpoints (e.g. a personal Playwright browser container)
// that are injected into their agent sessions only.
//
// The `config` column stores a JSON McpServerEntry (url, prefix,
// upstreamHost, enabled). The `id` is the server id used in logs
// and tool name prefixes.

import type { Database } from "better-sqlite3";

export const ID = "021-user-mcp-servers";

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_mcp_servers (
      tenant_id TEXT NOT NULL,
      user_id   TEXT NOT NULL,
      id        TEXT NOT NULL,
      config    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, user_id, id)
    );
  `);
}
