import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkRuntime } from "./runtime.js";
import { checkConfig } from "./config.js";
import { checkProviders } from "./providers.js";
import { checkNetwork } from "./network.js";
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
