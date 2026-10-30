// Messenger plugin — data layer.
//
// All data is scoped per-user (user_id), not per-tenant.

export interface Db {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

export type ContactType = "wechat" | "ws" | "a2a";

export interface Contact {
  id: string;
  name: string;
  type: ContactType;
  config: Record<string, unknown>;
  waitReply: boolean;
  enabled: boolean;
  ready?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  contactId: string;
  direction: "outbound" | "inbound";
  text: string;
  status: "sent" | "failed" | "received";
  error?: string;
  createdAt: number;
}

export interface A2aContactConfig {
  endpoint: string;
  apiKey: string;
  agentCard?: Record<string, unknown>;
}

export interface AgentCard {
  name: string;
  description: string;
  /** Provider org name, e.g. "tianshu-ai" */
  provider?: string;
  /** Provider URL */
  providerUrl?: string;
  /** Agent version */
  version?: string;
  /** Default input modes (text, file, etc.) */
  defaultInputModes?: string[];
  /** Default output modes */
  defaultOutputModes?: string[];
  /** Skills: what this agent can do */
  skills?: Array<{
    id: string;
    name: string;
    description: string;
    tags?: string[];
    examples?: string[];
  }>;
  /** Whether this agent is discoverable via Agent Bluetooth */
  discoverable?: boolean;
  /** UserId who toggled discoverable — persisted for relay pair requests */
  discoverableUserId?: string;
}

const DEFAULT_AGENT_CARD: AgentCard = { name: "", description: "" };

// ── Schema ──────────────────────────────────────────────────────

export function ensureSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messenger_contacts (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL DEFAULT '',
      name        TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'ws',
      config      TEXT NOT NULL DEFAULT '{}',
      wait_reply  INTEGER NOT NULL DEFAULT 0,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messenger_messages (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL DEFAULT '',
      contact_id  TEXT NOT NULL,
      direction   TEXT NOT NULL DEFAULT 'outbound',
      text        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'sent',
      error       TEXT,
      created_at  INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messenger_agent_card (
      id          TEXT PRIMARY KEY DEFAULT 'default',
      user_id     TEXT NOT NULL DEFAULT '',
      data        TEXT NOT NULL DEFAULT '{}',
      updated_at  INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messenger_a2a_keys (
      key         TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL DEFAULT '',
      label       TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL
    )
  `);

  // Migrations for existing installs: add user_id if missing
  const migrate = (table: string) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }
  };
  migrate("messenger_contacts");
  migrate("messenger_messages");
  migrate("messenger_agent_card");
  migrate("messenger_a2a_keys");

  db.exec(`
    CREATE TABLE IF NOT EXISTS messenger_comm_tokens (
      token_hash  TEXT PRIMARY KEY,
      contact_id  TEXT NOT NULL,
      user_id     TEXT NOT NULL DEFAULT ''
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messenger_pairing_tokens (
      token_hash  TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messenger_pair_requests (
      id          TEXT PRIMARY KEY,
      direction   TEXT NOT NULL,       -- 'inbound' or 'outbound'
      status      TEXT NOT NULL DEFAULT 'pending',  -- pending / accepted / rejected
      peer_org_id TEXT NOT NULL,
      peer_agent_id TEXT NOT NULL DEFAULT '',
      peer_name   TEXT NOT NULL DEFAULT '',
      peer_card   TEXT NOT NULL DEFAULT '{}',
      peer_endpoint TEXT NOT NULL DEFAULT '',
      user_id     TEXT NOT NULL DEFAULT '',
      contact_id  TEXT,                -- set after accepted
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )
  `);

  // Migration: add direction column if missing (existing installs)
  try { db.exec(`ALTER TABLE messenger_messages ADD COLUMN direction TEXT NOT NULL DEFAULT 'outbound'`); } catch { /* */ }
  // Migration: add peer_user_id column to pair requests
  try { db.exec(`ALTER TABLE messenger_pair_requests ADD COLUMN peer_user_id TEXT NOT NULL DEFAULT ''`); } catch { /* */ }
  // Migration: add relay_request_id for business-level dedup (id is now always locally generated)
  try { db.exec(`ALTER TABLE messenger_pair_requests ADD COLUMN relay_request_id TEXT NOT NULL DEFAULT ''`); } catch { /* */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_pair_relay_req ON messenger_pair_requests (relay_request_id, direction)`); } catch { /* */ }
}

// ── Pairing token consumption ───────────────────────────────────

import { createHash } from "node:crypto";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

export function storePairingToken(db: Db, token: string, userId: string): void {
  const h = hashToken(token);
  db.prepare("INSERT OR REPLACE INTO messenger_pairing_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)")
    .run(h, userId, Date.now());
}

export function consumePairingToken(db: Db, token: string): void {
  const h = hashToken(token);
  // Mark consumed instead of deleting, so we can distinguish from unknown tokens
  db.prepare("UPDATE messenger_pairing_tokens SET created_at = -1 WHERE token_hash = ?").run(h);
}

/** Check if a scoped token should be allowed.
 *  - Not in pairing table at all → allowed (ongoing communication token)
 *  - In table, not consumed (created_at > 0) → allowed (valid pairing token)
 *  - In table, consumed (created_at = -1) → blocked */
export function isScopedTokenAllowed(db: Db, token: string): boolean {
  const h = hashToken(token);
  const row = db.prepare("SELECT created_at FROM messenger_pairing_tokens WHERE token_hash = ?").get(h) as { created_at: number } | undefined;
  if (!row) return true; // not a pairing token — ongoing communication token, allow
  return row.created_at !== -1; // -1 means consumed
}

// ── Contacts ────────────────────────────────────────────────────

function rowToContact(r: Record<string, unknown>): Contact {
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(String(r.config || "{}")); } catch { /* */ }
  return {
    id: String(r.id),
    name: String(r.name),
    type: r.type as ContactType,
    config,
    waitReply: !!r.wait_reply,
    enabled: !!r.enabled,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export function listContacts(db: Db, userId: string = ""): Contact[] {
  return (db.prepare("SELECT * FROM messenger_contacts WHERE user_id = ? ORDER BY name ASC").all(userId) as Record<string, unknown>[]).map(rowToContact);
}

export function getContact(db: Db, id: string): Contact | undefined {
  const r = db.prepare("SELECT * FROM messenger_contacts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? rowToContact(r) : undefined;
}

export function getContactByName(db: Db, name: string, userId: string = ""): Contact | undefined {
  const r = db.prepare("SELECT * FROM messenger_contacts WHERE name = ? COLLATE NOCASE AND user_id = ?").get(name, userId) as Record<string, unknown> | undefined;
  return r ? rowToContact(r) : undefined;
}

/** Find existing wechat contact by iLink user ID */
export function findContactByIlinkUserId(db: Db, userId: string, ilinkUserId: string): Contact | undefined {
  const rows = db.prepare("SELECT * FROM messenger_contacts WHERE user_id = ? AND type = 'wechat'").all(userId) as any[];
  for (const r of rows) {
    try {
      const cfg = JSON.parse(r.config || '{}');
      if (cfg.ilinkUserId === ilinkUserId) return rowToContact(r);
    } catch {}
  }
  return undefined;
}

/** Find existing a2a contact by endpoint */
export function findContactByEndpoint(db: Db, userId: string, endpoint: string): Contact | undefined {
  const rows = db.prepare("SELECT * FROM messenger_contacts WHERE user_id = ? AND type = 'a2a'").all(userId) as any[];
  for (const r of rows) {
    try {
      const cfg = JSON.parse(r.config || '{}');
      if (cfg.endpoint === endpoint) return rowToContact(r);
    } catch {}
  }
  return undefined;
}

export function createContact(
  db: Db,
  opts: { userId?: string; name: string; type: ContactType; config?: Record<string, unknown>; waitReply?: boolean },
): Contact {
  const id = `mc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  const userId = opts.userId ?? "";
  db.prepare(
    `INSERT INTO messenger_contacts (id, user_id, name, type, config, wait_reply, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, userId, opts.name, opts.type, JSON.stringify(opts.config ?? {}), opts.waitReply ? 1 : 0, now, now);
  return { id, name: opts.name, type: opts.type, config: opts.config ?? {}, waitReply: !!opts.waitReply, enabled: true, createdAt: now, updatedAt: now };
}

export function updateContact(
  db: Db,
  id: string,
  updates: Partial<Pick<Contact, "name" | "type" | "config" | "waitReply" | "enabled">>,
): boolean {
  const fields: string[] = [];
  const values: unknown[] = [];
  const set = (col: string, v: unknown) => { fields.push(`${col} = ?`); values.push(v); };
  if (updates.name !== undefined) set("name", updates.name);
  if (updates.type !== undefined) set("type", updates.type);
  if (updates.config !== undefined) set("config", JSON.stringify(updates.config));
  if (updates.waitReply !== undefined) set("wait_reply", updates.waitReply ? 1 : 0);
  if (updates.enabled !== undefined) set("enabled", updates.enabled ? 1 : 0);
  if (fields.length === 0) return false;
  set("updated_at", Date.now());
  values.push(id);
  const res = db.prepare(`UPDATE messenger_contacts SET ${fields.join(", ")} WHERE id = ?`).run(...values) as { changes: number };
  return res.changes > 0;
}

export function deleteContact(db: Db, id: string): boolean {
  const res = db.prepare("DELETE FROM messenger_contacts WHERE id = ?").run(id) as { changes: number };
  db.prepare("DELETE FROM messenger_messages WHERE contact_id = ?").run(id);
  return res.changes > 0;
}

// ── Message history ─────────────────────────────────────────────

export function logMessage(
  db: Db,
  opts: { userId?: string; contactId: string; direction?: "outbound" | "inbound"; text: string; status: "sent" | "failed" | "received"; error?: string; afterTs?: number },
): Message {
  const id = `mm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = opts.afterTs ? Math.max(Date.now(), opts.afterTs + 1) : Date.now();
  const dir = opts.direction ?? "outbound";
  db.prepare(
    `INSERT INTO messenger_messages (id, user_id, contact_id, direction, text, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, opts.userId ?? "", opts.contactId, dir, opts.text, opts.status, opts.error ?? null, now);
  return { id, contactId: opts.contactId, direction: dir, text: opts.text, status: opts.status, error: opts.error, createdAt: now };
}

export function listMessages(db: Db, contactId: string, limit = 50): Message[] {
  const rows = db
    .prepare("SELECT * FROM messenger_messages WHERE contact_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(contactId, limit) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

export function listMessagesWithCursor(
  db: Db,
  contactId: string,
  opts: { limit?: number; before?: number; search?: string },
): { messages: Message[]; hasMore: boolean; total: number } {
  const limit = Math.min(opts.limit ?? 50, 200);
  const search = opts.search?.trim();
  const before = opts.before ?? Infinity;

  let rows: Record<string, unknown>[];
  if (search) {
    const like = `%${search}%`;
    if (before < Infinity) {
      rows = db
        .prepare("SELECT * FROM messenger_messages WHERE contact_id = ? AND text LIKE ? AND created_at < ? ORDER BY created_at DESC LIMIT ?")
        .all(contactId, like, before, limit + 1) as Record<string, unknown>[];
    } else {
      rows = db
        .prepare("SELECT * FROM messenger_messages WHERE contact_id = ? AND text LIKE ? ORDER BY created_at DESC LIMIT ?")
        .all(contactId, like, limit + 1) as Record<string, unknown>[];
    }
  } else {
    if (before < Infinity) {
      rows = db
        .prepare("SELECT * FROM messenger_messages WHERE contact_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?")
        .all(contactId, before, limit + 1) as Record<string, unknown>[];
    } else {
      rows = db
        .prepare("SELECT * FROM messenger_messages WHERE contact_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(contactId, limit + 1) as Record<string, unknown>[];
    }
  }

  const hasMore = rows.length > limit;
  if (hasMore) rows = rows.slice(0, limit);

  const totalRow = search
    ? (db.prepare("SELECT count(*) as c FROM messenger_messages WHERE contact_id = ? AND text LIKE ?").get(contactId, `%${search}%`) as { c: number })
    : (db.prepare("SELECT count(*) as c FROM messenger_messages WHERE contact_id = ?").get(contactId) as { c: number });

  return {
    messages: rows.map(rowToMessage),
    hasMore,
    total: totalRow.c,
  };
}

function rowToMessage(r: Record<string, unknown>): Message {
  return {
    id: String(r.id),
    contactId: String(r.contact_id),
    text: String(r.text),
    direction: (String(r.direction || "outbound")) as "outbound" | "inbound",
    status: String(r.status) as "sent" | "failed" | "received",
    error: r.error ? String(r.error) : undefined,
    createdAt: Number(r.created_at),
  };
}

// ── Agent Card ──────────────────────────────────────────────────

/** List all user IDs that have a non-empty agent card (excludes the global userId="" row) */
export function listAgentCardUserIds(db: Db): string[] {
  const rows = db.prepare(
    "SELECT DISTINCT user_id FROM messenger_agent_card WHERE user_id != '' ORDER BY updated_at DESC"
  ).all() as { user_id: string }[];
  return rows.map(r => r.user_id);
}

export function getAgentCard(db: Db, userId: string = ""): AgentCard {
  const row = db.prepare("SELECT data FROM messenger_agent_card WHERE user_id = ? ORDER BY rowid DESC LIMIT 1").get(userId) as { data: string } | undefined;
  if (!row) return { ...DEFAULT_AGENT_CARD };
  try { return { ...DEFAULT_AGENT_CARD, ...JSON.parse(row.data) }; } catch { return { ...DEFAULT_AGENT_CARD }; }
}

export function setAgentCard(db: Db, userId: string, card: Partial<AgentCard>): AgentCard {
  const existing = getAgentCard(db, userId);
  const merged: AgentCard = {
    name: card.name ?? existing.name,
    description: card.description ?? existing.description,
    provider: card.provider ?? existing.provider,
    providerUrl: card.providerUrl ?? existing.providerUrl,
    version: card.version ?? existing.version,
    defaultInputModes: card.defaultInputModes ?? existing.defaultInputModes,
    defaultOutputModes: card.defaultOutputModes ?? existing.defaultOutputModes,
    skills: card.skills ?? existing.skills,
    discoverable: card.discoverable ?? existing.discoverable,
    discoverableUserId: card.discoverableUserId ?? existing.discoverableUserId,
  };
  db.prepare(
    `INSERT INTO messenger_agent_card (id, user_id, data, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).run(`card_${userId}`, userId, JSON.stringify(merged), Date.now());
  return merged;
}

// ── A2A inbound keys ────────────────────────────────────────────

export function genApiKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let t = "";
  for (let i = 0; i < 48; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

export function createA2aKey(db: Db, userId: string, label = ""): string {
  const key = genApiKey();
  db.prepare("INSERT INTO messenger_a2a_keys (key, user_id, label, created_at) VALUES (?, ?, ?, ?)")
    .run(key, userId, label, Date.now());
  return key;
}

export function validateA2aKey(db: Db, key: string): { valid: boolean; userId: string } {
  const r = db.prepare("SELECT key, user_id FROM messenger_a2a_keys WHERE key = ?").get(key) as { key: string; user_id: string } | undefined;
  return r ? { valid: true, userId: String(r.user_id) } : { valid: false, userId: "" };
}

export function listA2aKeys(db: Db, userId: string = ""): { key: string; label: string; createdAt: number }[] {
  return (db.prepare("SELECT * FROM messenger_a2a_keys WHERE user_id = ? ORDER BY created_at DESC").all(userId) as Record<string, unknown>[]).map(r => ({
    key: String(r.key), label: String(r.label), createdAt: Number(r.created_at),
  }));
}

export function deleteA2aKey(db: Db, key: string): boolean {
  const res = db.prepare("DELETE FROM messenger_a2a_keys WHERE key = ?").run(key) as { changes: number };
  return res.changes > 0;
}

// ── Communication token → contact mapping ─────────────────────────

export function storeCommToken(db: Db, token: string, contactId: string, userId: string): void {
  const h = hashToken(token);
  db.prepare("INSERT OR REPLACE INTO messenger_comm_tokens (token_hash, contact_id, user_id) VALUES (?, ?, ?)")
    .run(h, contactId, userId);
}

export function lookupCommTokenContact(db: Db, token: string): { contactId: string; userId: string } | null {
  const h = hashToken(token);
  const row = db.prepare("SELECT contact_id, user_id FROM messenger_comm_tokens WHERE token_hash = ?").get(h) as { contact_id: string; user_id: string } | undefined;
  return row ? { contactId: row.contact_id, userId: row.user_id } : null;
}
