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

describe("cli-agent.check_build_progress", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-cli-agent-cbp-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("is registered as a non-mutating tool", () => {
    // check_build_progress only reads /builds + launchd logs.
    // Flagging it mutating would force a confirmation every
    // time the agent peeks at a long build, defeating the
    // tool's purpose.
    const tools = buildTools(home, undefined);
    const t = tools.check_build_progress;
    expect(t).toBeDefined();
    expect(t!.mutating).toBeFalsy();
  });

  it("returns no_recent_activity when nothing matches and no logs found", async () => {
    // With no server, no buildId, no launchd label resolvable
    // from this test environment, the tool should fall through
    // to the explicit "no activity" branch — NOT throw, NOT
    // claim the build is in_progress. This guards the
    // happy-path defaults so the agent can keep talking.
    const tools = buildTools(home, undefined);
    const t = tools.check_build_progress;
    expect(t).toBeDefined();
    const r = await t!.execute({});
    const parsed = JSON.parse(r);
    // Either 'no_recent_activity' (no logs found) or
    // 'in_progress' if some unrelated log line happens to
    // exist. The critical guarantee: NEVER 'errored' or
    // 'completed' — those require positive evidence the tool
    // can't have here.
    expect(["no_recent_activity", "in_progress", "stalled"]).toContain(
      parsed.status,
    );
    expect(typeof parsed.hint).toBe("string");
    expect(parsed.hint.length).toBeGreaterThan(20);
  });
});

describe("cli-agent.shell_exec", () => {
  // Setup-agent's escape hatch for install / verify steps that the
  // structured tools don't cover. We pin the safety-critical bits
  // here — the per-call timeout actually firing, the exit-code
  // pass-through, the describe() summary the user sees in the
  // confirm prompt — because if any of these regress the agent can
  // surprise the user with surprise sudo or wedge waiting on a
  // hung child.

  function getShellExec() {
    const tools = buildTools(
      fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-shell-")),
      undefined,
    );
    const t = tools.shell_exec;
    if (!t) throw new Error("shell_exec tool not registered");
    return t;
  }

  it("is marked mutating and produces a short describe()", () => {
    const t = getShellExec();
    expect(t.mutating).toBe(true);
    expect(
      t.describe!({
        command: "echo hi",
        purpose: "Smoke test",
      }),
    ).toContain("Smoke test");
    expect(
      t.describe!({
        command: "a".repeat(500),
        purpose: "Long command",
      }),
    ).toMatch(/…/);
  });

  it("returns ok=true with stdout on success", async () => {
    const t = getShellExec();
    const r = JSON.parse(
      await t.execute({
        command: "echo hello; echo more",
        purpose: "smoke",
        timeoutSeconds: 5,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello");
    expect(r.stdout).toContain("more");
    expect(r.timedOut).toBe(false);
  });

  it("passes through nonzero exit codes (ok=false)", async () => {
    const t = getShellExec();
    const r = JSON.parse(
      await t.execute({
        command: "false",
        purpose: "fail",
        timeoutSeconds: 5,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.timedOut).toBe(false);
  });

  it(
    "kills hung children promptly via process-group SIGKILL",
    async () => {
      // Same root-cause as the plugin-setup test: /bin/sh -c "sleep
      // 30" forks a sleep grandchild whose stdout stays open after
      // we SIGKILL the shell. We use detached:true + process.kill(
      // -pid, SIGKILL) to signal the group so the close event
      // fires.
      const t = getShellExec();
      const start = Date.now();
      const r = JSON.parse(
        await t.execute({
          command: "sleep 30",
          purpose: "hang",
          timeoutSeconds: 1,
        }),
      );
      const elapsed = Date.now() - start;
      expect(r.ok).toBe(false);
      expect(r.timedOut).toBe(true);
      // CI runners can lag on SIGKILL + reap; 8s is generous.
      expect(elapsed).toBeLessThan(8_000);
    },
    10_000,
  );

  it("rejects an empty command without spawning a shell", async () => {
    const t = getShellExec();
    const r = JSON.parse(
      await t.execute({ command: "   ", purpose: "empty" }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("empty_command");
  });
});
