// Per-tenant SQLite connection pool with LRU eviction.
//
// better-sqlite3 is synchronous; each Database instance holds one fd. We
// don't want a 100-tenant deploy holding 100 fds, so we cap to N most-
// recently-used DBs and reopen on demand. Reopening is cheap with WAL.

import Database, { type Database as DB } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import fs from "node:fs";
import path from "node:path";
import { getTenantDbPath } from "./paths.js";
import { runMigrations } from "./migrations/index.js";

// sqlite-vec (vector search) is a loadable SQLite extension. We load it
// ONCE per connection here in the pool so every tenant DB can create
// `vec0` virtual tables (used by the wiki plugin for semantic search).
// Loading is best-effort: if the platform prebuilt is missing, we log
// once and continue — consumers check `db.vecAvailable` and fall back
// (the wiki degrades to keyword/JSON search). FTS5 needs no load; it's
// compiled into better-sqlite3.
let warnedVecLoad = false;
function tryLoadVec(db: DB): boolean {
  try {
    sqliteVec.load(db);
    return true;
  } catch (err) {
    if (!warnedVecLoad) {
      warnedVecLoad = true;
      console.warn(
        `[db-pool] sqlite-vec extension failed to load; vector search disabled: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return false;
  }
}

export interface DbPoolOptions {
  /** Max number of concurrently-open tenant DBs. */
  maxOpen?: number;
  home?: string;
}

const DEFAULT_MAX_OPEN = 32;

interface Entry {
  tenantId: string;
  db: DB;
}

/**
 * The pool maintains insertion-order in a Map. On access, we delete +
 * re-insert the entry so the most-recently-used is always at the tail.
 * When size > max, we evict from the head.
 */
export class DbPool {
  private readonly entries = new Map<string, Entry>();
  private readonly maxOpen: number;
  private readonly home: string | undefined;

  constructor(opts: DbPoolOptions = {}) {
    this.maxOpen = opts.maxOpen ?? DEFAULT_MAX_OPEN;
    this.home = opts.home;
  }

  /** Open (or return cached) DB for a tenant, running pending migrations. */
  get(tenantId: string): DB {
    const cached = this.entries.get(tenantId);
    if (cached) {
      // bump to MRU
      this.entries.delete(tenantId);
      this.entries.set(tenantId, cached);
      return cached.db;
    }
    const db = this.open(tenantId);
    this.entries.set(tenantId, { tenantId, db });
    this.evictIfNeeded();
    return db;
  }

  /** Close and forget a tenant's DB (e.g. on tenant delete). */
  close(tenantId: string): void {
    const entry = this.entries.get(tenantId);
    if (!entry) return;
    try {
      entry.db.close();
    } catch {
      /* ignore */
    }
    this.entries.delete(tenantId);
  }

  /** Close all open DBs. Call on shutdown. */
  closeAll(): void {
    for (const entry of this.entries.values()) {
      try {
        entry.db.close();
      } catch {
        /* ignore */
      }
    }
    this.entries.clear();
  }

  /** For tests / introspection. */
  get openCount(): number {
    return this.entries.size;
  }

  // ─── internals ───────────────────────────────────────────────────

  private open(tenantId: string): DB {
    const dbPath = getTenantDbPath(tenantId, this.home);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = NORMAL");
    // Load the vector extension and record availability on the handle
    // so plugins can branch without re-attempting the load.
    (db as DB & { vecAvailable?: boolean }).vecAvailable = tryLoadVec(db);
    runMigrations(db);
    return db;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxOpen) {
      const lru = this.entries.keys().next().value;
      if (!lru) break;
      const entry = this.entries.get(lru);
      this.entries.delete(lru);
      if (entry) {
        try {
          entry.db.close();
        } catch {
          /* ignore */
        }
      }
    }
  }
}

let defaultPool: DbPool | null = null;

/** Process-wide singleton, used by routes and middleware. Tests should use `new DbPool()`. */
export function getDefaultPool(): DbPool {
  if (!defaultPool) defaultPool = new DbPool();
  return defaultPool;
}

/** For tests: replace the default pool. */
export function __setDefaultPool(pool: DbPool | null): void {
  defaultPool = pool;
}
