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

  it("mergeConfigs picks a tenant defaultModel from tenant catalog when missing", () => {
    // The bug this guards against (2026-06-21): tenant brings its
    // own `models` catalog (qwen only) but doesn't set
    // defaultModel. Pre-fix, defaultModel inherited from global as
    // "anthropic/claude-sonnet-4-6" — a provider that no longer
    // existed in the resolved catalog — and every chat request
    // 500'd with "unknown provider".
    const merged = mergeConfigs(
      {
        defaultModel: "anthropic/claude-sonnet-4-6",
        models: {
          providers: {
            anthropic: {
              api: "anthropic-messages",
              baseUrl: "https://api.anthropic.com",
              apiKey: "sk-anthropic",
              models: [{ id: "claude-sonnet-4-6", name: "Sonnet" }],
            },
          },
        },
      },
      {
        models: {
          providers: {
            qwen: {
              api: "openai-completions",
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
              apiKey: "sk-qwen",
              models: [{ id: "qwen3-max-preview", name: "Qwen3 Max" }],
            },
          },
        },
      },
    );
    expect(merged.defaultModel).toBe("qwen/qwen3-max-preview");
    expect(Object.keys(merged.models!.providers)).toEqual(["qwen"]);
  });

  it("mergeConfigs preserves explicit tenant defaultModel even with tenant catalog", () => {
    // Tenant author has full control: explicit defaultModel wins
    // over the auto-pick "first provider's first model".
    const merged = mergeConfigs(
      { defaultModel: "global/x" },
      {
        defaultModel: "qwen/qwen3-coder",
        models: {
          providers: {
            qwen: {
              api: "openai-completions",
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
              apiKey: "sk-qwen",
              models: [
                { id: "qwen3-max-preview", name: "Max" },
                { id: "qwen3-coder", name: "Coder" },
              ],
            },
          },
        },
      },
    );
    expect(merged.defaultModel).toBe("qwen/qwen3-coder");
  });

  it("mergeConfigs falls back to global defaultModel when tenant has no models override", () => {
    // The original behaviour for tenants that just enable plugins
    // without redefining the model catalog — they should still
    // inherit global's defaultModel.
    const merged = mergeConfigs(
      { defaultModel: "anthropic/claude-sonnet-4-6" },
      { plugins: { files: { enabled: true } } },
    );
    expect(merged.defaultModel).toBe("anthropic/claude-sonnet-4-6");
  });
});
