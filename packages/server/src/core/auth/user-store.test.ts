import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UserStore, hashPassword, verifyPassword } from "./user-store.js";
import { resolveTenantRole, isSuperAdmin } from "./identity.js";
import type { AuthConfig } from "../config.js";

let dir: string;
let store: UserStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-auth-"));
  store = new UserStore(undefined, path.join(dir, "auth.db"));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("password hashing", () => {
  it("round-trips + rejects wrong password", () => {
    const h = hashPassword("hunter2");
    expect(verifyPassword("hunter2", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
    expect(verifyPassword("hunter2", "garbage")).toBe(false);
  });
});

describe("user store", () => {
  it("creates + authenticates a user", () => {
    const u = store.createUser("alice", "pw123456", "a@b.com");
    expect(u.username).toBe("alice");
    expect(store.authenticate("alice", "pw123456")?.id).toBe(u.id);
    expect(store.authenticate("alice", "nope")).toBeNull();
    expect(store.authenticate("ghost", "x")).toBeNull();
  });

  it("rejects duplicate username", () => {
    store.createUser("bob", "pw123456");
    expect(() => store.createUser("bob", "other1")).toThrow();
  });

  it("ensureUser is idempotent + updates drifted password", () => {
    const a = store.ensureUser("root", "first-pw");
    const b = store.ensureUser("root", "second-pw");
    expect(a.id).toBe(b.id); // same user
    expect(store.authenticate("root", "second-pw")).not.toBeNull();
    expect(store.authenticate("root", "first-pw")).toBeNull();
  });

  it("set/get/remove per-tenant roles", () => {
    const u = store.createUser("carol", "pw123456");
    expect(store.getRole(u.id, "t1")).toBeNull();
    store.setRole(u.id, "t1", "admin");
    store.setRole(u.id, "t2", "member");
    expect(store.getRole(u.id, "t1")).toBe("admin");
    expect(store.getRole(u.id, "t2")).toBe("member");
    expect(store.rolesForUser(u.id)).toHaveLength(2);
    store.removeRole(u.id, "t1");
    expect(store.getRole(u.id, "t1")).toBeNull();
  });

  it("deleteUser cascades roles", () => {
    const u = store.createUser("dave", "pw123456");
    store.setRole(u.id, "t1", "admin");
    store.deleteUser(u.id);
    expect(store.getById(u.id)).toBeNull();
    expect(store.rolesForUser(u.id)).toHaveLength(0);
  });
});

describe("tenant-role resolution (super-admin > db > member)", () => {
  it("config super-admin by username → admin everywhere", () => {
    const cfg: AuthConfig = { superAdmins: [{ username: "yu", password: "x" }] };
    expect(isSuperAdmin(cfg, { username: "yu" })).toBe(true);
    const role = resolveTenantRole(cfg, store, {
      userId: "irrelevant",
      tenantId: "any",
      username: "yu",
    });
    expect(role).toBe("admin");
  });

  it("config super-admin by OAuth email → admin everywhere", () => {
    const cfg: AuthConfig = { admins: ["Yu@Example.com"] };
    expect(isSuperAdmin(cfg, { email: "yu@example.com" })).toBe(true);
    expect(
      resolveTenantRole(cfg, store, { userId: "u", tenantId: "t", email: "yu@example.com" }),
    ).toBe("admin");
  });

  it("non-super-admin uses per-tenant db role, defaults member", () => {
    const cfg: AuthConfig = {};
    const u = store.createUser("erin", "pw123456");
    store.setRole(u.id, "acme", "admin");
    expect(resolveTenantRole(cfg, store, { userId: u.id, tenantId: "acme" })).toBe("admin");
    // different tenant, no grant → member
    expect(resolveTenantRole(cfg, store, { userId: u.id, tenantId: "other" })).toBe("member");
  });
});
