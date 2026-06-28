// Unit tests for sync_up / sync_down tools' argument validation
// and runner-capability detection. We don't spin up a real sandbox
// here \u2014 just verify the input guards and that the duck-typing
// gracefully degrades when a future SandboxRunner doesn't implement
// the OpenShell-only methods.

import { describe, it, expect } from "vitest";
import type {
  AgentToolContext,
  ExecRequest,
  ExecResult,
  SandboxRunner,
  SandboxStatus,
} from "@tianshu-ai/plugin-sdk";
import { SyncDownTool, SyncUpTool } from "./index.js";

/** Bare SandboxRunner stub that does NOT implement syncUp/syncDown.
 *  Stand-in for a microsandbox-style runner under the same tool
 *  factory. */
class NoSyncRunner implements SandboxRunner {
  readonly id = "fake.main";
  readonly kind = "shell" as const;
  async exec(_req: ExecRequest): Promise<ExecResult> {
    throw new Error("not implemented");
  }
  async readFile(_p: string): Promise<string> {
    throw new Error("not implemented");
  }
  async writeFile(_p: string, _c: string): Promise<void> {}
  workspacePath(): string {
    return "/tmp/fake";
  }
  async reset(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async status(): Promise<SandboxStatus> {
    return { state: "ready", uptimeMs: 0 };
  }
}

/** SyncCapable stub. Records inputs and returns canned outputs so
 *  we can assert tool wiring without involving the CLI. */
class FakeSyncRunner extends NoSyncRunner {
  readonly upCalls: string[][] = [];
  readonly downCalls: string[][] = [];
  upResult = {
    uploaded: [] as string[],
    skipped: [] as { relPath: string; reason: string }[],
  };
  downResult = {
    downloaded: [] as string[],
    skipped: [] as { relPath: string; reason: string }[],
  };

  async syncUp(hostRelPaths: string[]) {
    this.upCalls.push(hostRelPaths);
    return this.upResult;
  }
  async syncDown(sandboxRelPaths: string[]) {
    this.downCalls.push(sandboxRelPaths);
    return this.downResult;
  }
}

const fakeCtx = {} as AgentToolContext;

describe("sync_up tool", () => {
  it("rejects empty paths", async () => {
    const r = SyncUpTool(new FakeSyncRunner());
    const res = (await r.execute({ paths: [] }, fakeCtx)) as {
      ok: boolean;
      error: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/non-empty/);
  });

  it("rejects missing paths arg", async () => {
    const r = SyncUpTool(new FakeSyncRunner());
    const res = (await r.execute({} as Record<string, unknown>, fakeCtx)) as {
      ok: boolean;
      error: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/non-empty/);
  });

  it("forwards paths verbatim to runner.syncUp and reports skip diagnostics", async () => {
    const runner = new FakeSyncRunner();
    runner.upResult = {
      uploaded: ["/sandbox/workspace/a.txt"],
      skipped: [{ relPath: "missing/", reason: "host path does not exist" }],
    };
    const r = SyncUpTool(runner);
    const res = (await r.execute(
      { paths: ["a.txt", "missing/"] },
      fakeCtx,
    )) as {
      ok: boolean;
      uploaded: string[];
      skipped: { relPath: string }[];
    };
    expect(runner.upCalls).toEqual([["a.txt", "missing/"]]);
    // ok=false because there was at least one skip; the agent uses
    // this to decide whether to retry / surface the failure.
    expect(res.ok).toBe(false);
    expect(res.uploaded).toEqual(["/sandbox/workspace/a.txt"]);
    expect(res.skipped).toHaveLength(1);
  });

  it("reports ok=true when nothing was skipped", async () => {
    const runner = new FakeSyncRunner();
    runner.upResult = {
      uploaded: ["/sandbox/workspace/a.txt", "/sandbox/workspace/b/"],
      skipped: [],
    };
    const r = SyncUpTool(runner);
    const res = (await r.execute(
      { paths: ["a.txt", "b/"] },
      fakeCtx,
    )) as { ok: boolean };
    expect(res.ok).toBe(true);
  });

  it("returns a clean error when the runner doesn't support sync_up", async () => {
    const r = SyncUpTool(new NoSyncRunner());
    const res = (await r.execute({ paths: ["a.txt"] }, fakeCtx)) as {
      ok: boolean;
      error: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/does not support sync_up/);
  });

  it("propagates runner errors as a tool-level error result", async () => {
    class ThrowingRunner extends FakeSyncRunner {
      override async syncUp(_p: string[]): Promise<never> {
        throw new Error("gateway is on fire");
      }
    }
    const r = SyncUpTool(new ThrowingRunner());
    const res = (await r.execute({ paths: ["a.txt"] }, fakeCtx)) as {
      ok: boolean;
      error: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/gateway is on fire/);
  });
});

describe("sync_down tool", () => {
  it("rejects empty paths", async () => {
    const r = SyncDownTool(new FakeSyncRunner());
    const res = (await r.execute({ paths: [] }, fakeCtx)) as {
      ok: boolean;
      error: string;
    };
    expect(res.ok).toBe(false);
  });

  it("forwards paths verbatim and surfaces skip reasons", async () => {
    const runner = new FakeSyncRunner();
    runner.downResult = {
      downloaded: ["/Users/x/ws/build.log"],
      skipped: [
        { relPath: "dist/", reason: "sandbox download exit 1: not found" },
      ],
    };
    const r = SyncDownTool(runner);
    const res = (await r.execute(
      { paths: ["build.log", "dist/"] },
      fakeCtx,
    )) as {
      ok: boolean;
      downloaded: string[];
      skipped: { relPath: string }[];
    };
    expect(runner.downCalls).toEqual([["build.log", "dist/"]]);
    expect(res.ok).toBe(false);
    expect(res.downloaded).toHaveLength(1);
    expect(res.skipped).toHaveLength(1);
  });

  it("returns a clean error when the runner doesn't support sync_down", async () => {
    const r = SyncDownTool(new NoSyncRunner());
    const res = (await r.execute({ paths: ["a"] }, fakeCtx)) as {
      ok: boolean;
      error: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/does not support sync_down/);
  });
});
