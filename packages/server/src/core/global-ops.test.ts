import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DbPool } from "./db-pool.js";
import {
  GlobalOps,
  TenantAlreadyExistsError,
  TenantNotFoundError,
} from "./global-ops.js";
import { InvalidTenantIdError } from "./tenant-id.js";

let home: string;
let ops: GlobalOps;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-ops-"));
  ops = new GlobalOps({ home, pool: new DbPool({ home, maxOpen: 8 }) });
});
afterEach(() => {
  ops.closePool();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("GlobalOps", () => {
  it("list returns empty initially", () => {
    expect(ops.list()).toEqual([]);
  });

  it("create + list + open round-trip", () => {
    const ctx = ops.create("acme");
    expect(ctx.tenantId).toBe("acme");
    expect(fs.existsSync(path.join(ctx.root, "db.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(ctx.workspaceDir, "_tenant", "SOUL.md"))).toBe(true);
    expect(fs.existsSync(path.join(ctx.workspaceDir, "users"))).toBe(true);
    expect(ops.list()).toEqual(["acme"]);

    const ctx2 = ops.open("acme");
    expect(ctx2.tenantId).toBe("acme");
  });

  it("create rejects duplicates", () => {
    ops.create("acme");
    expect(() => ops.create("acme")).toThrow(TenantAlreadyExistsError);
  });

  it("rejects invalid tenantId everywhere", () => {
    expect(() => ops.create("BAD")).toThrow(InvalidTenantIdError);
    expect(() => ops.open("BAD")).toThrow(InvalidTenantIdError);
    expect(ops.exists("BAD")).toBe(false);
  });

  it("open throws when tenant doesn't exist", () => {
    expect(() => ops.open("ghost")).toThrow(TenantNotFoundError);
  });

  it("softDelete renames directory and is skipped by list()", () => {
    ops.create("acme");
    ops.create("widgets");
    ops.softDelete("acme");
    expect(ops.list()).toEqual(["widgets"]);
    const tenantsDir = path.join(home, "tenants");
    const remaining = fs.readdirSync(tenantsDir);
    expect(remaining.some((n) => n.startsWith("acme.deleted"))).toBe(true);
    expect(remaining).toContain("widgets");
  });

  it("softDelete invalidates the cached connection", () => {
    const ctx = ops.create("acme");
    expect(ops.poolRef.openCount).toBe(1);
    ops.softDelete(ctx.tenantId);
    expect(ops.poolRef.openCount).toBe(0);
    expect(() => ops.open("acme")).toThrow(TenantNotFoundError);
  });

  it("ensureUser inserts a row and seeds the user workspace", () => {
    const ctx = ops.create("acme");
    ops.ensureUser(ctx, {
      userId: "alice",
      provider: "github",
      externalId: "12345",
      displayName: "Alice",
    });
    const row = ctx.db
      .prepare<[string], { id: string; display_name: string }>(
        "SELECT id, display_name FROM users WHERE id = ?",
      )
      .get("alice");
    expect(row?.display_name).toBe("Alice");

    expect(
      fs.existsSync(path.join(ctx.workspaceDir, "users", "alice", "USER.md")),
    ).toBe(true);

    // idempotent
    ops.ensureUser(ctx, {
      userId: "alice",
      provider: "github",
      externalId: "12345",
    });
    const count = ctx.db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM users")
      .get();
    expect(count?.c).toBe(1);
  });

  it("scans skip dot-files, system-reserved, and *.deleted dirs", () => {
    const tenantsDir = path.join(home, "tenants");
    fs.mkdirSync(tenantsDir, { recursive: true });
    fs.mkdirSync(path.join(tenantsDir, ".keep"));
    fs.mkdirSync(path.join(tenantsDir, "_internal"));
    fs.mkdirSync(path.join(tenantsDir, "old.deleted.123"));
    ops.create("acme");
    expect(ops.list()).toEqual(["acme"]);
  });

  it("ensure() is idempotent", () => {
    const a = ops.ensure("acme");
    const b = ops.ensure("acme");
    expect(a.tenantId).toBe("acme");
    expect(b.tenantId).toBe("acme");
    expect(ops.list()).toEqual(["acme"]);
  });
});
