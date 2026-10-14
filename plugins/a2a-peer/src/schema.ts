// A2A Peer plugin — data layer.

export interface Db {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

// ── Types ───────────────────────────────────────────────────────

export interface Peer {
  id: string;
  name: string;
  endpointUrl: string;
  agentCard: Record<string, unknown>;
  authToken: string;
  status: "active" | "disabled";
  createdAt: number;
  updatedAt: number;
}

export interface Invite {
  id: string;
  code: string;
  expiresAt: number;
  usedBy: string | null;
  createdAt: number;
}

export interface PeerMessage {
  id: string;
  peerId: string;
  direction: "inbound" | "outbound";
  sender: string;
  text: string;
  createdAt: number;
}

// ── Schema ──────────────────────────────────────────────────────

export function ensureSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS a2a_peers (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      endpoint_url  TEXT NOT NULL,
      agent_card    TEXT NOT NULL DEFAULT '{}',
      auth_token    TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS a2a_invites (
      id          TEXT PRIMARY KEY,
      code        TEXT NOT NULL UNIQUE,
      expires_at  INTEGER NOT NULL,
      used_by     TEXT,
      created_at  INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS a2a_peer_messages (
      id          TEXT PRIMARY KEY,
      peer_id     TEXT NOT NULL,
      direction   TEXT NOT NULL,
      sender      TEXT NOT NULL,
      text        TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    )
  `);
}

// ── Helpers ─────────────────────────────────────────────────────

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function genCode(): string {
  // 6-char alphanumeric
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── Peers CRUD ──────────────────────────────────────────────────

function rowToPeer(r: Record<string, unknown>): Peer {
  let card: Record<string, unknown> = {};
  try { card = JSON.parse(String(r.agent_card || "{}")); } catch { /* */ }
  return {
    id: String(r.id),
    name: String(r.name),
    endpointUrl: String(r.endpoint_url),
    agentCard: card,
    authToken: String(r.auth_token),
    status: String(r.status) as "active" | "disabled",
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export function listPeers(db: Db): Peer[] {
  const rows = db.prepare("SELECT * FROM a2a_peers ORDER BY name ASC").all() as Record<string, unknown>[];
  return rows.map(rowToPeer);
}

export function getPeer(db: Db, id: string): Peer | undefined {
  const r = db.prepare("SELECT * FROM a2a_peers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? rowToPeer(r) : undefined;
}

export function getPeerByToken(db: Db, token: string): Peer | undefined {
  const r = db.prepare("SELECT * FROM a2a_peers WHERE auth_token = ? AND status = 'active'").get(token) as Record<string, unknown> | undefined;
  return r ? rowToPeer(r) : undefined;
}

export function createPeer(db: Db, opts: {
  name: string;
  endpointUrl: string;
  agentCard: Record<string, unknown>;
  authToken: string;
}): Peer {
  const id = genId("peer");
  const now = Date.now();
  db.prepare(
    `INSERT INTO a2a_peers (id, name, endpoint_url, agent_card, auth_token, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, opts.name, opts.endpointUrl, JSON.stringify(opts.agentCard), opts.authToken, now, now);
  return { id, name: opts.name, endpointUrl: opts.endpointUrl, agentCard: opts.agentCard, authToken: opts.authToken, status: "active", createdAt: now, updatedAt: now };
}

export function updatePeer(db: Db, id: string, updates: Partial<Pick<Peer, "name" | "status" | "agentCard" | "endpointUrl">>): boolean {
  const fields: string[] = [];
  const values: unknown[] = [];
  const set = (col: string, v: unknown) => { fields.push(`${col} = ?`); values.push(v); };
  if (updates.name !== undefined) set("name", updates.name);
  if (updates.status !== undefined) set("status", updates.status);
  if (updates.agentCard !== undefined) set("agent_card", JSON.stringify(updates.agentCard));
  if (updates.endpointUrl !== undefined) set("endpoint_url", updates.endpointUrl);
  if (fields.length === 0) return false;
  set("updated_at", Date.now());
  values.push(id);
  const res = db.prepare(`UPDATE a2a_peers SET ${fields.join(", ")} WHERE id = ?`).run(...values) as { changes: number };
  return res.changes > 0;
}

export function deletePeer(db: Db, id: string): boolean {
  const res = db.prepare("DELETE FROM a2a_peers WHERE id = ?").run(id) as { changes: number };
  db.prepare("DELETE FROM a2a_peer_messages WHERE peer_id = ?").run(id);
  return res.changes > 0;
}

// ── Invites ─────────────────────────────────────────────────────

export function createInvite(db: Db, ttlMs = 10 * 60 * 1000): Invite {
  const id = genId("inv");
  const code = genCode();
  const now = Date.now();
  const expiresAt = now + ttlMs;
  db.prepare(
    `INSERT INTO a2a_invites (id, code, expires_at, used_by, created_at) VALUES (?, ?, ?, NULL, ?)`,
  ).run(id, code, expiresAt, now);
  return { id, code, expiresAt, usedBy: null, createdAt: now };
}

export function getInviteByCode(db: Db, code: string): Invite | undefined {
  const r = db.prepare("SELECT * FROM a2a_invites WHERE code = ?").get(code.toUpperCase()) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  return {
    id: String(r.id),
    code: String(r.code),
    expiresAt: Number(r.expires_at),
    usedBy: r.used_by ? String(r.used_by) : null,
    createdAt: Number(r.created_at),
  };
}

export function markInviteUsed(db: Db, id: string, peerId: string): void {
  db.prepare("UPDATE a2a_invites SET used_by = ? WHERE id = ?").run(peerId, id);
}

// ── Messages ────────────────────────────────────────────────────

export function logPeerMessage(db: Db, opts: {
  peerId: string;
  direction: "inbound" | "outbound";
  sender: string;
  text: string;
}): PeerMessage {
  const id = genId("pm");
  const now = Date.now();
  db.prepare(
    `INSERT INTO a2a_peer_messages (id, peer_id, direction, sender, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, opts.peerId, opts.direction, opts.sender, opts.text, now);
  return { id, peerId: opts.peerId, direction: opts.direction, sender: opts.sender, text: opts.text, createdAt: now };
}

export function listPeerMessages(db: Db, peerId: string, limit = 50): PeerMessage[] {
  const rows = db.prepare(
    "SELECT * FROM a2a_peer_messages WHERE peer_id = ? ORDER BY created_at DESC LIMIT ?",
  ).all(peerId, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    peerId: String(r.peer_id),
    direction: String(r.direction) as "inbound" | "outbound",
    sender: String(r.sender),
    text: String(r.text),
    createdAt: Number(r.created_at),
  }));
}
