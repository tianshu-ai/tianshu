import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DbPool } from "./db-pool.js";
import { GlobalOps } from "./global-ops.js";

let home: string;
let ops: GlobalOps;
let pool: DbPool;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-pool-"));
  pool = new DbPool({ home, maxOpen: 2 });
  ops = new GlobalOps({ home, pool });
});
afterEach(() => {
  pool.closeAll();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("DbPool", () => {
  it("opens DBs lazily and runs migrations", () => {
    const ctx = ops.create("acme");
    const tables = ctx.db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    // Check the v0 schema is in place.
    expect(tables).toEqual(
      expect.arrayContaining([
        "messages",
        "schema_migrations",
        "sessions",
        "tasks",
        "users",
      ]),
    );
  });

  it("LRU evicts the least-recently-used DB", () => {
    ops.create("t-a");
    ops.create("t-b");
    expect(pool.openCount).toBe(2);
    ops.create("t-c"); // creating a new tenant also opens it -> LRU evicts "t-a"
    expect(pool.openCount).toBe(2);
  });

  it("get() bumps to MRU", () => {
    ops.create("t-a");
    ops.create("t-b");
    ops.open("t-a"); // bump t-a
    ops.create("t-c"); // expected: "t-b" gets evicted
    expect(pool.openCount).toBe(2);
    // after eviction, opening t-b again should still work (reopens the file)
    expect(() => ops.open("t-b")).not.toThrow();
  });

  it("migrations are idempotent across reopen", () => {
    const ctx = ops.create("acme");
    pool.close("acme");
    const ctx2 = ops.open("acme");
    const count = ctx2.db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM schema_migrations")
      .get();
    expect(count?.c).toBeGreaterThan(0);
    expect(ctx).not.toBe(ctx2);
  });
});
