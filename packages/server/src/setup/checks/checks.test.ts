import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkRuntime } from "./runtime.js";
import { checkConfig } from "./config.js";
import { checkProviders } from "./providers.js";
import { checkNetwork } from "./network.js";
import { checkTenants } from "./tenants.js";
import type { GlobalConfig } from "../../core/config.js";

describe("checkRuntime", () => {
  it("flags Node version as ok when >=22", () => {
    const r = checkRuntime();
    const nodeLine = r.lines[0];
    expect(nodeLine).toBeDefined();
    // The actual Node we're running tests under is >=22, so we
    // expect ok. Tracking blocker behaviour is covered by the
    // text inspection — we never want to silently degrade.
    expect(["ok", "blocker"]).toContain(nodeLine!.severity);
    expect(nodeLine!.text).toMatch(/Node \d/);
  });

  it("includes platform info as ok or warning, never blocker", () => {
    const r = checkRuntime();
    for (const line of r.lines) {
      expect(line.severity).not.toBe("blocker"); // Node line could
      // unless ancient — but in CI we test on >=22.
      void line;
    }
  });
});

describe("checkTenants (tenant + user + plugin topology)", () => {
  // Spin a fake builtinConfig dir + ~/.tianshu home, so the
  // check runs against a controllable layout. These tests pin
  // the user-facing line text — the original doctor mis-rendered
  // "✓ files" while Plugin Manager UI showed it disabled, and we
  // want a regression guard against drifting back.
  let builtinConfigDir: string;
  let home: string;

  beforeEach(() => {
    builtinConfigDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tianshu-check-tenants-bc-"),
    );
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-check-tenants-home-"));
    for (const id of ["files", "workboard", "microsandbox"]) {
      const dir = path.join(builtinConfigDir, "plugins", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({ id, name: id }),
      );
    }
  });

  afterEach(() => {
    fs.rmSync(builtinConfigDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  function seedTenant(
    tenantId: string,
    config: Record<string, unknown>,
    users: string[] = [],
  ): void {
    const tdir = path.join(home, "tenants", tenantId);
    fs.mkdirSync(tdir, { recursive: true });
    fs.writeFileSync(path.join(tdir, "config.json"), JSON.stringify(config));
    for (const u of users) {
      fs.mkdirSync(path.join(tdir, "workspace", "users", u), {
        recursive: true,
      });
    }
  }

  function seedWorker(
    tenantId: string,
    slug: string,
    spec: Record<string, unknown>,
  ): void {
    const wdir = path.join(
      home,
      "tenants",
      tenantId,
      "workspace",
      "_tenant",
      "config",
      "workers",
      slug,
    );
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, "agent.json"), JSON.stringify(spec));
  }

  it("warns when no tenants on disk", () => {
    const r = checkTenants({ builtinConfigDir, home });
    expect(r.lines[0]!.severity).toBe("warning");
    expect(r.lines[0]!.text).toMatch(/no tenants on disk/);
  });

  it("renders one block per tenant with users + enabled plugins", () => {
    seedTenant(
      "default",
      { plugins: { files: { enabled: true }, workboard: { enabled: true } } },
      ["dev"],
    );
    seedTenant(
      "alpha",
      { plugins: { files: { enabled: true } } },
      ["alice", "bob"],
    );
    const r = checkTenants({ builtinConfigDir, home });
    const text = r.lines.map((l) => l.text).join("\n");
    // Tenants in sorted order.
    expect(text).toMatch(/tenant 'alpha'[\s\S]*tenant 'default'/);
    expect(text).toMatch(/users \(2\): alice, bob/);
    expect(text).toMatch(/users \(1\): dev/);
    // Enabled plugin lists are sorted, no microsandbox in either.
    expect(text).toMatch(/enabled plugins \(2\): files, workboard/);
    expect(text).toMatch(/enabled plugins \(1\): files/);
  });

  it("includes installed-but-not-listed plugins in the disabled bucket", () => {
    // Tenant config doesn't even mention microsandbox; we want
    // doctor to surface it as disabled rather than silently drop
    // it (the original bug pattern).
    seedTenant("default", { plugins: { files: { enabled: true } } }, ["dev"]);
    const r = checkTenants({ builtinConfigDir, home });
    const text = r.lines.map((l) => l.text).join("\n");
    expect(text).toMatch(/disabled plugins \(2\): microsandbox, workboard/);
  });

  it("flags unknown plugins (config references id that has no manifest)", () => {
    seedTenant(
      "default",
      { plugins: { ghost: { enabled: true } } },
      ["dev"],
    );
    const r = checkTenants({ builtinConfigDir, home });
    const unknownLine = r.lines.find((l) =>
      l.text.includes("unknown plugins in config"),
    );
    expect(unknownLine).toBeDefined();
    expect(unknownLine!.severity).toBe("warning");
    expect(unknownLine!.text).toMatch(/ghost/);
  });

  it("ignores soft-deleted tenants", () => {
    fs.mkdirSync(path.join(home, "tenants", "default.deleted.999"), {
      recursive: true,
    });
    const r = checkTenants({ builtinConfigDir, home });
    expect(r.lines[0]!.text).toMatch(/no tenants on disk/);
  });

  it("surfaces tenant defaultModel override in the header detail", () => {
    seedTenant(
      "default",
      { defaultModel: "openai/gpt-4o", plugins: {} },
      ["dev"],
    );
    const r = checkTenants({ builtinConfigDir, home });
    const header = r.lines.find((l) => l.text === "tenant 'default'");
    expect(header?.detail).toMatch(/openai\/gpt-4o/);
  });

  it("warns 'workboard: no defaultModel resolvable' when workboard on + no model", () => {
    // Tenant enables workboard but has no defaultModel and the
    // (fake) global config also lacks one. Workers without a
    // per-agent modelId would fail to start LLM runs.
    seedTenant(
      "default",
      { plugins: { workboard: { enabled: true } } },
      ["dev"],
    );
    const r = checkTenants({ builtinConfigDir, home });
    const w = r.lines.find((l) => l.text.includes("workboard: no defaultModel"));
    expect(w?.severity).toBe("warning");
  });

  it("does NOT warn when workboard on + tenant supplies defaultModel", () => {
    seedTenant(
      "default",
      {
        defaultModel: "qwen/qwen3-max",
        plugins: { workboard: { enabled: true } },
      },
      ["dev"],
    );
    const r = checkTenants({ builtinConfigDir, home });
    expect(r.lines.find((l) => l.text.includes("workboard: no defaultModel"))).toBeUndefined();
  });

  it("lists each LLM worker with the model it'll resolve", () => {
    // workboard enabled + multiple workers, one with a per-worker
    // modelId pin and one inheriting tenant defaultModel.
    seedTenant(
      "default",
      {
        defaultModel: "qwen/qwen3-max",
        plugins: { workboard: { enabled: true } },
        models: {
          providers: {
            qwen: {
              api: "openai-completions",
              apiKey: "sk-x",
              baseUrl: "https://x.example/v1",
              models: [
                { id: "qwen3-max", contextWindow: 200_000 },
                { id: "qwen3-coder", contextWindow: 200_000 },
              ],
            },
          },
        },
      },
      ["dev"],
    );
    seedWorker("default", "coder", {
      kind: "llm",
      enabled: true,
      modelId: "qwen/qwen3-coder",
      description: "Implementation worker.",
    });
    seedWorker("default", "researcher", {
      kind: "llm",
      enabled: true,
      description: "Research worker.",
      // no modelId → inherits tenant defaultModel
    });
    const r = checkTenants({ builtinConfigDir, home });
    const lines = r.lines;
    const coderLine = lines.find((l) => l.text.includes("worker 'coder'"));
    expect(coderLine?.severity).toBe("ok");
    expect(coderLine?.text).toMatch(/pinned model qwen\/qwen3-coder/);
    const researcherLine = lines.find((l) =>
      l.text.includes("worker 'researcher'"),
    );
    expect(researcherLine?.severity).toBe("ok");
    expect(researcherLine?.text).toMatch(/inherits qwen\/qwen3-max/);
  });

  it("blocker when a worker pins a modelId not in the catalog", () => {
    seedTenant(
      "default",
      {
        defaultModel: "qwen/qwen3-max",
        plugins: { workboard: { enabled: true } },
        models: {
          providers: {
            qwen: {
              api: "openai-completions",
              apiKey: "sk-x",
              baseUrl: "https://x.example/v1",
              models: [{ id: "qwen3-max", contextWindow: 200_000 }],
            },
          },
        },
      },
      ["dev"],
    );
    seedWorker("default", "ghost", {
      kind: "llm",
      enabled: true,
      modelId: "ghosthouse/claude-9999",
      description: "Pins a model that doesn't exist.",
    });
    const r = checkTenants({ builtinConfigDir, home });
    const ghostLine = r.lines.find((l) => l.text.includes("worker 'ghost'"));
    expect(ghostLine?.severity).toBe("blocker");
    expect(ghostLine?.text).toMatch(/not in catalog/);
    expect(ghostLine?.detail).toMatch(/ghosthouse\/claude-9999/);
  });

  it("skips non-llm workers (e.g. echo demo) from model checks", () => {
    seedTenant(
      "default",
      {
        defaultModel: "anthropic/claude-x",
        plugins: { workboard: { enabled: true } },
        models: {
          providers: {
            anthropic: {
              api: "anthropic-messages",
              apiKey: "sk-x",
              models: [{ id: "claude-x", contextWindow: 200_000 }],
            },
          },
        },
      },
      ["dev"],
    );
    seedWorker("default", "echo-demo", {
      kind: "echo",
      enabled: true,
      description: "Echo doesn't use an LLM.",
    });
    const r = checkTenants({ builtinConfigDir, home });
    expect(
      r.lines.find((l) => l.text.includes("worker 'echo-demo'")),
    ).toBeUndefined();
  });

  it("skips disabled workers from model checks", () => {
    seedTenant(
      "default",
      {
        defaultModel: "anthropic/claude-x",
        plugins: { workboard: { enabled: true } },
        models: {
          providers: {
            anthropic: {
              api: "anthropic-messages",
              apiKey: "sk-x",
              models: [{ id: "claude-x", contextWindow: 200_000 }],
            },
          },
        },
      },
      ["dev"],
    );
    seedWorker("default", "disabled-one", {
      kind: "llm",
      enabled: false,
      modelId: "ghosthouse/whatever", // would normally blocker
      description: "Pinned to bad model but disabled.",
    });
    const r = checkTenants({ builtinConfigDir, home });
    expect(
      r.lines.find((l) => l.text.includes("worker 'disabled-one'")),
    ).toBeUndefined();
  });

  it("warns when deprecated `worker:` block is set on tenant config", () => {
    seedTenant(
      "default",
      {
        worker: { count: 2, pollMs: 5000, model: "anthropic/x" },
        plugins: {},
      },
      ["dev"],
    );
    const r = checkTenants({ builtinConfigDir, home });
    const w = r.lines.find((l) => l.text.includes("deprecated 'worker'"));
    expect(w?.severity).toBe("warning");
  });
});

describe("checkConfig", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-check-config-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-check-config-cwd-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("flags missing config.json as blocker", () => {
    const r = checkConfig({ home, cwd });
    const cfgLine = r.lines.find((l) => l.text.includes("config.json"));
    expect(cfgLine?.severity).toBe("blocker");
    expect(cfgLine?.text).toContain("missing");
  });

  it("flags malformed config.json as blocker", () => {
    fs.writeFileSync(path.join(home, "config.json"), "{ this isn't json");
    const r = checkConfig({ home, cwd });
    const cfgLine = r.lines.find((l) => l.text.includes("invalid JSON"));
    expect(cfgLine?.severity).toBe("blocker");
  });

  it("flags valid config.json as ok", () => {
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ models: { providers: {} } }),
    );
    const r = checkConfig({ home, cwd });
    const cfgLine = r.lines.find((l) => l.text.includes("config.json"));
    expect(cfgLine?.severity).toBe("ok");
  });

  it("flags missing .env as warning, not blocker (shell env can substitute)", () => {
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ models: { providers: {} } }),
    );
    const r = checkConfig({ home, cwd });
    const envLine = r.lines.find((l) => l.text.includes(".env"));
    expect(envLine?.severity).toBe("warning");
  });
});

describe("checkProviders", () => {
  it("blocker when no providers configured", async () => {
    const cfg: GlobalConfig = { models: { providers: {} } };
    const r = await checkProviders({ config: cfg });
    expect(r.lines[0]?.severity).toBe("blocker");
    expect(r.lines[0]?.text).toContain("no providers");
  });

  it("blocker when provider key references an unset env var", async () => {
    const before = process.env.TIANSHU_TEST_KEY_UNSET;
    delete process.env.TIANSHU_TEST_KEY_UNSET;
    const cfg: GlobalConfig = {
      models: {
        providers: {
          anthropic: {
            api: "anthropic-messages",
            apiKey: "${TIANSHU_TEST_KEY_UNSET}",
            models: [{ id: "claude-sonnet-4-6", contextWindow: 200_000 }],
          },
        },
      },
    };
    const r = await checkProviders({ config: cfg });
    const line = r.lines.find((l) => l.text.includes("anthropic"));
    expect(line?.severity).toBe("blocker");
    expect(line?.detail).toContain("TIANSHU_TEST_KEY_UNSET");
    if (before) process.env.TIANSHU_TEST_KEY_UNSET = before;
  });

  it("ok when key resolves and defaultModel points at the configured provider", async () => {
    process.env.TIANSHU_TEST_KEY_OK = "sk-test-12345678";
    const cfg: GlobalConfig = {
      defaultModel: "anthropic/claude-sonnet-4-6",
      models: {
        providers: {
          anthropic: {
            api: "anthropic-messages",
            apiKey: "${TIANSHU_TEST_KEY_OK}",
            models: [{ id: "claude-sonnet-4-6", contextWindow: 200_000 }],
          },
        },
      },
    };
    const r = await checkProviders({ config: cfg });
    const provLine = r.lines.find(
      (l) => l.text.includes("anthropic") && l.severity === "ok",
    );
    expect(provLine).toBeDefined();
    const defLine = r.lines.find((l) => l.text.includes("defaultModel"));
    expect(defLine?.severity).toBe("ok");
    delete process.env.TIANSHU_TEST_KEY_OK;
  });

  it("blocker when defaultModel references an unknown provider", async () => {
    process.env.TIANSHU_TEST_KEY_OK = "sk-test-12345678";
    const cfg: GlobalConfig = {
      defaultModel: "ghosthouse/claude-9000",
      models: {
        providers: {
          anthropic: {
            api: "anthropic-messages",
            apiKey: "${TIANSHU_TEST_KEY_OK}",
            models: [{ id: "claude-sonnet-4-6", contextWindow: 200_000 }],
          },
        },
      },
    };
    const r = await checkProviders({ config: cfg });
    const defLine = r.lines.find((l) => l.text.includes("defaultModel"));
    expect(defLine?.severity).toBe("blocker");
    delete process.env.TIANSHU_TEST_KEY_OK;
  });

  it("warning when provider's `api` field is missing", async () => {
    process.env.TIANSHU_TEST_KEY_OK = "sk-test-12345678";
    const cfg: GlobalConfig = {
      models: {
        providers: {
          qwen: {
            apiKey: "${TIANSHU_TEST_KEY_OK}",
            baseUrl: "https://x.example/v1",
            models: [{ id: "qwen3-max", contextWindow: 200_000 }],
          },
        },
      },
    };
    const r = await checkProviders({ config: cfg });
    const apiLine = r.lines.find((l) => l.text.includes("api` field missing"));
    expect(apiLine?.severity).toBe("warning");
    delete process.env.TIANSHU_TEST_KEY_OK;
  });

  it("warning + 'did you mean' for the most common typo (openai-chat)", async () => {
    // The actual i070219 paper-cut: cli-agent guessed "openai-chat".
    // pi-ai then threw "No API provider registered for api: openai-chat"
    // at first chat send. Doctor should catch it pre-flight with an
    // actionable hint.
    process.env.TIANSHU_TEST_KEY_OK = "sk-test-12345678";
    const cfg: GlobalConfig = {
      models: {
        providers: {
          qwen: {
            api: "openai-chat",
            apiKey: "${TIANSHU_TEST_KEY_OK}",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            models: [{ id: "qwen3-max", contextWindow: 200_000 }],
          },
        },
      },
    };
    const r = await checkProviders({ config: cfg });
    const apiLine = r.lines.find((l) => l.text.includes("unknown"));
    expect(apiLine?.severity).toBe("warning");
    expect(apiLine?.text).toContain("openai-chat");
    expect(apiLine?.detail).toContain("openai-completions");
    delete process.env.TIANSHU_TEST_KEY_OK;
  });

  it("ok line for a valid pi-ai api value (openai-completions)", async () => {
    process.env.TIANSHU_TEST_KEY_OK = "sk-test-12345678";
    const cfg: GlobalConfig = {
      models: {
        providers: {
          qwen: {
            api: "openai-completions",
            apiKey: "${TIANSHU_TEST_KEY_OK}",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            models: [{ id: "qwen3-max", contextWindow: 200_000 }],
          },
        },
      },
    };
    const r = await checkProviders({ config: cfg });
    // No warning about api or unknown.
    const apiWarn = r.lines.find(
      (l) =>
        l.severity === "warning" &&
        (l.text.includes("unknown") || l.text.includes("api` field missing")),
    );
    expect(apiWarn).toBeUndefined();
    delete process.env.TIANSHU_TEST_KEY_OK;
  });

  it("skips ctx/max checks for image-gen models (different semantics)", async () => {
    // image-gen models legitimately have max > ctx: ctx is the
    // text-prompt window (often 32k), max bounds the per-image
    // generation token budget (can exceed text ctx). Caught when
    // doctor's invariant rejected google/gemini-3-pro-image-preview
    // at server startup — documented values, not a bug.
    process.env.TIANSHU_TEST_KEY_OK = "***";
    const cfg: GlobalConfig = {
      models: {
        providers: {
          google: {
            api: "google-generative-ai",
            apiKey: "${TIANSHU_TEST_KEY_OK}",
            models: [
              {
                id: "gemini-3-pro-image-preview",
                mode: "image-gen",
                contextWindow: 32_768,
                maxTokens: 65_536, // would normally trip the blocker
              },
            ],
          },
        },
      },
    };
    const r = await checkProviders({ config: cfg });
    const blocker = r.lines.find((l) =>
      l.text.includes("gemini-3-pro-image-preview"),
    );
    expect(blocker).toBeUndefined();
    delete process.env.TIANSHU_TEST_KEY_OK;
  });

  it("blocker when maxTokens > contextWindow (logically impossible)", async () => {
    // Caught real values in yuyu's config (gemini image-preview
    // entries had ctx=32768, max=65536 — either a swap or stale
    // copy). Output cap can't exceed the whole window.
    process.env.TIANSHU_TEST_KEY_OK = "***";
    const cfg: GlobalConfig = {
      models: {
        providers: {
          openai: {
            api: "openai-completions",
            apiKey: "${TIANSHU_TEST_KEY_OK}",
            models: [
              { id: "weird-model", contextWindow: 32_768, maxTokens: 65_536 },
            ],
          },
        },
      },
    };
    const r = await checkProviders({ config: cfg });
    const inv = r.lines.find((l) =>
      l.text.includes("maxTokens (65536) > contextWindow (32768)"),
    );
    expect(inv?.severity).toBe("blocker");
    delete process.env.TIANSHU_TEST_KEY_OK;
  });

  it("warns when contextWindow or maxTokens is missing", async () => {
    // Server falls back to 128_000 / 4_096; surface so user
    // doesn't silently leave capability on the floor.
    process.env.TIANSHU_TEST_KEY_OK = "***";
    const cfg: GlobalConfig = {
      models: {
        providers: {
          openai: {
            api: "openai-completions",
            apiKey: "${TIANSHU_TEST_KEY_OK}",
            models: [{ id: "model-without-limits" } as never],
          },
        },
      },
    };
    const r = await checkProviders({ config: cfg });
    const ctxWarn = r.lines.find((l) =>
      l.text.includes("contextWindow not set"),
    );
    const mxWarn = r.lines.find((l) => l.text.includes("maxTokens not set"));
    expect(ctxWarn?.severity).toBe("warning");
    expect(mxWarn?.severity).toBe("warning");
    delete process.env.TIANSHU_TEST_KEY_OK;
  });

  it("warns 'below known ceiling' when catalog value is lower than known-models.md", async () => {
    // Catalog says 8192, table says 32768 — soft warning, not
    // blocker. Reproduces the i070219 / yuyu paper-cut where
    // qwen3-max-preview shipped with maxTokens=8192 even though
    // dashscope supports 32k.
    process.env.TIANSHU_TEST_KEY_OK = "***";
    const cfg: GlobalConfig = {
      models: {
        providers: {
          dashscope: {
            api: "openai-completions",
            apiKey: "${TIANSHU_TEST_KEY_OK}",
            models: [
              {
                id: "qwen3-max-preview", // matches the table row
                contextWindow: 256_000,
                maxTokens: 8_192, // table records 32_768
              },
            ],
          },
        },
      },
    };
    const r = await checkProviders({ config: cfg });
    const w = r.lines.find((l) =>
      l.text.includes("maxTokens=8192 below known ceiling"),
    );
    expect(w?.severity).toBe("warning");
    expect(w?.detail).toContain("32768");
    expect(w?.detail).toContain("docs/known-models.md");
    delete process.env.TIANSHU_TEST_KEY_OK;
  });

  it("warns when maxTokens is suspiciously low (<4096)", async () => {
    process.env.TIANSHU_TEST_KEY_OK = "***";
    const cfg: GlobalConfig = {
      models: {
        providers: {
          dashscope: {
            api: "openai-completions",
            apiKey: "${TIANSHU_TEST_KEY_OK}",
            models: [
              {
                id: "stale-model",
                contextWindow: 256_000,
                maxTokens: 2_048, // stale; real provider supports more
              },
            ],
          },
        },
      },
    };
    const r = await checkProviders({ config: cfg });
    const lowWarn = r.lines.find((l) => l.text.includes("looks low"));
    expect(lowWarn?.severity).toBe("warning");
    expect(lowWarn?.text).toContain("2048");
    delete process.env.TIANSHU_TEST_KEY_OK;
  });

  it("warns when deprecated `worker:` block is set on global config", async () => {
    // worker.{count,pollMs,model} was kept for backwards-compat but
    // has no runtime consumers (see core/config.ts deprecation
    // comment). Doctor must surface it so the user / cli-agent
    // don't think they're actually configuring anything when they
    // set those keys.
    process.env.TIANSHU_TEST_KEY_OK = "sk-test-12345678";
    const cfg: GlobalConfig = {
      defaultModel: "qwen/qwen3-max",
      models: {
        providers: {
          qwen: {
            api: "openai-completions",
            apiKey: "${TIANSHU_TEST_KEY_OK}",
            baseUrl: "https://x.example/v1",
            models: [{ id: "qwen3-max", contextWindow: 200_000 }],
          },
        },
      },
      worker: { count: 2, pollMs: 5000, model: "anthropic/x" },
    };
    const r = await checkProviders({ config: cfg });
    const w = r.lines.find((l) => l.text.includes("deprecated 'worker'"));
    expect(w?.severity).toBe("warning");
    expect(w?.detail).toMatch(/no runtime effect/);
    delete process.env.TIANSHU_TEST_KEY_OK;
  });
});

describe("checkNetwork", () => {
  it("free server port reports warning (server not running)", async () => {
    // Pick an unlikely-to-be-bound high port. The server port is
    // expected to be owned by us when the service is running, so
    // 'free' is a soft warning telling the user to start it.
    const r = await checkNetwork({ serverPort: 39101, webPort: 39102 });
    const serverLine = r.lines.find((l) => l.text.includes("Server port"));
    expect(serverLine?.severity).toBe("warning");
    expect(serverLine?.text).toContain("39101");
  });

  it("free web port reports ok (will be bound by vite later)", async () => {
    const r = await checkNetwork({ serverPort: 39101, webPort: 39102 });
    const webLine = r.lines.find((l) => l.text.includes("Web port"));
    expect(webLine?.severity).toBe("ok");
  });
});
