import { describe, expect, it } from "vitest";
import { resolveInUserHome, toDisplayPath, PathOutsideRootError } from "./path-helper.js";

const HOME = "/tmp/tianshu-fake-home";

describe("resolveInUserHome", () => {
  it("treats / as the user home", () => {
    expect(resolveInUserHome(HOME, "/")).toBe(HOME);
  });

  it("resolves a leading-slash path inside the home", () => {
    expect(resolveInUserHome(HOME, "/foo/bar.txt")).toBe(`${HOME}/foo/bar.txt`);
  });

  it("treats /workspace/ as a synonym for the home root", () => {
    expect(resolveInUserHome(HOME, "/workspace/foo.txt")).toBe(`${HOME}/foo.txt`);
    expect(resolveInUserHome(HOME, "/workspace")).toBe(HOME);
  });

  it("accepts relative paths same as absolute", () => {
    expect(resolveInUserHome(HOME, "foo/bar.txt")).toBe(`${HOME}/foo/bar.txt`);
  });

  it("rejects parent-traversal attempts", () => {
    expect(() => resolveInUserHome(HOME, "/../etc/passwd")).toThrow(PathOutsideRootError);
    expect(() => resolveInUserHome(HOME, "../etc/passwd")).toThrow(PathOutsideRootError);
    expect(() => resolveInUserHome(HOME, "/foo/../../etc")).toThrow(PathOutsideRootError);
  });

  it("rejects empty paths", () => {
    expect(() => resolveInUserHome(HOME, "")).toThrow(PathOutsideRootError);
  });

  it("normalises backslashes to forward slashes", () => {
    expect(resolveInUserHome(HOME, "foo\\bar")).toBe(`${HOME}/foo/bar`);
  });
});

describe("toDisplayPath", () => {
  it("returns / for the root itself", () => {
    expect(toDisplayPath(HOME, HOME)).toBe("/");
  });

  it("formats nested paths with a leading slash", () => {
    expect(toDisplayPath(HOME, `${HOME}/foo/bar.txt`)).toBe("/foo/bar.txt");
  });
});
