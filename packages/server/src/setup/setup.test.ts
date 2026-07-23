import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectDoctorReport, runQuickReadinessCheck } from "./doctor.js";
import { runSetupWizard } from "./wizard.js";

describe("collectDoctorReport", () => {
  // collectDoctorReport() runs real environment probes (filesystem,
  // config, optional network reachability). On loaded CI runners those
  // occasionally exceed vitest's default 5s and flake the whole suite
  // (locally it's ~500ms). Give these two an explicit generous timeout
  // so a slow runner doesn't red a PR that has nothing to do with the
  // doctor. See PR #284 CI flake, 2026-07-10.
  const DOCTOR_TIMEOUT_MS = 30_000;

  it("returns groups + tally", async () => {
    const r = await collectDoctorReport();
    expect(r.groups.length).toBeGreaterThanOrEqual(5);
    expect(r.ok + r.warning + r.blocker).toBeGreaterThan(0);
  }, DOCTOR_TIMEOUT_MS);

  it("tally counts each line's severity correctly", async () => {
    const r = await collectDoctorReport();
    let ok = 0;
    let warning = 0;
    let blocker = 0;
    for (const g of r.groups) {
      for (const l of g.lines) {
        if (l.severity === "ok") ok++;
        else if (l.severity === "warning") warning++;
        else blocker++;
      }
    }
    expect(r.ok).toBe(ok);
    expect(r.warning).toBe(warning);
    expect(r.blocker).toBe(blocker);
  }, DOCTOR_TIMEOUT_MS);
});

describe("runQuickReadinessCheck", () => {
  const savedHome = process.env.TIANSHU_HOME;

  afterEach(() => {
    if (savedHome === undefined) delete process.env.TIANSHU_HOME;
    else process.env.TIANSHU_HOME = savedHome;
  });

  it("returns ok=false when config.json is missing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-readiness-"));
    process.env.TIANSHU_HOME = tmp;
    try {
      const r = await runQuickReadinessCheck();
      expect(r.ok).toBe(false);
      expect(r.blockers.length).toBeGreaterThan(0);
      // Either Config or Providers carries the blocker; both are valid.
      const titles = r.blockers.map((b) => b.title);
      expect(titles.some((t) => /Config|Providers/.test(t))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns ok=true when a valid provider config exists", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-readiness-ok-"));
    process.env.TIANSHU_HOME = tmp;
    process.env.TIANSHU_RD_TEST_KEY = "sk-test-key-1234567890";
    try {
      fs.writeFileSync(
        path.join(tmp, "config.json"),
        JSON.stringify({
          defaultModel: "anthropic/sonnet",
          models: {
            providers: {
              anthropic: {
                api: "anthropic-messages",
                apiKey: "${TIANSHU_RD_TEST_KEY}",
                models: [{ id: "sonnet", contextWindow: 200_000 }],
              },
            },
          },
        }),
      );
      const r = await runQuickReadinessCheck();
      expect(r.ok).toBe(true);
      expect(r.blockers).toEqual([]);
    } finally {
      delete process.env.TIANSHU_RD_TEST_KEY;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("runSetupWizard non-interactive", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-wizard-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-wizard-cwd-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("writes the literal API key into config.json by default (no .env)", async () => {
    const res = await runSetupWizard({
      nonInteractive: true,
      provider: "anthropic",
      apiKey: "sk-test-key-1234567890",
      home,
      cwd,
    });
    expect(res.wroteConfig).toBe(true);
    // Default mode no longer touches .env — the key lands in
    // config.json directly. wroteEnv must be false to surface
    // that distinction in the wizard's notes.
    expect(res.wroteEnv).toBe(false);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(home, "config.json"), "utf8"),
    );
    expect(cfg.defaultModel).toBe("anthropic/claude-sonnet-4-6");
    expect(cfg.models.providers.anthropic).toBeDefined();
    // Literal key, not a placeholder.
    expect(cfg.models.providers.anthropic.apiKey).toBe(
      "sk-test-key-1234567890",
    );
    // .env should not have been created.
    expect(fs.existsSync(path.join(cwd, ".env"))).toBe(false);
    // Confirm chmod 600 on the config file (key in plaintext).
    const stat = fs.statSync(path.join(home, "config.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("--use-env keeps the legacy placeholder + .env path", async () => {
    const res = await runSetupWizard({
      nonInteractive: true,
      provider: "anthropic",
      apiKey: "sk-test-key-1234567890",
      useEnv: true,
      home,
      cwd,
    });
    expect(res.wroteConfig).toBe(true);
    expect(res.wroteEnv).toBe(true);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(home, "config.json"), "utf8"),
    );
    // Placeholder, not literal.
    expect(cfg.models.providers.anthropic.apiKey).toBe(
      "${ANTHROPIC_API_KEY}",
    );
    const env = fs.readFileSync(path.join(cwd, ".env"), "utf8");
    expect(env).toMatch(/ANTHROPIC_API_KEY=sk-test-key-1234567890/);
  });

  it("writes a custom baseUrl when --base-url is supplied", async () => {
    await runSetupWizard({
      nonInteractive: true,
      provider: "anthropic",
      apiKey: "sk-test-key-1234567890",
      baseUrl: "https://my-corp-gateway.example.com/anthropic",
      home,
      cwd,
    });
    const cfg = JSON.parse(
      fs.readFileSync(path.join(home, "config.json"), "utf8"),
    );
    expect(cfg.models.providers.anthropic.baseUrl).toBe(
      "https://my-corp-gateway.example.com/anthropic",
    );
    // Vendor default unaffected for unrelated providers.
    expect(cfg.models.providers.anthropic.api).toBe("anthropic-messages");
  });

  it("writes only the chosen model — not the profile's other presets", async () => {
    await runSetupWizard({
      nonInteractive: true,
      provider: "openai",
      apiKey: "sk-test-key-1234567890",
      defaultModel: "openai/llama-3.1-8b-on-vllm",
      home,
      cwd,
    });
    const cfg = JSON.parse(
      fs.readFileSync(path.join(home, "config.json"), "utf8"),
    );
    expect(cfg.defaultModel).toBe("openai/llama-3.1-8b-on-vllm");
    const ids = cfg.models.providers.openai.models.map(
      (m: { id: string }) => m.id,
    );
    // Only the chosen model lands in config — no gpt-5 / gpt-5-mini
    // clutter. The user adds more later in Settings → Models.
    expect(ids).toEqual(["llama-3.1-8b-on-vllm"]);
  });

  it("writes only the chosen model for a vendor default too (no extra presets)", async () => {
    await runSetupWizard({
      nonInteractive: true,
      provider: "openai",
      apiKey: "sk-test-key-1234567890",
      home,
      cwd,
    });
    const cfg = JSON.parse(
      fs.readFileSync(path.join(home, "config.json"), "utf8"),
    );
    const ids = cfg.models.providers.openai.models.map(
      (m: { id: string }) => m.id,
    );
    // Default model is openai/gpt-5; gpt-5-mini must NOT be seeded.
    expect(ids).toEqual(["gpt-5"]);
  });

  it("respects --dry-run by not writing files", async () => {
    const res = await runSetupWizard({
      nonInteractive: true,
      provider: "openai",
      apiKey: "sk-test",
      home,
      cwd,
      dryRun: true,
    });
    expect(res.wroteConfig).toBe(true); // semantically queued
    expect(fs.existsSync(path.join(home, "config.json"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, ".env"))).toBe(false);
  });

  it("preserves an existing config.json without --force", async () => {
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ marker: "preexisting" }),
    );
    const res = await runSetupWizard({
      nonInteractive: true,
      provider: "google",
      apiKey: "sk-google",
      home,
      cwd,
    });
    expect(res.wroteConfig).toBe(false);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(home, "config.json"), "utf8"),
    );
    expect(cfg.marker).toBe("preexisting");
  });

  it("rejects --non-interactive without --provider", async () => {
    await expect(
      runSetupWizard({ nonInteractive: true, home, cwd }),
    ).rejects.toThrow(/--provider/);
  });

  it("--provider=openai-compatible writes under the openai provider with the given baseUrl + model", async () => {
    await runSetupWizard({
      nonInteractive: true,
      provider: "openai-compatible",
      apiKey: "sk-das…7890",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      defaultModel: "openai/qwen-plus",
      home,
      cwd,
    });
    const cfg = JSON.parse(
      fs.readFileSync(path.join(home, "config.json"), "utf8"),
    );
    // Lands under the real "openai" provider (shared driver), not a
    // separate "openai-compatible" key.
    expect(cfg.models.providers["openai-compatible"]).toBeUndefined();
    const oc = cfg.models.providers.openai;
    expect(oc.api).toBe("openai-completions");
    expect(oc.baseUrl).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    );
    expect(oc.apiKey).toBe("sk-das…7890");
    expect(cfg.defaultModel).toBe("openai/qwen-plus");
    const ids = oc.models.map((m: { id: string }) => m.id);
    expect(ids).toContain("qwen-plus");
  });

  it("--use-env preserves other lines in an existing .env when adding a new key", async () => {
    fs.writeFileSync(path.join(cwd, ".env"), "EXISTING_VAR=hello\n");
    await runSetupWizard({
      nonInteractive: true,
      provider: "anthropic",
      apiKey: "sk-new-key",
      useEnv: true,
      home,
      cwd,
    });
    const env = fs.readFileSync(path.join(cwd, ".env"), "utf8");
    expect(env).toMatch(/EXISTING_VAR=hello/);
    expect(env).toMatch(/ANTHROPIC_API_KEY=sk-new-key/);
  });

  it("--use-env replaces an existing key line rather than appending a duplicate", async () => {
    fs.writeFileSync(
      path.join(cwd, ".env"),
      "ANTHROPIC_API_KEY=old-value\nOTHER=keep\n",
    );
    await runSetupWizard({
      nonInteractive: true,
      provider: "anthropic",
      apiKey: "new-value",
      useEnv: true,
      home,
      cwd,
    });
    const env = fs.readFileSync(path.join(cwd, ".env"), "utf8");
    const matches = env.match(/^ANTHROPIC_API_KEY=/gm) ?? [];
    expect(matches.length).toBe(1);
    expect(env).toMatch(/ANTHROPIC_API_KEY=new-value/);
    expect(env).toMatch(/OTHER=keep/);
  });

  it("default mode does not write .env even if one already exists", async () => {
    // Pre-existing .env should be left untouched in default mode.
    // (Users with existing .env files shouldn't be silently
    // mixed into the new config-only flow.)
    fs.writeFileSync(path.join(cwd, ".env"), "EXISTING_VAR=hello\n");
    const res = await runSetupWizard({
      nonInteractive: true,
      provider: "anthropic",
      apiKey: "sk-default-mode",
      home,
      cwd,
    });
    expect(res.wroteEnv).toBe(false);
    const env = fs.readFileSync(path.join(cwd, ".env"), "utf8");
    expect(env).toBe("EXISTING_VAR=hello\n"); // unchanged
    const cfg = JSON.parse(
      fs.readFileSync(path.join(home, "config.json"), "utf8"),
    );
    expect(cfg.models.providers.anthropic.apiKey).toBe("sk-default-mode");
  });
});
