import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRunner } from "./index.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-msb-build-"));
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

describe("buildRunner facade", () => {
  it("falls back to nullable when binary is not found", async () => {
    const built = await buildRunner({
      pluginId: "microsandbox",
      contributionId: "main",
      workspaceDir,
      rawConfig: {},
      resolveBinary: async () => null,
    });
    expect(built.ready).toBe(false);
    expect(built.runner.kind).toBe("shell");
    const status = await built.runner.status();
    expect(status.state).toBe("error");
    expect(status.meta?.runner).toBe("nullable");
    expect(built.selectedReason).toMatch(/microsandbox binary not found/);
  });

  it("uses the real runner when the binary resolves", async () => {
    // Stub out `which microsandbox` with a known-existing binary
    // (we don't actually exec it in this test, just check the
    // facade picks the real runner path).
    const built = await buildRunner({
      pluginId: "microsandbox",
      contributionId: "main",
      workspaceDir,
      rawConfig: {},
      resolveBinary: async () => "/usr/bin/true", // any real file works
    });
    expect(built.ready).toBe(true);
    const status = await built.runner.status();
    expect(status.state).toBe("ready");
    expect(status.meta?.runner).toBe("microsandbox");
  });

  it("respects pluginConfig.binary override", async () => {
    let observed: string | null = null;
    await buildRunner({
      pluginId: "microsandbox",
      contributionId: "main",
      workspaceDir,
      rawConfig: { binary: "/opt/custom/microsandbox" },
      resolveBinary: async (b) => {
        observed = b;
        return null; // force nullable, we only check the call
      },
    });
    expect(observed).toBe("/opt/custom/microsandbox");
  });

  it("respects sandboxName + projectDir overrides in status meta", async () => {
    const built = await buildRunner({
      pluginId: "microsandbox",
      contributionId: "main",
      workspaceDir,
      rawConfig: { sandboxName: "myproj", projectDir: "alt" },
      resolveBinary: async () => "/usr/bin/true",
    });
    const status = await built.runner.status();
    expect(status.meta?.sandboxName).toBe("myproj");
    expect(status.meta?.projectDir).toBe(path.join(workspaceDir, "alt"));
  });
});
