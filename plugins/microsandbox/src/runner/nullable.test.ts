import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NullableRunner } from "./nullable.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-msb-null-"));
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

function makeRunner(reason = "binary not found") {
  return new NullableRunner({
    pluginId: "microsandbox",
    contributionId: "main",
    workspaceDir,
    reason,
  });
}

describe("NullableRunner", () => {
  it("status() reports state=error with the reason", async () => {
    const r = makeRunner("nope");
    const s = await r.status();
    expect(s.state).toBe("error");
    expect(s.lastError).toBe("nope");
    expect(s.meta?.runner).toBe("nullable");
  });

  it("exec() returns an error result and never throws", async () => {
    const r = makeRunner("missing");
    const result = await r.exec({ command: "echo hi" });
    expect(result.exitCode).toBe(-1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/microsandbox unavailable: missing/);
    expect(result.timedOut).toBe(false);
  });

  it("readFile / writeFile use the host workspace path", async () => {
    const r = makeRunner();
    await r.writeFile("foo/bar.txt", "hello");
    const text = await r.readFile("foo/bar.txt");
    expect(text).toBe("hello");
    // Verify it actually landed on disk under workspaceDir.
    const onDisk = fs.readFileSync(path.join(workspaceDir, "foo/bar.txt"), "utf8");
    expect(onDisk).toBe("hello");
  });

  it("readFile rejects absolute paths", async () => {
    const r = makeRunner();
    await expect(r.readFile("/etc/passwd")).rejects.toThrow(/absolute paths/);
  });

  it("writeFile rejects paths that escape the workspace", async () => {
    const r = makeRunner();
    await expect(r.writeFile("../../etc/evil", "x")).rejects.toThrow(/escapes workspace/);
  });

  it("workspacePath returns the host dir", () => {
    const r = makeRunner();
    expect(r.workspacePath()).toBe(workspaceDir);
  });

  it("reset and shutdown are no-ops (don't throw)", async () => {
    const r = makeRunner();
    await expect(r.reset()).resolves.toBeUndefined();
    await expect(r.shutdown()).resolves.toBeUndefined();
  });
});
