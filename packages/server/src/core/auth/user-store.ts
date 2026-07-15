// Local-account user store, backed by a GLOBAL auth.db (better-sqlite3).
//
// Holds:
//   - local password users (scrypt-hashed; no plaintext, ever)
//   - per-tenant roles: a user can be admin in tenant A, member in B.
//
// This is the first persistent user storage in the OSS repo (OAuth
// sessions are stateless). It's GLOBAL, not per-tenant, because a user
// exists before any tenant context — you authenticate, then we resolve
// which tenant(s) you can act in.
//
// Super-admins (config.json auth.superAdmins / auth.admins) are NOT the
// authority here: they override everything at the role-resolution layer
// (see identity.ts). This store answers "what is this user's role in
// tenant X" for NON-super-admins.

import Database, { type Database as DB } from "better-sqlite3";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAuthDbPath } from "../paths.js";

export type TenantRole = "admin" | "member";

export interface LocalUser {
  id: string;
  username: string;
  email: string | null;
  createdAt: number;
}

const SCRYPT_KEYLEN = 64;

/** Hash a password: `scrypt$<saltHex>$<hashHex>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Verify a password against a stored `scrypt$salt$hash` string. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Deterministic-ish local user id. Random 24 hex, prefixed `ul_`. */
function newUserId(): string {
  return `ul_${randomBytes(12).toString("hex")}`;
}

export class UserStore {
  private db: DB;

  constructor(home?: string, dbPathOverride?: string) {
    const dbPath = dbPathOverride ?? getAuthDbPath(home);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        email         TEXT,
        password_hash TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tenant_roles (
        user_id   TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        role      TEXT NOT NULL,
        PRIMARY KEY (user_id, tenant_id)
      );
    `);
  }

  /** Close the underlying handle (tests). */
  close(): void {
    this.db.close();
  }

  // ─── Users ──────────────────────────────────────────────────────

  getByUsername(username: string): (LocalUser & { passwordHash: string }) | null {
    const row = this.db
      .prepare(
        `SELECT id, username, email, password_hash as passwordHash, created_at as createdAt
         FROM users WHERE username = ?`,
      )
      .get(username) as (LocalUser & { passwordHash: string }) | undefined;
    return row ?? null;
  }

  getById(id: string): LocalUser | null {
    const row = this.db
      .prepare(`SELECT id, username, email, created_at as createdAt FROM users WHERE id = ?`)
      .get(id) as LocalUser | undefined;
    return row ?? null;
  }

  list(): LocalUser[] {
    return this.db
      .prepare(`SELECT id, username, email, created_at as createdAt FROM users ORDER BY created_at`)
      .all() as LocalUser[];
  }

  /** Create a local user. Throws on duplicate username. */
  createUser(username: string, password: string, email?: string): LocalUser {
    const id = newUserId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, username, email ?? null, hashPassword(password), now);
    return { id, username, email: email ?? null, createdAt: now };
  }

  setPassword(userId: string, password: string): void {
    this.db
      .prepare(`UPDATE users SET password_hash = ? WHERE id = ?`)
      .run(hashPassword(password), userId);
  }

  deleteUser(userId: string): void {
    const tx = this.db.transaction((uid: string) => {
      this.db.prepare(`DELETE FROM tenant_roles WHERE user_id = ?`).run(uid);
      this.db.prepare(`DELETE FROM users WHERE id = ?`).run(uid);
    });
    tx(userId);
  }

  /** Authenticate a username+password. Returns the user or null. */
  authenticate(username: string, password: string): LocalUser | null {
    const row = this.getByUsername(username);
    if (!row) return null;
    if (!verifyPassword(password, row.passwordHash)) return null;
    return { id: row.id, username: row.username, email: row.email, createdAt: row.createdAt };
  }

  /**
   * Ensure a super-admin local account exists (idempotent boot step).
   * Creates it if missing; updates the password if it drifted from the
   * configured one. Does NOT touch roles — super-admin authority comes
   * from config, not tenant_roles.
   */
  ensureUser(username: string, password: string, email?: string): LocalUser {
    const existing = this.getByUsername(username);
    if (!existing) return this.createUser(username, password, email);
    // Keep the configured password authoritative for bootstrap accounts.
    if (!verifyPassword(password, existing.passwordHash)) {
      this.setPassword(existing.id, password);
    }
    return { id: existing.id, username: existing.username, email: existing.email, createdAt: existing.createdAt };
  }

  // ─── Per-tenant roles ───────────────────────────────────────────

  getRole(userId: string, tenantId: string): TenantRole | null {
    const row = this.db
      .prepare(`SELECT role FROM tenant_roles WHERE user_id = ? AND tenant_id = ?`)
      .get(userId, tenantId) as { role: TenantRole } | undefined;
    return row?.role ?? null;
  }

  setRole(userId: string, tenantId: string, role: TenantRole): void {
    this.db
      .prepare(
        `INSERT INTO tenant_roles (user_id, tenant_id, role) VALUES (?, ?, ?)
         ON CONFLICT(user_id, tenant_id) DO UPDATE SET role = excluded.role`,
      )
      .run(userId, tenantId, role);
  }

  removeRole(userId: string, tenantId: string): void {
    this.db
      .prepare(`DELETE FROM tenant_roles WHERE user_id = ? AND tenant_id = ?`)
      .run(userId, tenantId);
  }

  rolesForUser(userId: string): Array<{ tenantId: string; role: TenantRole }> {
    return this.db
      .prepare(`SELECT tenant_id as tenantId, role FROM tenant_roles WHERE user_id = ?`)
      .all(userId) as Array<{ tenantId: string; role: TenantRole }>;
  }
}

// Process-wide singleton (routes/middleware). Tests build their own.
let defaultStore: UserStore | null = null;
export function getUserStore(): UserStore {
  if (!defaultStore) defaultStore = new UserStore();
  return defaultStore;
}
/** Test hook. */
export function __setUserStore(s: UserStore | null): void {
  if (defaultStore && defaultStore !== s) {
    try { defaultStore.close(); } catch { /* ignore */ }
  }
  defaultStore = s;
}
