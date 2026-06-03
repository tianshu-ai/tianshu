import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  ensureInside,
  getTenantRoot,
  getTenantsRoot,
  getTianshuHome,
  isSoftDeletedDirName,
  isSystemReserved,
} from "./paths.js";

describe("paths", () => {
  it("getTianshuHome respects TIANSHU_HOME", () => {
    const prev = process.env.TIANSHU_HOME;
    process.env.TIANSHU_HOME = "/tmp/tianshu-test-home";
    try {
      expect(getTianshuHome()).toBe("/tmp/tianshu-test-home");
    } finally {
      if (prev === undefined) delete process.env.TIANSHU_HOME;
      else process.env.TIANSHU_HOME = prev;
    }
  });

  it("composes tenant paths under tenants/", () => {
    const home = "/srv/tianshu";
    expect(getTenantsRoot(home)).toBe("/srv/tianshu/tenants");
    expect(getTenantRoot("acme", home)).toBe("/srv/tianshu/tenants/acme");
  });

  describe("ensureInside", () => {
    const root = "/srv/tianshu/tenants/acme/workspace";

    it("accepts a child path", () => {
      expect(ensureInside(root, "foo/bar")).toBe(path.join(root, "foo/bar"));
    });

    it("accepts an absolute path inside root", () => {
      expect(ensureInside(root, path.join(root, "ok.txt"))).toBe(path.join(root, "ok.txt"));
    });

    it("accepts the root itself", () => {
      expect(ensureInside(root, ".")).toBe(root);
    });

    it("rejects path traversal", () => {
      expect(() => ensureInside(root, "../../../etc/passwd")).toThrow(/escapes root/);
    });

    it("rejects an absolute path outside root", () => {
      expect(() => ensureInside(root, "/etc/passwd")).toThrow(/escapes root/);
    });

    it("rejects sibling tenant directory", () => {
      expect(() => ensureInside(root, "../other/workspace/file")).toThrow(/escapes root/);
    });
  });

  describe("name predicates", () => {
    it("isSoftDeletedDirName recognises plain and timestamped suffixes", () => {
      expect(isSoftDeletedDirName("acme.deleted")).toBe(true);
      expect(isSoftDeletedDirName("acme.deleted.1717420000000")).toBe(true);
      expect(isSoftDeletedDirName("acme")).toBe(false);
      expect(isSoftDeletedDirName("acme.archive")).toBe(false);
    });

    it("isSystemReserved flags underscore-prefixed names", () => {
      expect(isSystemReserved("_tenant")).toBe(true);
      expect(isSystemReserved("_shared")).toBe(true);
      expect(isSystemReserved("acme")).toBe(false);
    });
  });
});
