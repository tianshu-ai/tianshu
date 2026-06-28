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

// sync_down now refuses to run without ctx.taskId (no agent-
// controlled task arg anymore). The default fake ctx is therefore
// task-bound; tests that need to assert the ad-hoc / chat-session
// rejection build their own ctx with taskId omitted.
const fakeCtx = {
  userId: "alice",
  tenantId: "acme",
  tenantHomeDir: "/h/acme",
  userHomeDir: "/h/acme/workspace/users/alice",
  sessionId: "sess-1",
  taskId: "42-build",
  projectSlug: "foo",
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

  it("prefixes paths with users/<u>/projects/<p>/ before forwarding to runner.syncUp", async () => {
    // fakeCtx now sets projectSlug='foo' (typical workboard task
    // shape), so sandbox-side anchoring is the full per-project
    // tree. A bare user-scope test for chat sessions without a
    // project follows below.
    const runner = new FakeSyncRunner();
    runner.upResult = {
      uploaded: ["/sandbox/workspace/users/alice/projects/foo/a.txt"],
      skipped: [
        {
          relPath: "users/alice/projects/foo/missing/",
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
    expect(runner.upCalls).toEqual([[
      "users/alice/projects/foo/a.txt",
      "users/alice/projects/foo/missing/",
    ]]);
    expect(res.scope).toBe("user");
    expect(res.ok).toBe(false);
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
    // 'task' is no longer agent-controllable; default ctx in this
    // test file always sets ctx.taskId='42-build' for sync_down.
    return { paths: ["out.log"], project: "foo", ...extra };
  }

  it("requires ctx.taskId + a valid project slug", async () => {
    const runner = new FakeSyncRunner();
    const r = SyncDownTool(runner);

    // ctx.taskId missing → host can't derive a task folder name,
    // and the agent has no way to supply one anymore.
    const ctxNoTask = {
      ...fakeCtx,
      taskId: undefined,
    } as AgentToolContext;
    const res1 = (await r.execute(
      { paths: ["x"], project: "foo" },
      ctxNoTask,
    )) as { ok: boolean; error: string };
    expect(res1.ok).toBe(false);
    expect(res1.error).toMatch(/sync_down only works inside a workboard task/);

    // Empty paths arg — rejected regardless of ctx.
    const res2 = (await r.execute(
      { paths: [], project: "foo" },
      fakeCtx,
    )) as { ok: boolean };
    expect(res2.ok).toBe(false);

    // No project anywhere (neither arg nor ctx) — rejected.
    const ctxNoProject = {
      ...fakeCtx,
      projectSlug: undefined,
    } as AgentToolContext;
    const res3 = (await r.execute(
      { paths: ["x"], project: "" },
      ctxNoProject,
    )) as { ok: boolean };
    expect(res3.ok).toBe(false);

    expect(runner.downCalls).toHaveLength(0);
  });

  it("rejects project slugs containing path separators or traversal", async () => {
    const runner = new FakeSyncRunner();
    const r = SyncDownTool(runner);
    for (const bad of [
      validArgs({ project: "../etc" }),
      validArgs({ project: "a/b" }),
      validArgs({ project: "." }),
    ]) {
      const res = (await r.execute(bad, fakeCtx)) as { ok: boolean };
      expect(res.ok).toBe(false);
    }
    expect(runner.downCalls).toHaveLength(0);
  });

  it("strips redundant projects/<project>/ prefix from agent inputs", async () => {
    // Reproduces the 2026-06-28 bug Yu reported: the agent passed
    // paths=["projects/sync-probe-2026/chart.png"] and the host
    // dest ended up at
    //   .../projects/sync-probe-2026/.results/<task>/projects/sync-probe-2026/chart.png
    // (and the sandbox-side lookup also nested twice). The fix
    // normalises agent input by peeling off the project prefix
    // before joining with the scope anchor.
    // fakeCtx supplies taskId='42-build' so the host derives that
    // folder name; we override the project arg to assert the
    // strip behaviour against the cross-project case.
    const runner = new FakeSyncRunner();
    const expectedDest =
      "/h/acme/workspace/users/alice/projects/sync-probe-2026/.results/42-build";
    runner.downResult = {
      downloaded: [`${expectedDest}/chart.png`],
      skipped: [],
    };
    const r = SyncDownTool(runner);
    await r.execute(
      {
        paths: ["projects/sync-probe-2026/chart.png"],
        project: "sync-probe-2026",
      },
      fakeCtx,
    );
    expect(runner.downCalls).toHaveLength(1);
    // Sandbox path: prefix added exactly once — no doubled
    // 'projects/sync-probe-2026/'.
    expect(runner.downCalls[0]!.paths).toEqual([
      "users/alice/projects/sync-probe-2026/chart.png",
    ]);
    // Host path: bare project-relative name; the destBaseDir
    // already anchors the .results/<task>/ tree.
    expect(runner.downCalls[0]!.hostPaths).toEqual(["chart.png"]);
    expect(runner.downCalls[0]!.destBaseDir).toBe(expectedDest);
  });

  it("strips users/<userId>/projects/<project>/ when an agent passes a fully-rooted path", async () => {
    const runner = new FakeSyncRunner();
    runner.downResult = { downloaded: [], skipped: [] };
    const r = SyncDownTool(runner);
    await r.execute(
      {
        paths: ["users/alice/projects/foo/dist/output.txt"],
        project: "foo",
      },
      fakeCtx,
    );
    expect(runner.downCalls[0]!.paths).toEqual([
      "users/alice/projects/foo/dist/output.txt",
    ]);
    expect(runner.downCalls[0]!.hostPaths).toEqual(["dist/output.txt"]);
  });

  it("stages files at users/<user>/projects/<project>/.results/<task>/...", async () => {
    const runner = new FakeSyncRunner();
    const expectedDest =
      "/h/acme/workspace/users/alice/projects/foo/.results/42-build";
    runner.downResult = {
      downloaded: [
        `${expectedDest}/build.log`,
        `${expectedDest}/logs/`,
      ],
      skipped: [],
    };
    const r = SyncDownTool(runner);
    const res = (await r.execute(
      validArgs({ paths: ["build.log", "logs/"], project: "foo" }),
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
    // Sandbox paths get the full user+project prefix so they
    // resolve to the project working dir inside the shared
    // tenant sandbox.
    expect(runner.downCalls[0]!.paths).toEqual([
      "users/alice/projects/foo/build.log",
      "users/alice/projects/foo/logs/",
    ]);
    // Host paths are the agent's raw input — the results dir
    // is already anchored at the project's .results/<task>/.
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

    it("multiple sync_down calls with different agent task args all land in the same ctx-derived folder", async () => {
      // Direct repro of Yu's bug: agent calls sync_down 4 times,
      // each time guessing a slightly different `task` name, and
      // ends up with 5 separate .results dirs. With ctx.taskId
      // winning, the agent's `task` arg is dropped each time and
      // all calls converge on the host-derived folder name.
      const runner = new FakeSyncRunner();
      runner.downResult = { downloaded: [], skipped: [] };
      const r = SyncDownTool(runner);
      const ctx = {
        userId: "dev",
        tenantId: "acme",
        tenantHomeDir: "/h/acme",
        userHomeDir: "/h/acme/workspace/users/dev",
        taskId: "probe",
        projectSlug: "sync-probe-2026",
        // No taskTitle here — the folder ends up as the bare
        // taskId, easier to assert against.
      } as AgentToolContext;
      const agentTaskGuesses = [
        "probe-run-single-binary",
        "probe-run-single-text",
        "main-agent-probe-user-home-anchored",
        "main-agent-probe-project-anchored",
      ];
      const seen = new Set<string>();
      for (const t of agentTaskGuesses) {
        // 'task' is no longer in the schema, but typebox is
        // tolerant of extra keys: passing it simulates a stale
        // agent (or an older system prompt) still trying to set
        // the folder name. It's silently ignored.
        const res = (await r.execute(
          { paths: ["chart.png"], task: t } as never,
          ctx,
        )) as { destBaseDir: string };
        seen.add(res.destBaseDir);
      }
      expect(seen.size).toBe(1);
      expect([...seen][0]).toBe(
        "/h/acme/workspace/users/dev/projects/sync-probe-2026/.results/probe",
      );
    });

    it("task folder is fully host-derived from ctx (no agent-supplied task arg in schema)", async () => {
      // Yu 2026-06-28: "task 就不应该让 agent 给了, 应该是程序自动转换".
      // The schema doesn't expose a 'task' arg at all anymore;
      // every sync_down call in the same workboard task lands in
      // the same host-derived folder name, no exceptions.
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
          // 'task' isn't a valid arg anymore; if an agent passes
          // it (e.g. via a stale system prompt), the extra key
          // is silently dropped by typebox.
          task: "custom-folder" as never,
        },
        ctx,
      )) as { project: string; task: string };
      expect(res.project).toBe("other-project");
      expect(res.task).toBe("42-add-login");
    });

    it("errors helpfully when ctx.projectSlug AND project arg are both missing", async () => {
      // ctx.taskId might be set (so the task-folder check passes)
      // but project still has to come from somewhere.
      const runner = new FakeSyncRunner();
      const r = SyncDownTool(runner);
      const ctxNoProject = {
        ...fakeCtx,
        projectSlug: undefined,
      } as AgentToolContext;
      const res = (await r.execute({ paths: ["out.log"] }, ctxNoProject)) as {
        ok: boolean;
        error: string;
      };
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/project must be|ctx\.projectSlug/);
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
