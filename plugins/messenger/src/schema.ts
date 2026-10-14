// Messenger plugin — data layer.
//
// `messenger_contacts` stores configured outbound targets. Each
// contact has a type ("wechat" | "ws") and a JSON config blob
// with type-specific connection parameters.

export interface Db {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

export type ContactType = "wechat" | "ws" | "tianshu";

export interface Contact {
  id: string;
  name: string;
  type: ContactType;
  config: Record<string, unknown>;
  waitReply: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  contactId: string;
  text: string;
  status: "sent" | "failed";
  error?: string;
  createdAt: number;
}

export interface TianshuContactConfig {
  endpointUrl: string;
  authToken: string;      // token WE use to send TO them
  inboundToken: string;   // token THEY use to send TO us
  agentCard?: Record<string, unknown>;
}

export interface Invite {
  id: string;
  code: string;
  expiresAt: number;
  usedBy: string | null;
  createdAt: number;
}

export function ensureSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messenger_invites (
      id          TEXT PRIMARY KEY,
      code        TEXT NOT NULL UNIQUE,
      expires_at  INTEGER NOT NULL,
      used_by     TEXT,
      created_at  INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messenger_messages (
      id          TEXT PRIMARY KEY,
      contact_id  TEXT NOT NULL,
      text        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'sent',
      error       TEXT,
      created_at  INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messenger_contacts (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'ws',
      config      TEXT NOT NULL DEFAULT '{}',
      wait_reply  INTEGER NOT NULL DEFAULT 0,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);
}

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

export function listContacts(db: Db): Contact[] {
  const rows = db
    .prepare("SELECT * FROM messenger_contacts ORDER BY name ASC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToContact);
}

export function getContact(db: Db, id: string): Contact | undefined {
  const r = db
    .prepare("SELECT * FROM messenger_contacts WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return r ? rowToContact(r) : undefined;
}

export function getContactByName(db: Db, name: string): Contact | undefined {
  const r = db
    .prepare("SELECT * FROM messenger_contacts WHERE name = ? COLLATE NOCASE")
    .get(name) as Record<string, unknown> | undefined;
  return r ? rowToContact(r) : undefined;
}

export function createContact(
  db: Db,
  opts: { name: string; type: ContactType; config?: Record<string, unknown>; waitReply?: boolean },
): Contact {
  const id = `mc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO messenger_contacts (id, name, type, config, wait_reply, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, opts.name, opts.type, JSON.stringify(opts.config ?? {}), opts.waitReply ? 1 : 0, now, now);
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
  // Also clean up message history
  db.prepare("DELETE FROM messenger_messages WHERE contact_id = ?").run(id);
  return res.changes > 0;
}

// ── Message history ─────────────────────────────────────────────

export function logMessage(
  db: Db,
  opts: { contactId: string; text: string; status: "sent" | "failed"; error?: string },
): Message {
  const id = `mm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO messenger_messages (id, contact_id, text, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, opts.contactId, opts.text, opts.status, opts.error ?? null, now);
  return { id, contactId: opts.contactId, text: opts.text, status: opts.status, error: opts.error, createdAt: now };
}

export function listMessages(db: Db, contactId: string, limit = 50): Message[] {
  const rows = db
    .prepare("SELECT * FROM messenger_messages WHERE contact_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(contactId, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    contactId: String(r.contact_id),
    text: String(r.text),
    status: String(r.status) as "sent" | "failed",
    error: r.error ? String(r.error) : undefined,
    createdAt: Number(r.created_at),
  }));
}

// ── Invites (for tianshu peering) ───────────────────────────────

function genCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export function genToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let t = "";
  for (let i = 0; i < 48; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

export function createInvite(db: Db, ttlMs = 10 * 60 * 1000): Invite {
  const id = `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const code = genCode();
  const now = Date.now();
  db.prepare(
    `INSERT INTO messenger_invites (id, code, expires_at, used_by, created_at) VALUES (?, ?, ?, NULL, ?)`,
  ).run(id, code, now + ttlMs, now);
  return { id, code, expiresAt: now + ttlMs, usedBy: null, createdAt: now };
}

export function getInviteByCode(db: Db, code: string): Invite | undefined {
  const r = db.prepare("SELECT * FROM messenger_invites WHERE code = ?").get(code.toUpperCase()) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  return { id: String(r.id), code: String(r.code), expiresAt: Number(r.expires_at), usedBy: r.used_by ? String(r.used_by) : null, createdAt: Number(r.created_at) };
}

export function markInviteUsed(db: Db, id: string, contactId: string): void {
  db.prepare("UPDATE messenger_invites SET used_by = ? WHERE id = ?").run(contactId, id);
}
