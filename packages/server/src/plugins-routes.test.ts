// End-to-end tests for the plugins HTTP surface: GET /api/plugins
// and PATCH /api/plugins/:id (Plugin Manager backend).
//
// We mount the router on a freshly built Express app with a
// tenant-middleware override that pins every request to a known
// tenant id. No real auth, no socket, no shutdown plumbing — keeps
// test setup small and the failure surface focused on routing +
// config persistence.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import type { PluginServerModule } from "@tianshu/plugin-sdk";

import { DbPool } from "./core/db-pool.js";
import { GlobalOps } from "./core/global-ops.js";
import { writeTenantConfig, loadTenantConfig } from "./core/config.js";
import { tenantMiddleware } from "./core/middleware.js";
import {
  moduleMapResolver,
  PluginRegistry,
} from "./core/plugins/index.js";
import { buildPluginsRouter } from "./plugins-routes.js";

const TENANT = "acme";

let home: string;
let builtinDir: string;
let ops: GlobalOps;
let registry: PluginRegistry;

const helloModule: PluginServerModule = {
  activate: () => ({
    routes: { hello: (_req, res) => res.json({ greeting: "hi" }) },
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

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    tenantMiddleware({
      ops,
      resolveIdentity: () => ({ tenantId: TENANT, userId: "user_test" }),
    }),
  );
  app.use("/api", buildPluginsRouter({ registry, ops }));
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

  it("PATCH rejects bad plugin id format", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/api/plugins/Bad_ID!")
      .send({ enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_plugin_id");
  });

  it("PATCH rejects missing or non-boolean enabled", async () => {
    writeBuiltinManifest("hello", {
      id: "hello",
      version: "1.0.0",
      displayName: "Hello",
      server: { entry: "@hello/server" },
    });
    const app = buildApp();

    let res = await request(app).patch("/api/plugins/hello").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_enabled_boolean");

    res = await request(app)
      .patch("/api/plugins/hello")
      .send({ enabled: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_enabled_boolean");
  });

  it("PATCH refuses to enable an unknown plugin (404)", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/api/plugins/ghost")
      .send({ enabled: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("plugin_not_found");
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
});
