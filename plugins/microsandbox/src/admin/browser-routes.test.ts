// Smoke tests for the Browser admin routes (N+5.1 scaffold).
//
// We exercise the public route shape against three runner states:
//   1. No runner at all (plugin failed to activate / hadn't yet).
//   2. Nullable / sidecar-but-no-chromium (today's default).
//   3. Sidecar reporting all three ports detected (future state we
//      simulate by setting the sidecar's internal ports manually).
//
// What we're locking down here is the *contract* that downstream
// admin UI / agent gating can rely on, not chromium specifics.

import { describe, it, expect } from "vitest";
import type { SandboxRunner } from "@tianshu-ai/plugin-sdk";
import { buildBrowserRoutes } from "./browser-routes.js";
import { MicrosandboxBrowserSidecar } from "../runner/browser.js";

interface MockResponse {
  statusCode: number;
  body: unknown;
  status(c: number): MockResponse;
  json(p: unknown): MockResponse;
}

function makeRes(): MockResponse {
  const r: MockResponse = {
    statusCode: 200,
    body: undefined,
    status(c) {
      r.statusCode = c;
      return r;
    },
    json(p) {
      r.body = p;
      return r;
    },
  };
  return r;
}

function makeReq() {
  return {} as Parameters<
    ReturnType<typeof buildBrowserRoutes>["getBrowserStatus"]
  >[0];
}

/**
 * A minimal SandboxRunner-shaped object carrying the BrowserSidecar
 * we want to test against. The browser routes only ever touch
 * `runner.browser`; we don't need the rest of the SandboxRunner
 * surface to be live.
 */
function fakeRunner(sidecar: MicrosandboxBrowserSidecar | undefined): SandboxRunner {
  return {
    id: "microsandbox.main",
    kind: "shell",
    browser: sidecar,
    async exec() {
      throw new Error("not used");
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
  } as unknown as SandboxRunner;
}

describe("microsandbox browser routes", () => {
  it("GET /browser/status when no runner reports ready=false + a hint", async () => {
    const routes = buildBrowserRoutes({ getRunner: () => null });
    const res = makeRes();
    await routes.getBrowserStatus(makeReq(), res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as { ready: boolean; ports: unknown; hint: string };
    expect(body.ready).toBe(false);
    expect(body.hint).toMatch(/Sandbox runner/);
  });

  it("GET /browser/status with sidecar but no ports → ready=false", async () => {
    const sidecar = new MicrosandboxBrowserSidecar();
    const routes = buildBrowserRoutes({
      getRunner: () => fakeRunner(sidecar),
    });
    const res = makeRes();
    await routes.getBrowserStatus(makeReq(), res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      ready: boolean;
      ports: { cdp: number | null; mcp: number | null; vnc: number | null };
      hint: string;
    };
    expect(body.ready).toBe(false);
    expect(body.ports).toEqual({ cdp: null, mcp: null, vnc: null });
    expect(body.hint).toMatch(/Sandboxfile|browser layer/);
  });

  it("GET /browser/status when sidecar reports all three ports → ready=true", async () => {
    const sidecar = new MicrosandboxBrowserSidecar();
    sidecar.__setDetectedPorts({ cdp: 9222, mcp: 3200, vnc: 6080 });
    const routes = buildBrowserRoutes({
      getRunner: () => fakeRunner(sidecar),
    });
    const res = makeRes();
    await routes.getBrowserStatus(makeReq(), res as never);
    const body = res.body as {
      ready: boolean;
      ports: { cdp: number; mcp: number; vnc: number };
      hint?: string;
    };
    expect(body.ready).toBe(true);
    expect(body.ports.cdp).toBe(9222);
    expect(body.ports.mcp).toBe(3200);
    expect(body.ports.vnc).toBe(6080);
    expect(body.hint).toBeUndefined();
  });

  it("POST /browser/restart with no runner → 503", async () => {
    const routes = buildBrowserRoutes({ getRunner: () => null });
    const res = makeRes();
    await routes.postBrowserRestart(makeReq(), res as never);
    expect(res.statusCode).toBe(503);
  });

  it("POST /browser/restart in scaffold state returns ok=false honestly", async () => {
    const sidecar = new MicrosandboxBrowserSidecar();
    const routes = buildBrowserRoutes({
      getRunner: () => fakeRunner(sidecar),
    });
    const res = makeRes();
    await routes.postBrowserRestart(makeReq(), res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/no chromium/);
  });

  it("MicrosandboxRunner exposes a BrowserSidecar instance", async () => {
    // Indirection via a runner-shaped object is enough for routes;
    // here we double-check the sidecar implements every method the
    // SDK's BrowserSidecar interface expects.
    const sidecar = new MicrosandboxBrowserSidecar();
    expect(typeof sidecar.cdpHostPort).toBe("function");
    expect(typeof sidecar.mcpHostPort).toBe("function");
    expect(typeof sidecar.vncHostPort).toBe("function");
    expect(typeof sidecar.setLastViewport).toBe("function");
    expect(typeof sidecar.getLastViewport).toBe("function");
    expect(typeof sidecar.restart).toBe("function");
    sidecar.setLastViewport({ width: 1280, height: 800 });
    expect(sidecar.getLastViewport()).toEqual({ width: 1280, height: 800 });
    expect(await sidecar.restart()).toBe(false);
  });
});

describe("MicrosandboxBrowserSidecar.health", () => {
  it("returns ok=false with helpful suggestion when no port is mapped", async () => {
    const sidecar = new MicrosandboxBrowserSidecar();
    const h = await sidecar.health();
    expect(h.ok).toBe(false);
    expect(h.error).toMatch(/CDP host port/);
    expect(h.suggestion).toMatch(/browser stack/);
  });

  it("returns ok=true with browser version when CDP responds", async () => {
    // Spin a tiny http server that mimics /json/version on a free
    // port, then point the sidecar at it.
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      if (req.url === "/json/version") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ Browser: "Chrome/145.0.0.0" }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const sidecar = new MicrosandboxBrowserSidecar();
      sidecar.__setDetectedPorts({ cdp: port });
      const h = await sidecar.health();
      expect(h.ok).toBe(true);
      expect(h.browser).toMatch(/Chrome/);
      expect(h.cdpHostPort).toBe(port);
      expect(h.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("returns ok=false with reset_sandbox suggestion on connect refused", async () => {
    // Bind a port to grab it, then close it so we know nothing is
    // listening. Race-y in theory, fine in practice for a local
    // ephemeral port that nothing else will reclaim mid-test.
    const net = await import("node:net");
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const sidecar = new MicrosandboxBrowserSidecar();
    sidecar.__setDetectedPorts({ cdp: port });
    const h = await sidecar.health();
    expect(h.ok).toBe(false);
    // Either ECONNREFUSED, or "fetch failed" wrapping it — both
    // mean "nothing listening". The suggestion should still
    // mention browser_restart / reset_sandbox.
    expect(h.suggestion).toMatch(/browser_restart|reset_sandbox/);
    expect(h.cdpHostPort).toBe(port);
  });
});
