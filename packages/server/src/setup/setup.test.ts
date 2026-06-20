import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectDoctorReport, runQuickReadinessCheck } from "./doctor.js";
import { runSetupWizard } from "./wizard.js";

describe("collectDoctorReport", () => {
  it("returns groups + tally", async () => {
    const r = await collectDoctorReport();
    expect(r.groups.length).toBeGreaterThanOrEqual(5);
    expect(r.ok + r.warning + r.blocker).toBeGreaterThan(0);
  });

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
  });
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

  it("writes config.json and .env when given a known provider", async () => {
    const res = await runSetupWizard({
      nonInteractive: true,
      provider: "anthropic",
      apiKey: "sk-test-key-1234567890",
      home,
      cwd,
    });
    expect(res.wroteConfig).toBe(true);
    expect(res.wroteEnv).toBe(true);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(home, "config.json"), "utf8"),
    );
    expect(cfg.defaultModel).toBe("anthropic/claude-sonnet-4-6");
    expect(cfg.models.providers.anthropic).toBeDefined();
    expect(cfg.models.providers.anthropic.apiKey).toContain("ANTH…_KEY");
    const env = fs.readFileSync(path.join(cwd, ".env"), "utf8");
    expect(env).toMatch(/ANTH…_KEY=sk-test-key-1234567890/);
  });

  it("writes a custom baseUrl when --base-url is supplied", async () => {
    await runSetupWizard({
      nonInteractive: true,
      provider: "anthropic",
      apiKey: "sk-tes…vy-1234567890",
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

  it("adds a custom default model id to the models list when not in profile", async () => {
    await runSetupWizard({
      nonInteractive: true,
      provider: "openai",
      apiKey: "sk-tes…vy-1234567890",
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
    expect(ids).toContain("llama-3.1-8b-on-vllm");
    // Original profile models still present so the picker UI can
    // offer them later.
    expect(ids).toContain("gpt-5");
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

  it("preserves other lines in an existing .env when adding a new key", async () => {
    fs.writeFileSync(path.join(cwd, ".env"), "EXISTING_VAR=hello\n");
    await runSetupWizard({
      nonInteractive: true,
      provider: "anthropic",
      apiKey: "sk-new-key",
      home,
      cwd,
    });
    const env = fs.readFileSync(path.join(cwd, ".env"), "utf8");
    expect(env).toMatch(/EXISTING_VAR=hello/);
    expect(env).toMatch(/ANTH…_KEY=sk-new-key/);
  });

  it("replaces an existing key line rather than appending a duplicate", async () => {
    fs.writeFileSync(
      path.join(cwd, ".env"),
      "ANTH…_KEY=old-value\nOTHER=keep\n",
    );
    await runSetupWizard({
      nonInteractive: true,
      provider: "anthropic",
      apiKey: "new-value",
      home,
      cwd,
    });
    const env = fs.readFileSync(path.join(cwd, ".env"), "utf8");
    const matches = env.match(/^ANTH…_KEY=/gm) ?? [];
    expect(matches.length).toBe(1);
    expect(env).toMatch(/ANTH…_KEY=new-value/);
    expect(env).toMatch(/OTHER=keep/);
  });
});
