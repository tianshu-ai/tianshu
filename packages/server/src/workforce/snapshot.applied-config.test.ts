// Regression: the Workforce Studio Reality view (and the `current`
// live mirror that feeds diffs) must read the SAME applied-solution
// config the live chat path reads — main-agent.json + sidecars and
// each worker's execution-bias override. Before this fix snapshot.ts
// ignored those files, so applying a solution changed the running
// agent but the studio kept showing host defaults → permanent phantom
// drift in the diff ("active solution writes files, live solution
// doesn't read them").
//
// These tests apply config the way `applySolution` does (writing the
// on-disk shape directly, no registry needed) and assert the snapshot
// blocks / skill+tool surface reflect it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { TenantContext } from "../core/index.js";
import type { PluginRegistry } from "../core/plugins/registry.js";
import { getTenantConfigDir, getTenantMainConfigDir } from "../core/paths.js";
import { buildWorkforceSnapshot } from "./snapshot.js";

// Minimal registry stub: the snapshot only consumes these five
// read methods. Everything returns empty so the test isolates the
// applied-config wiring rather than exercising real plugins.
function stubRegistry(): PluginRegistry {
  return {
    listForTenant: () => [],
    toolCatalogForTenant: () => [],
    toolsForTenant: () => [],
    mirroredSkillsForTenant: () => [],
    systemPromptFragmentsForTenant: () => [],
  } as unknown as PluginRegistry;
}

function fakeCtx(home: string): TenantContext {
  const workspaceDir = path.join(home, "workspace");
  return {
    tenantId: "acme",
    home,
    workspaceDir,
    userHomeDir: () => path.join(workspaceDir, "users", "u1"),
    config: { branding: { name: "Tianshu" }, defaultModel: null },
  } as unknown as TenantContext;
}

function build(ctx: TenantContext) {
  return buildWorkforceSnapshot({
    ctx,
    userId: "u1",
    pluginRegistry: stubRegistry(),
    tianshuVersion: "0.0.0-test",
  });
}

function blockText(
  blocks: { kind: string; text: string }[],
  kind: string,
): string | undefined {
  return blocks.find((b) => b.kind === kind)?.text;
}

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ts-snap-applied-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("buildWorkforceSnapshot — applied main-agent config", () => {
  it("no applied config → host-default execution-bias, no tenant-prompt block", () => {
    const ctx = fakeCtx(home);
    const snap = build(ctx);
    const eb = blockText(snap.main.blocks, "execution-bias");
    expect(eb).toContain("## Execution Bias");
    expect(eb).toContain("Actionable request: act in this turn.");
    expect(blockText(snap.main.blocks, "tenant-prompt")).toBeUndefined();
    expect(blockText(snap.main.blocks, "custom-fragment")).toBeUndefined();
  });

  it("reflects override sidecars + tenant prompt + custom fragment", () => {
    const ctx = fakeCtx(home);
    const mainDir = getTenantMainConfigDir("acme", home);
    fs.mkdirSync(path.join(mainDir, "fragments"), { recursive: true });
    fs.writeFileSync(
      path.join(mainDir, "execution-bias.md"),
      "## Execution Bias\nMARKER-EB: be relentless.",
      "utf8",
    );
    fs.writeFileSync(
      path.join(mainDir, "reply-style.md"),
      "MARKER-REPLY: speak in haiku.",
      "utf8",
    );
    fs.writeFileSync(
      path.join(mainDir, "user-onboarding.md"),
      "MARKER-ONBOARD: skip the intro.",
      "utf8",
    );
    fs.writeFileSync(
      path.join(mainDir, "prompt.md"),
      "MARKER-TENANT: company voice rules.",
      "utf8",
    );
    fs.writeFileSync(
      path.join(mainDir, "fragments", "house-style.md"),
      "MARKER-FRAG: always cite sources.",
      "utf8",
    );
    fs.writeFileSync(
      path.join(mainDir, "main-agent.json"),
      JSON.stringify({
        schema: "tianshu.main-agent.v1",
        tenantPromptPath: "prompt.md",
        overrides: {
          executionBias: "execution-bias.md",
          replyStyle: "reply-style.md",
          userOnboarding: "user-onboarding.md",
        },
        customFragments: [
          { id: "house-style", title: "House style", path: "fragments/house-style.md" },
        ],
        skillsDeny: [],
        toolsDeny: [],
      }),
      "utf8",
    );

    const snap = build(ctx);
    const blocks = snap.main.blocks;
    expect(blockText(blocks, "execution-bias")).toContain("MARKER-EB");
    expect(blockText(blocks, "reply-style")).toContain("MARKER-REPLY");
    expect(blockText(blocks, "user-onboarding")).toContain("MARKER-ONBOARD");
    expect(blockText(blocks, "tenant-prompt")).toContain("MARKER-TENANT");
    expect(blockText(blocks, "custom-fragment")).toContain("MARKER-FRAG");

    // Rendered prompt must carry the same overrides (it's what the
    // model actually sees — this is the whole point of the fix).
    expect(snap.main.systemPrompt).toContain("MARKER-EB");
    expect(snap.main.systemPrompt).toContain("MARKER-TENANT");
    expect(snap.main.systemPrompt).toContain("MARKER-FRAG");
    expect(snap.main.systemPrompt).not.toContain(
      "Actionable request: act in this turn.",
    );
  });
});

describe("buildWorkforceSnapshot — worker execution-bias override", () => {
  it("worker with override sidecar → uses override text, not host default", () => {
    const ctx = fakeCtx(home);
    const wDir = path.join(getTenantConfigDir("acme", home), "workers", "researcher");
    fs.mkdirSync(wDir, { recursive: true });
    fs.writeFileSync(
      path.join(wDir, "agent.json"),
      JSON.stringify({
        kind: "llm",
        overrides: { executionBias: "execution-bias.md" },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(wDir, "execution-bias.md"),
      "## Execution Bias\nWORKER-MARKER: triple-check sources.",
      "utf8",
    );

    const snap = build(ctx);
    const worker = snap.workers.find((w) => w.slug === "researcher");
    expect(worker).toBeDefined();
    expect(blockText(worker!.blocks, "execution-bias")).toContain(
      "WORKER-MARKER: triple-check sources.",
    );
  });

  it("worker without override → host-default execution-bias", () => {
    const ctx = fakeCtx(home);
    const wDir = path.join(getTenantConfigDir("acme", home), "workers", "plain");
    fs.mkdirSync(wDir, { recursive: true });
    fs.writeFileSync(
      path.join(wDir, "agent.json"),
      JSON.stringify({ kind: "llm" }),
      "utf8",
    );

    const snap = build(ctx);
    const worker = snap.workers.find((w) => w.slug === "plain");
    expect(worker).toBeDefined();
    expect(blockText(worker!.blocks, "execution-bias")).toContain(
      "Actionable request: act in this turn.",
    );
  });
});

// Regression for the `current` live-mirror extract path
// (specFromReality), which is SEPARATE from buildWorkforceSnapshot:
// it must also read main-agent.json, else the `current` solution
// shows host defaults even when an override is applied+active
// (the tenant-prompt-shows-workspace-context bug Yu hit).
describe("extractSolution (current mirror) — applied main-agent config", () => {
  function writeMainConfig(ctx: TenantContext) {
    const dir = getTenantMainConfigDir(ctx.tenantId, ctx.home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "prompt.md"), "OVERRIDDEN TENANT PROMPT");
    fs.writeFileSync(
      path.join(dir, "main-agent.json"),
      JSON.stringify({
        schema: "tianshu.main-agent.v1",
        tenantPromptPath: "prompt.md",
        overrides: {
          executionBias: null,
          replyStyle: null,
          userOnboarding: null,
        },
        customFragments: [],
        skillsDeny: ["meme-maker"],
        toolsDeny: ["channel_send_file"],
      }),
    );
  }

  it("current tenantPrompt = applied override, not workspace context", async () => {
    const ctx = fakeCtx(home);
    writeMainConfig(ctx);
    const { extractSolution } = await import("./solutions.js");
    const detail = extractSolution(
      { ctx, pluginRegistry: stubRegistry(), tianshuVersion: "0.0.0-test" },
      "u1",
      { slug: "current", name: "Current", description: "" },
    );
    expect(detail.tenantPrompt).toBe("OVERRIDDEN TENANT PROMPT");
    expect(detail.spec.mainAgent.skillsDeny).toContain("meme-maker");
    expect(detail.spec.mainAgent.toolsDeny).toContain("channel_send_file");
  });

  it("current with no applied config falls back to workspace context", async () => {
    const ctx = fakeCtx(home);
    const { extractSolution } = await import("./solutions.js");
    const detail = extractSolution(
      { ctx, pluginRegistry: stubRegistry(), tianshuVersion: "0.0.0-test" },
      "u1",
      { slug: "current", name: "Current", description: "" },
    );
    // No override applied → deny lists empty (host-default surface).
    expect(detail.spec.mainAgent.skillsDeny).toEqual([]);
    expect(detail.spec.mainAgent.toolsDeny).toEqual([]);
  });
});
