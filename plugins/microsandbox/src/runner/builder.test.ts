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
  it("falls back to nullable when the SDK probe fails", async () => {
    const built = await buildRunner({
      pluginId: "microsandbox",
      contributionId: "main",
      tenantId: "acme",
      workspaceDir,
      rawConfig: {},
      probeSdk: async () => ({
        ok: false,
        reason: "no napi binary for fake-arch",
      }),
    });
    expect(built.ready).toBe(false);
    expect(built.runner.kind).toBe("shell");
    const status = await built.runner.status();
    expect(status.state).toBe("error");
    expect(status.meta?.runner).toBe("nullable");
    expect(built.selectedReason).toMatch(/no napi binary/);
  });

  it("uses the real runner when the SDK probe succeeds", async () => {
    const built = await buildRunner({
      pluginId: "microsandbox",
      contributionId: "main",
      tenantId: "acme",
      workspaceDir,
      rawConfig: {},
      probeSdk: async () => ({ ok: true }),
    });
    expect(built.ready).toBe(true);
    const status = await built.runner.status();
    // The real runner reports stopped until first exec triggers
    // doStart(); we check meta to confirm it's the real path.
    expect(status.meta?.runner).toBe("microsandbox");
    expect(status.meta?.sandboxName).toBe("tianshu-acme");
  });

  it("respects sandbox config overrides via pluginConfig", async () => {
    const built = await buildRunner({
      pluginId: "microsandbox",
      contributionId: "main",
      tenantId: "acme",
      workspaceDir,
      rawConfig: {
        image: "ubuntu:24.04",
        cpus: 4,
        memoryMib: 8192,
        sandboxName: "my-vm",
      },
      probeSdk: async () => ({ ok: true }),
    });
    expect(built.config.image).toBe("ubuntu:24.04");
    expect(built.config.cpus).toBe(4);
    expect(built.config.memoryMib).toBe(8192);
    expect(built.config.sandboxName).toBe("my-vm");
  });

  it("default sandbox name is tianshu-<tenantId>", async () => {
    const built = await buildRunner({
      pluginId: "microsandbox",
      contributionId: "main",
      tenantId: "acme",
      workspaceDir,
      rawConfig: {},
      probeSdk: async () => ({ ok: true }),
    });
    expect(built.config.sandboxName).toBe("tianshu-acme");
  });
});
