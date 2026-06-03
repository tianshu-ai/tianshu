import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadGlobalConfig,
  loadTenantConfig,
  mergeConfigs,
  resolveTenantConfig,
  TenantConfigForbiddenFieldError,
  writeGlobalConfig,
  writeTenantConfig,
} from "./config.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-cfg-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("config", () => {
  it("returns empty when files don't exist", () => {
    expect(loadGlobalConfig(home)).toEqual({});
    expect(loadTenantConfig("acme", home)).toEqual({});
  });

  it("merges tenant over global, deep-merging worker/branding/apiKeys", () => {
    writeGlobalConfig(
      {
        defaultModel: "gpt-5",
        worker: { count: 2, pollMs: 10000 },
        branding: { name: "Tianshu", emoji: "⭐" },
        apiKeys: { openai: "g-open" },
      },
      home,
    );
    fs.mkdirSync(path.join(home, "tenants", "acme"), { recursive: true });
    writeTenantConfig(
      "acme",
      {
        defaultModel: "claude-sonnet-4",
        worker: { count: 4 },
        branding: { name: "Acme Inc" },
        apiKeys: { anthropic: "t-anth" },
      },
      home,
    );
    const resolved = resolveTenantConfig("acme", home);
    expect(resolved.defaultModel).toBe("claude-sonnet-4");
    expect(resolved.worker).toEqual({ count: 4, pollMs: 10000 });
    expect(resolved.branding).toEqual({ name: "Acme Inc", emoji: "⭐" });
    expect(resolved.apiKeys).toEqual({ openai: "g-open", anthropic: "t-anth" });
  });

  it("rejects forbidden fields in tenant config when reading", () => {
    fs.mkdirSync(path.join(home, "tenants", "acme"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "tenants", "acme", "config.json"),
      JSON.stringify({ server: { port: 9999 } }),
    );
    expect(() => loadTenantConfig("acme", home)).toThrow(TenantConfigForbiddenFieldError);
  });

  it("rejects forbidden fields when writing", () => {
    fs.mkdirSync(path.join(home, "tenants", "acme"), { recursive: true });
    expect(() =>
      writeTenantConfig(
        "acme",
        // intentional: simulating a misuse from JS callers
        { server: { port: 1 } } as unknown as Parameters<typeof writeTenantConfig>[1],
        home,
      ),
    ).toThrow(TenantConfigForbiddenFieldError);
  });

  it("mergeConfigs respects autoCreateDefault from global only", () => {
    const merged = mergeConfigs(
      { autoCreateDefault: false, server: { port: 4000 } },
      { defaultModel: "x" },
    );
    expect(merged.autoCreateDefault).toBe(false);
    expect(merged.server).toEqual({ port: 4000 });
    expect(merged.defaultModel).toBe("x");
  });
});
