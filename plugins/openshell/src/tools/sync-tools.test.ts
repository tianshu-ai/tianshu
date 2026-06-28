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
  readonly downCalls: {
    paths: string[];
    hostPaths: string[];
    destBaseDir?: string;
  }[] = [];
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
    paths: string[] | { sandbox: string; host: string }[],
    opts: { destBaseDir?: string } = {},
  ) {
    // Normalise to {sandbox, host} so assertions can check both
    // halves regardless of caller form.
    const items = paths.map((p) =>
      typeof p === "string" ? { sandbox: p, host: p } : p,
    );
    this.downCalls.push({
      paths: items.map((i) => i.sandbox),
      hostPaths: items.map((i) => i.host),
      destBaseDir: opts.destBaseDir,
    });
    return this.downResult;
  }
}

const fakeCtx = {
  userId: "alice",
  tenantId: "acme",
  tenantHomeDir: "/h/acme",
  userHomeDir: "/h/acme/workspace/users/alice",
  sessionId: "sess-1",
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

  function validArgs(extra: Record<string, unknown> = {}) {
    return { paths: ["out.log"], project: "foo", task: "42-build", ...extra };
  }

  it("requires project + task slugs", async () => {
    const runner = new FakeSyncRunner();
    const r = SyncDownTool(runner);
    for (const bad of [
      { paths: ["x"] }, // both missing
      { paths: ["x"], project: "foo" }, // task missing
      { paths: ["x"], task: "42" }, // project missing
      { paths: ["x"], project: "", task: "42" },
      { paths: ["x"], project: "foo", task: "" },
    ]) {
      const res = (await r.execute(bad, fakeCtx)) as { ok: boolean };
      expect(res.ok).toBe(false);
    }
    expect(runner.downCalls).toHaveLength(0);
  });

  it("rejects slugs containing path separators or traversal", async () => {
    const runner = new FakeSyncRunner();
    const r = SyncDownTool(runner);
    for (const bad of [
      validArgs({ project: "../etc" }),
      validArgs({ project: "a/b" }),
      validArgs({ task: ".." }),
      validArgs({ task: "with spaces" }),
      validArgs({ task: "-leading-hyphen" }),
    ]) {
      const res = (await r.execute(bad, fakeCtx)) as { ok: boolean };
      expect(res.ok).toBe(false);
    }
    expect(runner.downCalls).toHaveLength(0);
  });

  it("stages files at users/<user>/projects/<project>/.results/<task>/...", async () => {
    const runner = new FakeSyncRunner();
    const expectedDest =
      "/h/acme/workspace/users/alice/projects/foo/.results/42-build";
    runner.downResult = {
      downloaded: [
        `${expectedDest}/users/alice/build.log`,
        `${expectedDest}/users/alice/logs/`,
      ],
      skipped: [],
    };
    const r = SyncDownTool(runner);
    const res = (await r.execute(
      validArgs({ paths: ["build.log", "logs/"] }),
      fakeCtx,
    )) as {
      ok: boolean;
      scope: string;
      project: string;
      task: string;
      destBaseDir: string;
      downloaded: string[];
      notice: string;
    };
    expect(runner.downCalls).toHaveLength(1);
    // Sandbox paths keep the user prefix (for cross-user safety
    // inside the shared tenant sandbox).
    expect(runner.downCalls[0]!.paths).toEqual([
      "users/alice/build.log",
      "users/alice/logs/",
    ]);
    // Host paths drop the prefix — the result tree is already
    // anchored at the user's home dir.
    expect(runner.downCalls[0]!.hostPaths).toEqual(["build.log", "logs/"]);
    expect(runner.downCalls[0]!.destBaseDir).toBe(expectedDest);
    expect(res.scope).toBe("user");
    expect(res.project).toBe("foo");
    expect(res.task).toBe("42-build");
    expect(res.destBaseDir).toBe(expectedDest);
    expect(res.notice).toMatch(/Staged/);
  });

  describe("defaults from ctx", () => {
    it("uses ctx.projectSlug and ctx.taskId when args are omitted", async () => {
      const runner = new FakeSyncRunner();
      runner.downResult = { downloaded: [], skipped: [] };
      const r = SyncDownTool(runner);
      const ctx = {
        userId: "alice",
        tenantId: "acme",
        tenantHomeDir: "/h/acme",
        userHomeDir: "/h/acme/workspace/users/alice",
        taskId: "42",
        projectSlug: "blog-engine",
        taskTitle: "Add Login Flow",
      } as AgentToolContext;
      const res = (await r.execute({ paths: ["out.log"] }, ctx)) as {
        ok: boolean;
        project: string;
        task: string;
        destBaseDir: string;
      };
      expect(res.ok).toBe(true);
      expect(res.project).toBe("blog-engine");
      // taskId + slugified title.
      expect(res.task).toBe("42-add-login-flow");
      expect(res.destBaseDir).toBe(
        "/h/acme/workspace/users/alice/projects/blog-engine/.results/42-add-login-flow",
      );
    });

    it("falls back to bare taskId when taskTitle is empty or slug-empty", async () => {
      const runner = new FakeSyncRunner();
      runner.downResult = { downloaded: [], skipped: [] };
      const r = SyncDownTool(runner);
      const ctx = {
        userId: "alice",
        tenantId: "acme",
        tenantHomeDir: "/h/acme",
        userHomeDir: "/h/acme/workspace/users/alice",
        taskId: "42",
        projectSlug: "blog-engine",
        // All symbols → slug collapses to empty → use bare id.
        taskTitle: "!!!",
      } as AgentToolContext;
      const res = (await r.execute({ paths: ["out.log"] }, ctx)) as {
        task: string;
      };
      expect(res.task).toBe("42");
    });

    it("explicit args win over ctx defaults", async () => {
      const runner = new FakeSyncRunner();
      runner.downResult = { downloaded: [], skipped: [] };
      const r = SyncDownTool(runner);
      const ctx = {
        userId: "alice",
        tenantId: "acme",
        tenantHomeDir: "/h/acme",
        userHomeDir: "/h/acme/workspace/users/alice",
        taskId: "42",
        projectSlug: "blog-engine",
        taskTitle: "Add Login",
      } as AgentToolContext;
      const res = (await r.execute(
        {
          paths: ["out.log"],
          project: "other-project",
          task: "custom-folder",
        },
        ctx,
      )) as { project: string; task: string };
      expect(res.project).toBe("other-project");
      expect(res.task).toBe("custom-folder");
    });

    it("errors helpfully when ctx is missing and args weren't passed", async () => {
      const runner = new FakeSyncRunner();
      const r = SyncDownTool(runner);
      const res = (await r.execute({ paths: ["out.log"] }, fakeCtx)) as {
        ok: boolean;
        error: string;
      };
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/ctx\.projectSlug|workboard task/);
    });
  });

  it("scope:'tenant' bypasses the sandbox-side user prefix", async () => {
    const runner = new FakeSyncRunner();
    const expectedDest =
      "/h/acme/workspace/users/alice/projects/foo/.results/42-build";
    runner.downResult = {
      downloaded: [`${expectedDest}/shared.log`],
      skipped: [],
    };
    const r = SyncDownTool(runner);
    const res = (await r.execute(
      validArgs({ paths: ["shared.log"], scope: "tenant" }),
      fakeCtx,
    )) as { scope: string; destBaseDir: string };
    expect(runner.downCalls[0]!.paths).toEqual(["shared.log"]);
    expect(runner.downCalls[0]!.hostPaths).toEqual(["shared.log"]);
    // Host result path is unaffected by sandbox-side scope.
    expect(res.destBaseDir).toBe(expectedDest);
    expect(res.scope).toBe("tenant");
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
