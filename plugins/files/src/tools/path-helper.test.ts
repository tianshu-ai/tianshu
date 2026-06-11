import { describe, expect, it } from "vitest";
import {
  resolveInUserHome,
  toDisplayPath,
  toWorkspaceUri,
  PathOutsideRootError,
} from "./path-helper.js";

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

describe("toWorkspaceUri", () => {
  it("returns workspace:/// for the user home root", () => {
    expect(toWorkspaceUri(HOME, HOME)).toBe("workspace:///");
  });

  it("emits the canonical empty-authority shape for nested paths", () => {
    expect(toWorkspaceUri(HOME, `${HOME}/scratch/cover.png`)).toBe(
      "workspace:///scratch/cover.png",
    );
  });

  it("throws when asked to encode a path outside the home", () => {
    expect(() => toWorkspaceUri(HOME, "/etc/passwd")).toThrow(
      PathOutsideRootError,
    );
  });
});

describe("resolveInUserHome — workspace:// scheme", () => {
  it("resolves the canonical empty-authority shape", () => {
    expect(resolveInUserHome(HOME, "workspace:///foo/bar.txt")).toBe(
      `${HOME}/foo/bar.txt`,
    );
  });

  it("tolerates the two-slash alias the LLM sometimes emits", () => {
    expect(resolveInUserHome(HOME, "workspace://foo/bar.txt")).toBe(
      `${HOME}/foo/bar.txt`,
    );
  });

  it("resolves the workspace:/// root to the home itself", () => {
    expect(resolveInUserHome(HOME, "workspace:///")).toBe(HOME);
  });

  it("rejects workspace:// with parent-traversal", () => {
    expect(() => resolveInUserHome(HOME, "workspace:///../escape")).toThrow(
      PathOutsideRootError,
    );
  });
});
