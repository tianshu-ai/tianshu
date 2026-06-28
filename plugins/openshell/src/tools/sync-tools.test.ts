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
  readonly downCalls: { paths: string[]; destBaseDir?: string }[] = [];
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
  async syncDown(
    sandboxRelPaths: string[],
    opts: { destBaseDir?: string } = {},
  ) {
    this.downCalls.push({
      paths: sandboxRelPaths,
      destBaseDir: opts.destBaseDir,
    });
    return this.downResult;
  }
}

const fakeCtx = {
  userId: "alice",
  tenantId: "acme",
  tenantHomeDir: "/h/acme",
  sessionId: "sess-1",
} as AgentToolContext;

const fakeTaskCtx = {
  ...fakeCtx,
  taskId: "task-42",
} as AgentToolContext;

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

  it("prefixes paths with the user home before forwarding to runner.syncUp", async () => {
    const runner = new FakeSyncRunner();
    runner.upResult = {
      uploaded: ["/sandbox/workspace/users/alice/a.txt"],
      skipped: [
        {
          relPath: "users/alice/missing/",
          reason: "host path does not exist",
        },
      ],
    };
    const r = SyncUpTool(runner);
    const res = (await r.execute(
      { paths: ["a.txt", "missing/"] },
      fakeCtx,
    )) as {
      ok: boolean;
      scope: string;
      uploaded: string[];
      skipped: { relPath: string }[];
    };
    // Runner sees user-scoped paths.
    expect(runner.upCalls).toEqual([[
      "users/alice/a.txt",
      "users/alice/missing/",
    ]]);
    expect(res.scope).toBe("user");
    expect(res.ok).toBe(false);
    expect(res.uploaded).toEqual(["/sandbox/workspace/users/alice/a.txt"]);
    expect(res.skipped).toHaveLength(1);
  });

  it("scope:'tenant' bypasses the user-home prefix", async () => {
    const runner = new FakeSyncRunner();
    runner.upResult = { uploaded: ["/sandbox/workspace/shared.txt"], skipped: [] };
    const r = SyncUpTool(runner);
    const res = (await r.execute(
      { paths: ["shared.txt"], scope: "tenant" },
      fakeCtx,
    )) as { ok: boolean; scope: string };
    expect(runner.upCalls).toEqual([["shared.txt"]]);
    expect(res.scope).toBe("tenant");
    expect(res.ok).toBe(true);
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

  it("prefixes paths with the user home before forwarding to runner.syncDown", async () => {
    const runner = new FakeSyncRunner();
    runner.downResult = {
      downloaded: ["/h/acme/task-results/sessions/sess-1/users/alice/build.log"],
      skipped: [
        {
          relPath: "users/alice/dist/",
          reason: "sandbox download exit 1: not found",
        },
      ],
    };
    const r = SyncDownTool(runner);
    const res = (await r.execute(
      { paths: ["build.log", "dist/"] },
      fakeCtx,
    )) as {
      ok: boolean;
      scope: string;
      destBaseDir: string;
      downloaded: string[];
      skipped: { relPath: string }[];
    };
    expect(runner.downCalls).toHaveLength(1);
    expect(runner.downCalls[0]!.paths).toEqual([
      "users/alice/build.log",
      "users/alice/dist/",
    ]);
    expect(res.scope).toBe("user");
    expect(res.ok).toBe(false);
  });

  it("scope:'tenant' bypasses the user-home prefix on sync_down", async () => {
    const runner = new FakeSyncRunner();
    runner.downResult = { downloaded: ["/h/acme/task-results/sessions/sess-1/shared.log"], skipped: [] };
    const r = SyncDownTool(runner);
    await r.execute({ paths: ["shared.log"], scope: "tenant" }, fakeCtx);
    expect(runner.downCalls[0]!.paths).toEqual(["shared.log"]);
  });

  describe("destBaseDir scoping", () => {
    it("uses tasks/<taskId>/ when ctx.taskId is set", async () => {
      const runner = new FakeSyncRunner();
      runner.downResult = { downloaded: [], skipped: [] };
      const r = SyncDownTool(runner);
      const res = (await r.execute(
        { paths: ["out.log"] },
        fakeTaskCtx,
      )) as { destBaseDir: string };
      expect(runner.downCalls[0]!.destBaseDir).toBe(
        "/h/acme/task-results/tasks/task-42",
      );
      expect(res.destBaseDir).toBe(
        "/h/acme/task-results/tasks/task-42",
      );
    });

    it("uses sessions/<sessionId>/ when only sessionId is set", async () => {
      const runner = new FakeSyncRunner();
      runner.downResult = { downloaded: [], skipped: [] };
      const r = SyncDownTool(runner);
      await r.execute({ paths: ["out.log"] }, fakeCtx);
      expect(runner.downCalls[0]!.destBaseDir).toBe(
        "/h/acme/task-results/sessions/sess-1",
      );
    });

    it("falls back to main/<day>-<pid>/ when neither id is set", async () => {
      const runner = new FakeSyncRunner();
      runner.downResult = { downloaded: [], skipped: [] };
      const r = SyncDownTool(runner);
      const ctx = {
        userId: "alice",
        tenantId: "acme",
        tenantHomeDir: "/h/acme",
      } as AgentToolContext;
      await r.execute({ paths: ["out.log"] }, ctx);
      const dest = runner.downCalls[0]!.destBaseDir!;
      expect(dest).toMatch(
        /^\/h\/acme\/task-results\/main\/\d{4}-\d{2}-\d{2}-\d+$/,
      );
    });
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
