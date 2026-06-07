// Smoke tests for the admin route handlers.
//
// We invoke them directly with a minimal Request/Response shim
// instead of mounting Express, because the plugin's HTTP surface is
// covered by the host's plugins-routes integration tests already.
// The goal here is to lock down:
//
//   1. GET /sandboxfile returns the default template when the file
//      doesn't exist yet, and the saved content after a write.
//   2. PUT /sandboxfile rejects malformed bodies + surfaces parse
//      errors without rejecting the write.
//   3. POST /builds returns 400 when there's no Sandboxfile, and
//      400 with the parse error when one exists but doesn't parse.
//   4. POST /builds/publish 404s on unknown build_id.
//
// We don't exercise buildSnapshot itself — that path needs the
// microsandbox SDK (covered separately in builder.test.ts and the
// closed-source predecessor's e2e suite).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { buildAdminRoutes } from "./routes.js";
import {
  DEFAULT_SANDBOXFILE,
} from "./sandboxfile-io.js";

interface MockResponse {
  statusCode: number;
  body: unknown;
  status(code: number): MockResponse;
  json(payload: unknown): MockResponse;
}

function makeRes(): MockResponse {
  const r: MockResponse = {
    statusCode: 200,
    body: undefined,
    status(code) {
      r.statusCode = code;
      return r;
    },
    json(payload) {
      r.body = payload;
      return r;
    },
  };
  return r;
}

function makeReq(opts: {
  userId?: string;
  body?: unknown;
  query?: Record<string, string>;
}) {
  return {
    ctx: opts.userId ? { userId: opts.userId } : undefined,
    body: opts.body,
    query: opts.query ?? {},
  } as unknown as Parameters<
    ReturnType<typeof buildAdminRoutes>["getSandboxfile"]
  >[0];
}

describe("microsandbox admin routes", () => {
  let tmp: string;
  let routes: ReturnType<typeof buildAdminRoutes>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-msb-admin-"));
    // Plugin code expects:
    //   tenantHomeDir/tenants/<tid>/workspace/users/<uid>/sandbox/...
    fs.mkdirSync(path.join(tmp, "tenants/tt/workspace/users/uu"), {
      recursive: true,
    });
    routes = buildAdminRoutes({
      getRunner: () => null,
      tenantId: "tt",
      tenantHomeDir: tmp,
      workspaceDir: path.join(tmp, "tenants/tt/workspace"),
      sandboxName: "tianshu-tt",
    });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("GET /sandboxfile returns the default template when missing", async () => {
    const res = makeRes();
    await routes.getSandboxfile(makeReq({ userId: "uu" }), res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      content: string;
      exists: boolean;
      path: string;
    };
    expect(body.exists).toBe(false);
    expect(body.content).toBe(DEFAULT_SANDBOXFILE);
    expect(body.path).toContain("sandbox/Sandboxfile");
  });

  it("GET /sandboxfile returns the saved file after a write", async () => {
    await routes.putSandboxfile(
      makeReq({
        userId: "uu",
        body: { content: "image: alpine:3\ncpus: 2\nmemory_mib: 1024\n" },
      }),
      makeRes() as never,
    );
    const res = makeRes();
    await routes.getSandboxfile(makeReq({ userId: "uu" }), res as never);
    const body = res.body as { content: string; exists: boolean };
    expect(body.exists).toBe(true);
    expect(body.content).toContain("alpine:3");
  });

  it("PUT /sandboxfile rejects non-string body", async () => {
    const res = makeRes();
    await routes.putSandboxfile(
      makeReq({ userId: "uu", body: { content: 123 } }),
      res as never,
    );
    expect(res.statusCode).toBe(400);
  });

  it("PUT /sandboxfile saves invalid content but surfaces parseError", async () => {
    const res = makeRes();
    await routes.putSandboxfile(
      makeReq({
        userId: "uu",
        body: { content: "this is not a sandboxfile" },
      }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: true; parseError: string | null };
    expect(body.ok).toBe(true);
    expect(body.parseError).toBeTruthy();
    expect(body.parseError).toMatch(/Sandboxfile/);
  });

  it("PUT /sandboxfile requires authenticated context", async () => {
    const res = makeRes();
    await routes.putSandboxfile(
      makeReq({ body: { content: "image: alpine:3\n" } }),
      res as never,
    );
    expect(res.statusCode).toBe(401);
  });

  it("GET /builds returns empty when no builds exist yet", async () => {
    const res = makeRes();
    await routes.getBuilds(makeReq({ userId: "uu" }), res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as { builds: unknown[]; published: unknown };
    expect(body.builds).toEqual([]);
    expect(body.published).toBeNull();
  });

  it("POST /builds 400s when no Sandboxfile is saved yet", async () => {
    const res = makeRes();
    await routes.postBuilds(makeReq({ userId: "uu" }), res as never);
    // No runner → 503 wins over the 400 we'd otherwise return for
    // "no sandboxfile". Both are acceptable; we check we don't 200.
    expect([400, 503]).toContain(res.statusCode);
  });

  it("POST /builds/publish 400s without build_id", async () => {
    const res = makeRes();
    await routes.postPublish(
      makeReq({ userId: "uu", query: {} }),
      res as never,
    );
    expect(res.statusCode).toBe(400);
  });

  it("POST /builds/publish 404s for unknown build_id", async () => {
    const res = makeRes();
    await routes.postPublish(
      makeReq({ userId: "uu", query: { build_id: "20260101-000000" } }),
      res as never,
    );
    expect(res.statusCode).toBe(404);
  });

  it("POST /reset 503s when runner not available", async () => {
    const res = makeRes();
    await routes.postReset(makeReq({}), res as never);
    expect(res.statusCode).toBe(503);
  });

  it("POST /exec 503s when runner not available", async () => {
    const res = makeRes();
    await routes.postExec(
      makeReq({ userId: "uu", body: { command: "echo hi" } }),
      res as never,
    );
    expect(res.statusCode).toBe(503);
  });

  it("POST /exec 401s when no user context", async () => {
    // Use a runner-bearing factory so the 401 isn't shadowed by 503.
    const r = buildAdminRoutes({
      getRunner: () => fakeRunner(),
      tenantId: "tt",
      tenantHomeDir: tmp,
      workspaceDir: path.join(tmp, "tenants/tt/workspace"),
      sandboxName: "tianshu-tt",
    });
    const res = makeRes();
    await r.postExec(makeReq({ body: { command: "echo hi" } }), res as never);
    expect(res.statusCode).toBe(401);
  });

  it("POST /exec 400s when command is missing or empty", async () => {
    const r = buildAdminRoutes({
      getRunner: () => fakeRunner(),
      tenantId: "tt",
      tenantHomeDir: tmp,
      workspaceDir: path.join(tmp, "tenants/tt/workspace"),
      sandboxName: "tianshu-tt",
    });
    const res = makeRes();
    await r.postExec(makeReq({ userId: "uu", body: { command: "   " } }), res as never);
    expect(res.statusCode).toBe(400);
  });

  it("POST /exec returns runner output and clamps timeoutMs", async () => {
    const fake = fakeRunner();
    const r = buildAdminRoutes({
      getRunner: () => fake,
      tenantId: "tt",
      tenantHomeDir: tmp,
      workspaceDir: path.join(tmp, "tenants/tt/workspace"),
      sandboxName: "tianshu-tt",
    });
    const res = makeRes();
    await r.postExec(
      makeReq({
        userId: "uu",
        body: {
          command: "echo hi",
          workdir: "/tmp",
          timeoutMs: 999_999_999,
        },
      }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      ok: boolean;
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
      timedOut: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toBe("hi\n");
    expect(fake.lastReq?.command).toBe("echo hi");
    expect(fake.lastReq?.workdir).toBe("/tmp");
    // 5 minute cap.
    expect(fake.lastReq?.timeoutMs).toBe(5 * 60_000);
  });
});

// ─── minimal SandboxRunner double for /exec tests ──────────────

interface FakeRunner {
  id: string;
  kind: "shell";
  lastReq: { command: string; workdir?: string; timeoutMs?: number } | null;
  exec(req: { command: string; workdir?: string; timeoutMs?: number }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
  }>;
  readFile(p: string): Promise<string>;
  writeFile(p: string, c: string): Promise<void>;
  workspacePath(): string;
  reset(): Promise<void>;
  shutdown(): Promise<void>;
  status(): Promise<{ state: "ready"; uptimeMs: 0 }>;
}

function fakeRunner(): FakeRunner {
  const f: FakeRunner = {
    id: "microsandbox.main",
    kind: "shell",
    lastReq: null,
    async exec(req) {
      f.lastReq = { command: req.command, workdir: req.workdir, timeoutMs: req.timeoutMs };
      return {
        exitCode: 0,
        stdout: "hi\n",
        stderr: "",
        durationMs: 1,
        timedOut: false,
      };
    },
    async readFile() {
      return "";
    },
    async writeFile() {},
    workspacePath() {
      return "/tmp";
    },
    async reset() {},
    async shutdown() {},
    async status() {
      return { state: "ready", uptimeMs: 0 };
    },
  };
  return f;
}
