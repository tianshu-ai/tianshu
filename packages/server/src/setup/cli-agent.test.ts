// Focused tests on cli-agent's config_write tool. The bulk of the
// agent surface (LLM loop, harness wiring, tool registry shape) is
// exercised by the end-to-end wizard test; these tests pin the
// global/tenant scope handling that landed 2026-06-21, because the
// behaviour is easy to break silently and the wizard test doesn't
// touch this code path.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTools } from "./cli-agent.js";

describe("cli-agent.config_write", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-cli-agent-cw-"));
    fs.mkdirSync(path.join(home, "tenants", "alpha"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ autoCreateDefault: true, defaultModel: "anthropic/x" }),
    );
    fs.writeFileSync(
      path.join(home, "tenants", "alpha", "config.json"),
      "{}",
    );
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function getConfigWrite() {
    const tools = buildTools(home, undefined);
    const t = tools.config_write;
    if (!t) throw new Error("config_write tool not registered");
    return t.execute;
  }

  it("which='global' patches ~/.tianshu/config.json shallow-merge", async () => {
    const r = await getConfigWrite()({
      which: "global",
      patch: { defaultModel: "qwen/qwen3-max-preview" },
    });
    const parsed = JSON.parse(r);
    expect(parsed.which).toBe("global");
    expect(parsed.patched).toEqual(["defaultModel"]);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(home, "config.json"), "utf8"),
    );
    expect(cfg.defaultModel).toBe("qwen/qwen3-max-preview");
    // shallow merge preserves unrelated keys
    expect(cfg.autoCreateDefault).toBe(true);
  });

  it("which='tenant' patches the tenant's config.json", async () => {
    const r = await getConfigWrite()({
      which: "tenant",
      tenantId: "alpha",
      patch: { plugins: { files: { enabled: true } } },
    });
    const parsed = JSON.parse(r);
    expect(parsed.which).toBe("tenant");
    expect(parsed.tenantId).toBe("alpha");
    const cfg = JSON.parse(
      fs.readFileSync(path.join(home, "tenants", "alpha", "config.json"), "utf8"),
    );
    expect(cfg.plugins.files.enabled).toBe(true);
  });

  it("which='tenant' without tenantId returns an error result (does not throw)", async () => {
    const r = await getConfigWrite()({
      which: "tenant",
      patch: { plugins: {} },
    });
    expect(JSON.parse(r)).toMatchObject({ error: "missing_tenant_id" });
  });

  it("which='tenant' with a global-only field returns tenant_forbidden_field", async () => {
    // server.port is in GlobalOnlyConfig; assertOnlyOverridable rejects it
    // when sourced from a tenant config. The tool catches the throw and
    // turns it into a result so the agent can read+react instead of
    // crashing the run.
    const r = await getConfigWrite()({
      which: "tenant",
      tenantId: "alpha",
      patch: { server: { port: 9999 } },
    });
    const parsed = JSON.parse(r);
    expect(parsed.error).toBe("tenant_forbidden_field");
    expect(parsed.hint).toMatch(/which='global'/);
    // Tenant config must remain unchanged.
    const cfg = JSON.parse(
      fs.readFileSync(path.join(home, "tenants", "alpha", "config.json"), "utf8"),
    );
    expect(cfg).toEqual({});
  });

  it("backward compat: omitting `which` defaults to tenant (legacy callers)", async () => {
    // The pre-2026-06-21 signature was {tenantId, patch} with no which.
    // We keep that working so old agent runs / saved tool calls don't break.
    const r = await getConfigWrite()({
      tenantId: "alpha",
      patch: { defaultModel: "qwen/x" },
    });
    const parsed = JSON.parse(r);
    expect(parsed.which).toBe("tenant");
    const cfg = JSON.parse(
      fs.readFileSync(path.join(home, "tenants", "alpha", "config.json"), "utf8"),
    );
    expect(cfg.defaultModel).toBe("qwen/x");
  });
});

describe("cli-agent.sandbox_inventory", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-cli-agent-si-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("returns ok:false with no_server hint when serverUrl is undefined", async () => {
    // The wizard normally provides a serverUrl; when it doesn't
    // (server not yet started, or running in a degraded mode),
    // the tool must fail cleanly rather than throw — the agent
    // needs a structured signal to suggest `tianshu start`.
    const tools = buildTools(home, undefined);
    const t = tools.sandbox_inventory;
    expect(t).toBeDefined();
    const r = await t!.execute({});
    const parsed = JSON.parse(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("no_server");
    // The agent reads `hint` to know what to tell the user;
    // mention `tianshu start` so the chain of reasoning lands
    // on the right next step.
    expect(parsed.hint).toMatch(/tianshu start/);
  });

  it("is registered as a non-mutating tool (no CLI confirmation)", () => {
    // sandbox_inventory is read-only; if someone accidentally
    // flagged it `mutating: true` the wizard would prompt the
    // user every time the agent wanted to see what's installed,
    // which is the exact friction we're trying to eliminate.
    const tools = buildTools(home, undefined);
    const t = tools.sandbox_inventory;
    expect(t).toBeDefined();
    expect(t!.mutating).toBeFalsy();
  });
});
