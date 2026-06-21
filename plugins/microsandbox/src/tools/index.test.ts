import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentToolContext, SandboxRunner, SandboxStatus } from "@tianshu-ai/plugin-sdk";
import {
  ExecTool,
  GetSandboxStatusTool,
  ResetSandboxTool,
  UpdateSandboxConfigTool,
} from "./index.js";

class FakeRunner implements SandboxRunner {
  readonly id = "test.main";
  readonly kind = "shell" as const;
  status_: SandboxStatus = { state: "ready", uptimeMs: 0 };
  execCalls: Array<{ command: string; workdir?: string; timeoutMs?: number }> = [];
  resetCount = 0;
  shutdownCount = 0;
  fakeExec: (req: {
    command: string;
    workdir?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
    aborted?: boolean;
  }> = async () => ({
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    durationMs: 1,
    timedOut: false,
  });
  async exec(req: {
    command: string;
    workdir?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) {
    this.execCalls.push(req);
    return this.fakeExec(req);
  }
  async readFile(): Promise<string> {
    return "";
  }
  async writeFile(): Promise<void> {}
  workspacePath(): string {
    return "/tmp";
  }
  async reset(): Promise<void> {
    this.resetCount++;
  }
  async shutdown(): Promise<void> {
    this.shutdownCount++;
  }
  async status(): Promise<SandboxStatus> {
    return this.status_;
  }
}

function makeCtx(opts: {
  runner?: FakeRunner;
  tenantHomeDir?: string;
  signal?: AbortSignal;
}): AgentToolContext {
  const runner = opts.runner;
  return {
    pluginId: "microsandbox",
    tenantId: "acme",
    userId: "user_x",
    capabilities: {
      get: <T = unknown>(name: string) =>
        (name === "sandbox.shell" ? runner : undefined) as T | undefined,
      has: (name: string) => name === "sandbox.shell" && !!runner,
    },
    userHomeDir: "/tmp/user",
    tenantHomeDir: opts.tenantHomeDir ?? "/tmp",
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    signal: opts.signal,
  };
}

describe("ExecTool.available()", () => {
  it("false when capability is absent", async () => {
    const v = await ExecTool.available!(makeCtx({}));
    expect(v).toBe(false);
  });
  it("true when runner is ready", async () => {
    const r = new FakeRunner();
    const v = await ExecTool.available!(makeCtx({ runner: r }));
    expect(v).toBe(true);
  });
  it("false when runner status is error", async () => {
    const r = new FakeRunner();
    r.status_ = { state: "error", uptimeMs: 0 };
    const v = await ExecTool.available!(makeCtx({ runner: r }));
    expect(v).toBe(false);
  });
});

describe("ExecTool.execute()", () => {
  it("clamps timeout above the 30-min cap", async () => {
    const r = new FakeRunner();
    await ExecTool.execute(
      { command: "echo x", timeout_ms: 99_999_999 },
      makeCtx({ runner: r }),
    );
    expect(r.execCalls[0]!.timeoutMs).toBe(30 * 60_000);
  });
  it("uses the 5-min default when timeout_ms is missing", async () => {
    const r = new FakeRunner();
    await ExecTool.execute({ command: "echo x" }, makeCtx({ runner: r }));
    expect(r.execCalls[0]!.timeoutMs).toBe(5 * 60_000);
  });
  it("respects an in-range timeout", async () => {
    const r = new FakeRunner();
    await ExecTool.execute(
      { command: "echo x", timeout_ms: 1234 },
      makeCtx({ runner: r }),
    );
    expect(r.execCalls[0]!.timeoutMs).toBe(1234);
  });

  it("defaults workdir to /workspace/users/<userId> so write_file + exec align", async () => {
    const r = new FakeRunner();
    await ExecTool.execute({ command: "pwd" }, makeCtx({ runner: r }));
    expect(r.execCalls[0]!.workdir).toBe("/workspace/users/user_x");
  });

  it("explicit workdir overrides the default", async () => {
    const r = new FakeRunner();
    await ExecTool.execute(
      { command: "ls", workdir: "/etc" },
      makeCtx({ runner: r }),
    );
    expect(r.execCalls[0]!.workdir).toBe("/etc");
  });
  it("truncates oversize stdout", async () => {
    const r = new FakeRunner();
    r.fakeExec = async () => ({
      exitCode: 0,
      stdout: "line\n".repeat(500),
      stderr: "",
      durationMs: 1,
      timedOut: false,
    });
    const out = (await ExecTool.execute({ command: "spew" }, makeCtx({ runner: r }))) as {
      truncated: boolean;
      stdout: string;
    };
    expect(out.truncated).toBe(true);
    expect(out.stdout.split("\n").length).toBeLessThanOrEqual(202);
  });
  it("returns ok=false on runner exception", async () => {
    const r = new FakeRunner();
    r.fakeExec = async () => {
      throw new Error("VM gone");
    };
    const out = (await ExecTool.execute(
      { command: "echo" },
      makeCtx({ runner: r }),
    )) as { ok: boolean; stderr: string };
    expect(out.ok).toBe(false);
    expect(out.stderr).toContain("VM gone");
  });

  it("forwards ctx.signal into runner.exec so the runner can bail early", async () => {
    const r = new FakeRunner();
    const ctl = new AbortController();
    await ExecTool.execute(
      { command: "echo x" },
      makeCtx({ runner: r, signal: ctl.signal }),
    );
    // The runner saw the same signal instance the ctx carried.
    expect(r.execCalls[0]!.signal).toBe(ctl.signal);
  });

  it("surfaces aborted=true when the runner reports the call was aborted", async () => {
    const r = new FakeRunner();
    r.fakeExec = async (req) => {
      // Simulate a runner that listened to req.signal and bailed.
      // Wait until the signal fires, then return an aborted result.
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) return resolve();
        req.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        exitCode: -1,
        stdout: "",
        stderr: "[microsandbox] exec aborted by caller; SIGKILL sent.",
        durationMs: 12,
        timedOut: false,
        aborted: true,
      };
    };
    const ctl = new AbortController();
    const p = ExecTool.execute(
      { command: "sleep 9999", timeout_ms: 60_000 },
      makeCtx({ runner: r, signal: ctl.signal }),
    ) as Promise<{
      ok: boolean;
      timed_out: boolean;
      aborted: boolean;
      stderr: string;
    }>;
    // Fire the abort, runner returns immediately, no watchdog needed.
    setImmediate(() => ctl.abort());
    const out = await p;
    expect(out.ok).toBe(false);
    expect(out.aborted).toBe(true);
    expect(out.timed_out).toBe(false);
    expect(out.stderr).toContain("aborted");
  });

  it("outer watchdog fires when runner.exec never resolves", async () => {
    vi.useFakeTimers();
    try {
      const r = new FakeRunner();
      // Simulate the failure mode we hit in practice: the SDK
      // hangs *before* the runner's own timeout race is wired up
      // (e.g. shellStream(script) blocks on a dead host-guest
      // socket). Without the outer watchdog the tool call hangs
      // forever, taking the worker turn down with it.
      r.fakeExec = () => new Promise(() => {});
      const p = ExecTool.execute(
        { command: "echo x", timeout_ms: 1_000 },
        makeCtx({ runner: r }),
      ) as Promise<{
        ok: boolean;
        timed_out: boolean;
        stderr: string;
        duration_ms: number;
      }>;
      // Inner timeout (1s) + 5s slack = 6s before watchdog fires.
      await vi.advanceTimersByTimeAsync(6_000);
      const out = await p;
      expect(out.ok).toBe(false);
      expect(out.timed_out).toBe(true);
      expect(out.stderr).toContain("watchdog");
      expect(out.duration_ms).toBe(6_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ResetSandboxTool", () => {
  it("calls runner.reset and reports the new status", async () => {
    const r = new FakeRunner();
    const out = (await ResetSandboxTool.execute({}, makeCtx({ runner: r }))) as {
      ok: boolean;
      status: { state: string };
    };
    expect(out.ok).toBe(true);
    expect(r.resetCount).toBe(1);
    expect(out.status.state).toBe("ready");
  });
  it("returns ok=false when capability is absent", async () => {
    const out = (await ResetSandboxTool.execute({}, makeCtx({}))) as { ok: boolean };
    expect(out.ok).toBe(false);
  });
});

describe("GetSandboxStatusTool", () => {
  it("returns the runner's status snake-cased", async () => {
    const r = new FakeRunner();
    r.status_ = {
      state: "running",
      uptimeMs: 12345,
      meta: { image: "python:3.12-slim" },
    };
    const out = (await GetSandboxStatusTool.execute(
      {},
      makeCtx({ runner: r }),
    )) as { state: string; uptime_ms: number; meta: Record<string, unknown> };
    expect(out.state).toBe("running");
    expect(out.uptime_ms).toBe(12345);
    expect(out.meta.image).toBe("python:3.12-slim");
  });
});

describe("UpdateSandboxConfigTool", () => {
  let homeDir: string;
  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-uconfig-"));
    fs.mkdirSync(path.join(homeDir, "tenants", "acme"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, "tenants", "acme", "config.json"),
      JSON.stringify({ plugins: { microsandbox: { enabled: true } } }),
    );
  });
  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("merges new config keys into the tenant config file", async () => {
    const out = (await UpdateSandboxConfigTool.execute(
      { image: "ubuntu:24.04", cpus: 4 },
      makeCtx({ tenantHomeDir: homeDir }),
    )) as { ok: boolean; reset_required: boolean };
    expect(out.ok).toBe(true);
    expect(out.reset_required).toBe(true);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(homeDir, "tenants", "acme", "config.json"), "utf8"),
    );
    expect(cfg.plugins.microsandbox.config.image).toBe("ubuntu:24.04");
    expect(cfg.plugins.microsandbox.config.cpus).toBe(4);
  });

  it("preserves existing config keys not mentioned", async () => {
    fs.writeFileSync(
      path.join(homeDir, "tenants", "acme", "config.json"),
      JSON.stringify({
        plugins: {
          microsandbox: {
            enabled: true,
            config: { image: "python:3.12-slim", cpus: 2, memoryMib: 2048 },
          },
        },
      }),
    );
    await UpdateSandboxConfigTool.execute(
      { cpus: 8 },
      makeCtx({ tenantHomeDir: homeDir }),
    );
    const cfg = JSON.parse(
      fs.readFileSync(path.join(homeDir, "tenants", "acme", "config.json"), "utf8"),
    );
    expect(cfg.plugins.microsandbox.config.image).toBe("python:3.12-slim");
    expect(cfg.plugins.microsandbox.config.cpus).toBe(8);
    expect(cfg.plugins.microsandbox.config.memoryMib).toBe(2048);
  });

  it("idle / exec timeout changes are reset_required=false", async () => {
    const out = (await UpdateSandboxConfigTool.execute(
      { exec_timeout_ms: 60_000, idle_shutdown_ms: 0 },
      makeCtx({ tenantHomeDir: homeDir }),
    )) as { ok: boolean; reset_required: boolean };
    expect(out.ok).toBe(true);
    expect(out.reset_required).toBe(false);
  });

  it("returns ok=false when no keys provided", async () => {
    const out = (await UpdateSandboxConfigTool.execute(
      {},
      makeCtx({ tenantHomeDir: homeDir }),
    )) as { ok: boolean };
    expect(out.ok).toBe(false);
  });
});
