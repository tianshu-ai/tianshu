// Agent Relay — database schema
//
// Server mode: stores registered agents and their cards
// Client mode: stores relay connection state

import type { TenantDbHandle } from "@tianshu-ai/plugin-sdk";
import { createHash } from "node:crypto";

type Db = TenantDbHandle;

// ── Server-mode tables ──

export function ensureServerSchema(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_agents (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      display_name  TEXT NOT NULL DEFAULT '',
      description   TEXT NOT NULL DEFAULT '',
      card_json     TEXT NOT NULL DEFAULT '{}',
      api_key_hash  TEXT NOT NULL DEFAULT '',
      discoverable  INTEGER NOT NULL DEFAULT 0,
      online        INTEGER NOT NULL DEFAULT 0,
      last_seen_at  INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL DEFAULT 0,
      updated_at    INTEGER NOT NULL DEFAULT 0,
      UNIQUE(org_id, agent_id)
    );
  `);
}

// ── Client-mode tables ──

export function ensureClientSchema(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_connection (
      id            TEXT PRIMARY KEY DEFAULT 'default',
      relay_url     TEXT NOT NULL DEFAULT '',
      org_id        TEXT NOT NULL DEFAULT '',
      agent_id      TEXT NOT NULL DEFAULT '',
      public_url    TEXT NOT NULL DEFAULT '',
      connected     INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT NOT NULL DEFAULT '',
      updated_at    INTEGER NOT NULL DEFAULT 0
    );
  `);
}

// ── Org ID generation ──

export function generateOrgId(machineId: string, hostname: string, tenantId: string): string {
  return createHash("sha256")
    .update(`${machineId}\0${hostname}\0${tenantId}`)
    .digest("hex")
    .slice(0, 16);
}

// ── Server-mode helpers ──

export interface RelayAgent {
  id: string;
  orgId: string;
  agentId: string;
  displayName: string;
  description: string;
  cardJson: string;
  discoverable: boolean;
  online: boolean;
  lastSeenAt: number;
}

export function upsertAgent(
  db: Db,
  opts: { orgId: string; agentId: string; displayName: string; description: string; cardJson: string; apiKeyHash: string; discoverable: boolean },
): RelayAgent {
  const id = `${opts.orgId}/${opts.agentId}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO relay_agents (id, org_id, agent_id, display_name, description, card_json, api_key_hash, discoverable, online, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       display_name = excluded.display_name,
       description = excluded.description,
       card_json = excluded.card_json,
       api_key_hash = CASE WHEN excluded.api_key_hash != '' THEN excluded.api_key_hash ELSE relay_agents.api_key_hash END,
       discoverable = excluded.discoverable,
       online = 1,
       last_seen_at = excluded.last_seen_at,
       updated_at = excluded.updated_at`,
  ).run(id, opts.orgId, opts.agentId, opts.displayName, opts.description, opts.cardJson, opts.apiKeyHash, opts.discoverable ? 1 : 0, now, now, now);

  return {
    id, orgId: opts.orgId, agentId: opts.agentId, displayName: opts.displayName,
    description: opts.description, cardJson: opts.cardJson, discoverable: opts.discoverable,
    online: true, lastSeenAt: now,
  };
}

export function setAgentOffline(db: Db, id: string) {
  db.prepare("UPDATE relay_agents SET online = 0, updated_at = ? WHERE id = ?").run(Date.now(), id);
}

export function setAgentOnline(db: Db, id: string) {
  db.prepare("UPDATE relay_agents SET online = 1, last_seen_at = ?, updated_at = ? WHERE id = ?").run(Date.now(), Date.now(), id);
}

export function listDiscoverableAgents(db: Db): RelayAgent[] {
  const rows = db.prepare(
    "SELECT * FROM relay_agents WHERE discoverable = 1 ORDER BY online DESC, last_seen_at DESC",
  ).all() as Record<string, unknown>[];
  return rows.map(rowToAgent);
}

export function getAgent(db: Db, orgId: string, agentId: string): RelayAgent | null {
  const row = db.prepare(
    "SELECT * FROM relay_agents WHERE org_id = ? AND agent_id = ?",
  ).get(orgId, agentId) as Record<string, unknown> | undefined;
  return row ? rowToAgent(row) : null;
}

function rowToAgent(r: Record<string, unknown>): RelayAgent {
  return {
    id: String(r.id), orgId: String(r.org_id), agentId: String(r.agent_id),
    displayName: String(r.display_name), description: String(r.description),
    cardJson: String(r.card_json), discoverable: r.discoverable === 1,
    online: r.online === 1, lastSeenAt: Number(r.last_seen_at),
  };
}
