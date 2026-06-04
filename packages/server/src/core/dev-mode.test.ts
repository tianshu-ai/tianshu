import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DbPool } from "./db-pool.js";
import { bootstrapDevTenantIfNeeded, DEV_TENANT_ID, DEV_USER_ID } from "./dev-mode.js";
import { GlobalOps } from "./global-ops.js";
import { loadTenantConfig } from "./config.js";

let home: string;
let prevHome: string | undefined;
let ops: GlobalOps;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-dev-"));
  prevHome = process.env.TIANSHU_HOME;
  process.env.TIANSHU_HOME = home;
  ops = new GlobalOps({ home, pool: new DbPool({ home }) });
});
afterEach(() => {
  ops.closePool();
  if (prevHome === undefined) delete process.env.TIANSHU_HOME;
  else process.env.TIANSHU_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("bootstrapDevTenantIfNeeded", () => {
  it("creates default tenant + dev user on first boot", () => {
    const r = bootstrapDevTenantIfNeeded(ops, {});
    expect(r.created).toBe(true);
    expect(r.tenantId).toBe(DEV_TENANT_ID);
    expect(r.userId).toBe(DEV_USER_ID);

    const ctx = ops.open(DEV_TENANT_ID);
    const userRow = ctx.db
      .prepare<[string], { id: string }>("SELECT id FROM users WHERE id = ?")
      .get(DEV_USER_ID);
    expect(userRow?.id).toBe(DEV_USER_ID);
  });

  it("pre-enables the files builtin plugin in the dev tenant", () => {
    bootstrapDevTenantIfNeeded(ops, {});
    const cfg = loadTenantConfig(DEV_TENANT_ID, home);
    expect(cfg.plugins?.files).toEqual({ enabled: true });
  });

  it("is a no-op when tenants already exist", () => {
    ops.create("acme");
    const r = bootstrapDevTenantIfNeeded(ops, {});
    expect(r.created).toBe(false);
    expect(ops.list()).toEqual(["acme"]);
  });

  it("respects autoCreateDefault=false", () => {
    const r = bootstrapDevTenantIfNeeded(ops, { autoCreateDefault: false });
    expect(r.created).toBe(false);
    expect(ops.list()).toEqual([]);
  });
});
