// Tenant lifecycle and cross-tenant operations.
//
// Routes / middleware NEVER reach into tenants/ directly; everything goes
// through here. That keeps "find a tenant", "create a tenant", "delete a
// tenant" in one place where we can enforce naming, soft-delete, and
// scan-skipping for `*.deleted` directories.
//
// Per ADR-0001 §9 — soft delete = rename to `<id>.deleted.<ts>`. Hard
// delete (--purge) is a separate operation we don't implement in PR #20.

import fs from "node:fs";
import path from "node:path";
import { writeTenantConfig } from "./config.js";
import { DbPool } from "./db-pool.js";
import {
  getDeletedTenantPath,
  getTenantRoot,
  getTenantSecretsDir,
  getTenantsRoot,
  getTianshuHome,
  isSoftDeletedDirName,
  isSystemReserved,
} from "./paths.js";
import { seedTenantWorkspace, seedUserWorkspace } from "./templates.js";
import {
  buildTenantContext,
  TenantContext,
} from "./tenant-context.js";
import { InvalidTenantIdError, validateTenantId } from "./tenant-id.js";

export class TenantNotFoundError extends Error {
  readonly code = "TENANT_NOT_FOUND" as const;
  constructor(public readonly tenantId: string) {
    super(`tenant "${tenantId}" not found`);
    this.name = "TenantNotFoundError";
  }
}

export class TenantAlreadyExistsError extends Error {
  readonly code = "TENANT_ALREADY_EXISTS" as const;
  constructor(public readonly tenantId: string) {
    super(`tenant "${tenantId}" already exists`);
    this.name = "TenantAlreadyExistsError";
  }
}

export interface GlobalOpsOptions {
  home?: string;
  pool?: DbPool;
}

/**
 * Tenant lifecycle. Holds a reference to the DbPool so opening a tenant
 * always goes through the same connection cache.
 */
export class GlobalOps {
  private readonly home: string;
  private readonly pool: DbPool;

  constructor(opts: GlobalOpsOptions = {}) {
    this.home = opts.home ?? getTianshuHome();
    this.pool = opts.pool ?? new DbPool({ home: this.home });
  }

  /** List visible tenant ids (skips `*.deleted*` and dot-files). */
  list(): string[] {
    const root = getTenantsRoot(this.home);
    if (!fs.existsSync(root)) return [];
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const ids: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue;
      if (isSoftDeletedDirName(e.name)) continue;
      if (isSystemReserved(e.name)) continue;
      ids.push(e.name);
    }
    return ids.sort();
  }

  /** True iff this tenant's directory exists and is not soft-deleted. */
  exists(tenantId: string): boolean {
    try {
      validateTenantId(tenantId);
    } catch {
      return false;
    }
    const root = getTenantRoot(tenantId, this.home);
    return fs.existsSync(root) && !isSoftDeletedDirName(path.basename(root));
  }

  /** Open a TenantContext, throwing if the tenant doesn't exist. */
  open(tenantId: string): TenantContext {
    const id = validateTenantId(tenantId);
    if (!this.exists(id)) throw new TenantNotFoundError(id);
    const db = this.pool.get(id);
    return buildTenantContext(id, db, this.home);
  }

  /** Create a brand-new tenant. Throws if one already exists. */
  create(tenantId: string): TenantContext {
    const id = validateTenantId(tenantId);
    if (this.exists(id)) throw new TenantAlreadyExistsError(id);
    const root = getTenantRoot(id, this.home);
    fs.mkdirSync(root, { recursive: true });

    // secrets/ — mode 0700 so other local users can't read API keys
    fs.mkdirSync(getTenantSecretsDir(id, this.home), { recursive: true, mode: 0o700 });

    // workspace seed
    seedTenantWorkspace(id, this.home);

    // empty config.json (acts as a marker that a creator made it)
    writeTenantConfig(id, {}, this.home);

    // running this opens & migrates the DB
    const db = this.pool.get(id);
    return buildTenantContext(id, db, this.home);
  }

  /** Idempotent: returns existing if present, creates otherwise. */
  ensure(tenantId: string): TenantContext {
    return this.exists(tenantId) ? this.open(tenantId) : this.create(tenantId);
  }

  /**
   * Soft-delete: rename to `<id>.deleted.<ts>`. Future scans skip it.
   * The DB connection is closed before the rename.
   */
  softDelete(tenantId: string): void {
    const id = validateTenantId(tenantId);
    if (!this.exists(id)) throw new TenantNotFoundError(id);
    this.pool.close(id);
    const src = getTenantRoot(id, this.home);
    const dst = getDeletedTenantPath(id, Date.now(), this.home);
    fs.renameSync(src, dst);
  }

  /** Provision a new user under this tenant: seed workspace, ensure DB row exists. */
  ensureUser(
    ctx: TenantContext,
    args: { userId: string; provider: string; externalId: string; displayName?: string },
  ): void {
    seedUserWorkspace(ctx.tenantId, args.userId, this.home);
    const now = Date.now();
    ctx.db
      .prepare<
        [string, string, string, string | null, number],
        unknown
      >(
        `INSERT INTO users (id, external_id, provider, display_name, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider, external_id) DO NOTHING`,
      )
      .run(args.userId, args.externalId, args.provider, args.displayName ?? null, now);
  }

  // For tests / shutdown.
  closePool(): void {
    this.pool.closeAll();
  }

  get poolRef(): DbPool {
    return this.pool;
  }
}

export {
  InvalidTenantIdError,
};
