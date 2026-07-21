// End-to-end tests for the plugins HTTP surface: GET /api/plugins
// and PATCH /api/plugins/:id (Plugin Manager backend).
//
// We mount the router on a freshly built Express app with a
// tenant-middleware override that pins every request to a known
// tenant id. No real auth, no socket, no shutdown plumbing — keeps
// test setup small and the failure surface focused on routing +
// config persistence.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import type { PluginServerModule } from "@tianshu-ai/plugin-sdk";

import { DbPool } from "./core/db-pool.js";
import { GlobalOps } from "./core/global-ops.js";
import { writeTenantConfig, loadTenantConfig } from "./core/config.js";
import { tenantMiddleware } from "./core/middleware.js";
import {
  moduleMapResolver,
  PluginRegistry,
} from "./core/plugins/index.js";
import { buildPluginsRouter } from "./plugins-routes.js";
import { CatalogClient } from "./catalog.js";

const TENANT = "acme";

let home: string;
let builtinDir: string;
let ops: GlobalOps;
let registry: PluginRegistry;

const helloModule: PluginServerModule = {
  activate: () => ({
    routes: {
      hello: (_req, res) => res.json({ greeting: "hi" }),
      // Echoes back the matched id so the test can assert path
      // params land in `req.params`.
      echoId: (req, res) =>
        res.json({ id: (req.params as Record<string, string>).id ?? null }),
      // Two-param route (e.g. /things/:id/sub/:action) — exercises
      // multi-param matching.
      echoTwo: (req, res) =>
        res.json({
          id: (req.params as Record<string, string>).id ?? null,
          action: (req.params as Record<string, string>).action ?? null,
        }),
    },
    wsHandlers: { ping: () => {} },
  }),
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-plug-routes-"));
  builtinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-builtin-routes-"));
  ops = new GlobalOps({ home, pool: new DbPool({ home }) });
  registry = new PluginRegistry({
    resolver: moduleMapResolver({ "@hello/server": helloModule }),
    discoveryDirs: { builtinConfigDir: builtinDir, home },
  });
  ops.create(TENANT);
});

afterEach(() => {
  ops.closePool();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(builtinDir, { recursive: true, force: true });
});

function writeBuiltinManifest(id: string, manifest: object) {
  const dir = path.join(builtinDir, "plugins", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
}

function buildApp(
  opts: { catalog?: CatalogClient; reloadResolver?: () => Promise<void> } = {},
) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    tenantMiddleware({
      ops,
      resolvers: [
        {
          name: "test-stub",
          resolve: () => ({
            kind: "ok",
            tenantId: TENANT,
            userId: "user_test",
            source: "test-stub",
          }),
        },
      ],
    }),
  );
  app.use(
    "/api",
    buildPluginsRouter({
      registry,
      ops,
      catalog: opts.catalog,
      reloadResolver: opts.reloadResolver,
    }),
  );
  return app;
}

describe("plugins HTTP routes", () => {
  it("GET /api/plugins lists discovered plugins (disabled by default)", async () => {
    writeBuiltinManifest("hello", {
      id: "hello",
      version: "1.0.0",
      displayName: "Hello",
      server: { entry: "@hello/server" },
    });
    const app = buildApp();
    const res = await request(app).get("/api/plugins");
    expect(res.status).toBe(200);
    expect(res.body.plugins).toHaveLength(1);
    expect(res.body.plugins[0]).toMatchObject({
      id: "hello",
      version: "1.0.0",
      displayName: "Hello",
      source: "builtin",
      state: "disabled",
    });
  });

  it("PATCH /api/plugins/:id flips enabled, persists to disk, returns fresh list", async () => {
    writeBuiltinManifest("hello", {
      id: "hello",
      version: "1.0.0",
      displayName: "Hello",
      server: { entry: "@hello/server" },
    });
    const app = buildApp();

    // Enable
    let res = await request(app)
      .patch("/api/plugins/hello")
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.plugins[0].state).toBe("active");

    // On-disk config reflects it
    let cfg = loadTenantConfig(TENANT, home);
    expect(cfg.plugins?.hello).toEqual({ enabled: true });

    // Disable again
    res = await request(app).patch("/api/plugins/hello").send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.plugins[0].state).toBe("disabled");

    cfg = loadTenantConfig(TENANT, home);
    expect(cfg.plugins?.hello).toEqual({ enabled: false });
  });

  it("PATCH preserves other plugins' enabled state when flipping one", async () => {
    writeBuiltinManifest("alpha", {
      id: "alpha",
      version: "1.0.0",
      displayName: "Alpha",
      server: { entry: "@hello/server" },
    });
    writeBuiltinManifest("beta", {
      id: "beta",
      version: "1.0.0",
      displayName: "Beta",
      server: { entry: "@hello/server" },
    });
    writeTenantConfig(
      TENANT,
      { plugins: { alpha: { enabled: true } } },
      home,
    );
    const app = buildApp();

    const res = await request(app)
      .patch("/api/plugins/beta")
      .send({ enabled: true });
    expect(res.status).toBe(200);

    const cfg = loadTenantConfig(TENANT, home);
    expect(cfg.plugins?.alpha).toEqual({ enabled: true });
    expect(cfg.plugins?.beta).toEqual({ enabled: true });
  });

  it("PATCH auto-disables a plugin that provides the same capability (mutual exclusion)", async () => {
    // Two sandbox backends both provide sandbox.shell — only one may
    // be active at a time. Manifests need a backing sandboxes[] entry
    // for the provides validation to pass.
    writeBuiltinManifest("sandboxa", {
      id: "sandboxa",
      version: "1.0.0",
      displayName: "Sandbox A",
      provides: ["sandbox.shell"],
      server: { entry: "@a/server" },
      contributes: { sandboxes: [{ id: "shell", kind: "shell", displayName: "A", module: "M" }] },
    });
    writeBuiltinManifest("sandboxb", {
      id: "sandboxb",
      version: "1.0.0",
      displayName: "Sandbox B",
      provides: ["sandbox.shell"],
      server: { entry: "@b/server" },
      contributes: { sandboxes: [{ id: "shell", kind: "shell", displayName: "B", module: "M" }] },
    });
    writeTenantConfig(TENANT, { plugins: { sandboxa: { enabled: true } } }, home);
    const app = buildApp();

    const res = await request(app)
      .patch("/api/plugins/sandboxb")
      .send({ enabled: true });
    expect(res.status).toBe(200);

    const cfg = loadTenantConfig(TENANT, home);
    expect(cfg.plugins?.sandboxb).toEqual({ enabled: true });
    // sandboxa auto-disabled because it double-provides sandbox.shell.
    expect(cfg.plugins?.sandboxa).toEqual({ enabled: false });
  });

  it("PATCH auto-disables a same-exclusiveGroup plugin even without shared provides", async () => {
    // A sandbox backend (provides sandbox.shell) and a bridge that
    // provides NOTHING but serves shell via reverse-MCP. They share
    // exclusiveGroup:"shell" so only one may be on at a time.
    writeBuiltinManifest("sandboxa", {
      id: "sandboxa",
      version: "1.0.0",
      displayName: "Sandbox A",
      provides: ["sandbox.shell"],
      exclusiveGroup: "shell",
      server: { entry: "@a/server" },
      contributes: { sandboxes: [{ id: "shell", kind: "shell", displayName: "A", module: "M" }] },
    });
    writeBuiltinManifest("bridgesh", {
      id: "bridgesh",
      version: "1.0.0",
      displayName: "Bridge (shell)",
      exclusiveGroup: "shell",
      server: { entry: "@x/server" },
    });
    writeTenantConfig(TENANT, { plugins: { sandboxa: { enabled: true } } }, home);
    const app = buildApp();

    const res = await request(app)
      .patch("/api/plugins/bridgesh")
      .send({ enabled: true });
    expect(res.status).toBe(200);

    const cfg = loadTenantConfig(TENANT, home);
    expect(cfg.plugins?.bridgesh).toEqual({ enabled: true });
    // sandboxa auto-disabled: same exclusiveGroup, no shared provides.
    expect(cfg.plugins?.sandboxa).toEqual({ enabled: false });
  });

  it("PATCH leaves non-conflicting plugins enabled (no shared provides)", async () => {
    writeBuiltinManifest("sandboxa", {
      id: "sandboxa",
      version: "1.0.0",
      displayName: "Sandbox A",
      provides: ["sandbox.shell"],
      server: { entry: "@a/server" },
      contributes: { sandboxes: [{ id: "shell", kind: "shell", displayName: "A", module: "M" }] },
    });
    // bridge provides nothing — must NOT be disabled when a sandbox
    // is enabled.
    writeBuiltinManifest("bridgex", {
      id: "bridgex",
      version: "1.0.0",
      displayName: "Bridge X",
      server: { entry: "@x/server" },
    });
    writeTenantConfig(TENANT, { plugins: { bridgex: { enabled: true } } }, home);
    const app = buildApp();

    const res = await request(app)
      .patch("/api/plugins/sandboxa")
      .send({ enabled: true });
    expect(res.status).toBe(200);

    const cfg = loadTenantConfig(TENANT, home);
    expect(cfg.plugins?.sandboxa).toEqual({ enabled: true });
    expect(cfg.plugins?.bridgex).toEqual({ enabled: true });
  });

  it("PATCH rejects bad plugin id format", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/api/plugins/Bad_ID!")
      .send({ enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_plugin_id");
  });

  it("PATCH rejects empty body or non-boolean / non-object payload", async () => {
    writeBuiltinManifest("hello", {
      id: "hello",
      version: "1.0.0",
      displayName: "Hello",
      server: { entry: "@hello/server" },
    });
    const app = buildApp();

    // Empty body — nothing to update.
    let res = await request(app).patch("/api/plugins/hello").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_enabled_or_config");

    // `enabled` must be a boolean. A bare string is rejected because
    // the `hasEnabled` guard is strict; with no `config` either, the
    // generic missing-keys error fires.
    res = await request(app)
      .patch("/api/plugins/hello")
      .send({ enabled: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_enabled_or_config");
  });

  it("PATCH writes plugin config and surfaces it via GET", async () => {
    writeBuiltinManifest("hello", {
      id: "hello",
      version: "1.0.0",
      displayName: "Hello",
      server: { entry: "@hello/server" },
      configSchema: {
        fields: [
          { kind: "boolean", key: "echo.enabled", label: "Enable echo", default: true },
          { kind: "number", key: "echo.delayMs", label: "Delay", default: 30000 },
        ],
      },
    });
    const app = buildApp();

    // First enable the plugin so the config write target exists.
    await request(app).patch("/api/plugins/hello").send({ enabled: true });

    // Send a config patch.
    const patch = await request(app)
      .patch("/api/plugins/hello")
      .send({ config: { echo: { enabled: false, delayMs: 500 } } });
    expect(patch.status).toBe(200);

    // GET should surface the new config.
    const list = await request(app).get("/api/plugins");
    const hello = list.body.plugins.find(
      (p: { id: string }) => p.id === "hello",
    );
    expect(hello.config).toEqual({
      echo: { enabled: false, delayMs: 500 },
    });
    expect(hello.configSchema?.fields?.length).toBe(2);
  });

  it("PATCH refuses to enable an unknown plugin (404)", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/api/plugins/ghost")
      .send({ enabled: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("plugin_not_found");
  });

  it("GET /api/plugins/catalog returns a validated catalog snapshot", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            updatedAt: "2026-06-04T12:00:00Z",
            plugins: [
              {
                id: "pomodoro",
                displayName: "Pomodoro Timer",
                description: "A focus timer.",
                author: "tianshu-ai",
                verified: true,
                repository: "https://github.com/tianshu-ai/plugin-pomodoro",
                latestVersion: "1.0.0",
                tarballUrl: "https://example.com/p.tgz",
                tarballSha256: "a".repeat(64),
                tianshuRange: ">=0.2",
              },
            ],
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const catalog = new CatalogClient({ url: "https://x/catalog.json", fetcher });
    const app = buildApp({ catalog });

    const res = await request(app).get("/api/plugins/catalog");
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].id).toBe("pomodoro");
    expect(res.body.entriesDropped).toBe(0);
  });

  it("POST /api/plugins/catalog/refresh forces a re-fetch", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ schemaVersion: 1, plugins: [] }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const catalog = new CatalogClient({
      url: "https://x/catalog.json",
      fetcher,
      ttlMs: 60_000,
    });
    const app = buildApp({ catalog });

    await request(app).get("/api/plugins/catalog").expect(200);
    await request(app).get("/api/plugins/catalog").expect(200);
    expect(
      (fetcher as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
    ).toBe(1);

    await request(app).post("/api/plugins/catalog/refresh").expect(200);
    expect(
      (fetcher as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
    ).toBe(2);
  });

  it("GET /api/plugins/catalog 404s when no catalog client is wired", async () => {
    const app = buildApp();
    await request(app).get("/api/plugins/catalog").expect(404);
  });

  it("dispatches plugin contributed routes under /api/p/<id>/...", async () => {
    writeBuiltinManifest("hello", {
      id: "hello",
      version: "1.0.0",
      displayName: "Hello",
      server: { entry: "@hello/server" },
      contributes: { apiRoutes: [{ method: "GET", path: "/say", handler: "hello" }] },
    });
    writeTenantConfig(TENANT, { plugins: { hello: { enabled: true } } }, home);
    const app = buildApp();

    const res = await request(app).get("/api/p/hello/say");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ greeting: "hi" });
  });

  it("returns 404 when the plugin path doesn't match any contribution", async () => {
    writeBuiltinManifest("hello", {
      id: "hello",
      version: "1.0.0",
      displayName: "Hello",
      server: { entry: "@hello/server" },
      contributes: { apiRoutes: [{ method: "GET", path: "/say", handler: "hello" }] },
    });
    writeTenantConfig(TENANT, { plugins: { hello: { enabled: true } } }, home);
    const app = buildApp();

    const res = await request(app).get("/api/p/hello/missing");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("plugin_route_not_found");
  });

  it("returns 404 when the plugin is disabled", async () => {
    writeBuiltinManifest("hello", {
      id: "hello",
      version: "1.0.0",
      displayName: "Hello",
      server: { entry: "@hello/server" },
      contributes: { apiRoutes: [{ method: "GET", path: "/say", handler: "hello" }] },
    });
    // not enabled in tenant config
    const app = buildApp();

    const res = await request(app).get("/api/p/hello/say");
    expect(res.status).toBe(404);
  });

  it("dispatches plugin routes with `:id` path params", async () => {
    writeBuiltinManifest("hello", {
      id: "hello",
      version: "1.0.0",
      displayName: "Hello",
      server: { entry: "@hello/server" },
      contributes: {
        apiRoutes: [
          { method: "GET", path: "/things/:id", handler: "echoId" },
          {
            method: "POST",
            path: "/things/:id/sub/:action",
            handler: "echoTwo",
          },
          { method: "GET", path: "/things", handler: "hello" },
        ],
      },
    });
    writeTenantConfig(TENANT, { plugins: { hello: { enabled: true } } }, home);
    const app = buildApp();

    let res = await request(app).get("/api/p/hello/things/abc-123");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "abc-123" });

    res = await request(app).post("/api/p/hello/things/abc/sub/reset");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "abc", action: "reset" });

    // Static route still wins over the param route when the path
    // is a literal match.
    res = await request(app).get("/api/p/hello/things");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ greeting: "hi" });

    // A param route should NOT swallow a deeper path — single segment.
    res = await request(app).get("/api/p/hello/things/a/b");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("plugin_route_not_found");

    // url-encoded id is decoded before reaching the handler.
    res = await request(app).get("/api/p/hello/things/abc%2Fdef");
    // %2F isn't allowed in our segment regex, so this 404s rather
    // than feeding `abc/def` into the handler. (Document the
    // behaviour explicitly.)
    expect(res.status).toBe(404);
  });

  it("PATCH allows disabling an unknown plugin (prune stale entries)", async () => {
    // Pre-seed a stale entry in tenant config that has no manifest.
    writeTenantConfig(
      TENANT,
      { plugins: { ghost: { enabled: true } } },
      home,
    );
    const app = buildApp();

    const res = await request(app)
      .patch("/api/plugins/ghost")
      .send({ enabled: false });
    expect(res.status).toBe(200);

    const cfg = loadTenantConfig(TENANT, home);
    expect(cfg.plugins?.ghost).toEqual({ enabled: false });
  });

  it("POST /api/plugins/refresh calls reloadResolver before invalidating registry", async () => {
    let reloadCalls = 0;
    const app = buildApp({
      reloadResolver: async () => {
        reloadCalls++;
      },
    });
    const res = await request(app).post("/api/plugins/refresh");
    expect(res.status).toBe(200);
    expect(reloadCalls).toBe(1);
  });

  it("POST /api/plugins/refresh re-discovers on-disk plugins (ADR-0004 §16)", async () => {
    const app = buildApp();

    // First call: nothing on disk.
    let list = await request(app).get("/api/plugins");
    expect(list.body.plugins).toHaveLength(0);

    // Drop a new builtin while the server is running.
    writeBuiltinManifest("latecomer", {
      id: "latecomer",
      version: "1.0.0",
      displayName: "Latecomer",
      server: { entry: "@late/server" },
    });

    // GET still hits the cache from the first call — no rediscovery.
    list = await request(app).get("/api/plugins");
    expect(list.body.plugins).toHaveLength(0);

    // POST refresh invalidates and rediscovers.
    const refresh = await request(app).post("/api/plugins/refresh");
    expect(refresh.status).toBe(200);
    expect(refresh.body.plugins).toHaveLength(1);
    expect(refresh.body.plugins[0]).toMatchObject({
      id: "latecomer",
      state: "disabled",
    });
  });

  it("GET /api/plugins includes capabilities { provided, requires, missing }", async () => {
    writeBuiltinManifest("hello", {
      id: "hello",
      version: "1.0.0",
      displayName: "Hello",
      requires: ["sandbox.shell"],
      server: { entry: "@hello/server" },
    });
    const app = buildApp();
    const res = await request(app).get("/api/plugins");
    expect(res.status).toBe(200);
    expect(res.body.plugins[0].capabilities).toEqual({
      provided: [],
      requires: ["sandbox.shell"],
      missing: [],
    });
  });
});
