import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginServerModule } from "@tianshu/plugin-sdk";
import { DbPool } from "../db-pool.js";
import { GlobalOps } from "../global-ops.js";
import { writeTenantConfig } from "../config.js";
import {
  collectRoutesForTenant,
  moduleMapResolver,
  PluginRegistry,
} from "./registry.js";

let home: string;
let builtinDir: string;
let ops: GlobalOps;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-plug-"));
  builtinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-builtin-"));
  ops = new GlobalOps({ home, pool: new DbPool({ home }) });
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

const helloModule: PluginServerModule = {
  activate: () => ({
    routes: { hello: (_req, res) => res.json({ greeting: "hi" }) },
    wsHandlers: { ping: () => {} },
  }),
};

describe("PluginRegistry", () => {
  it("listed-but-disabled plugin returns state=disabled", async () => {
    writeBuiltinManifest("hello", {
      id: "hello",
      version: "1.0.0",
      displayName: "Hello",
      server: { entry: "@hello/server" },
      contributes: { apiRoutes: [{ method: "GET", path: "/x", handler: "hello" }] },
    });
    const ctx = ops.create("acme");
    writeTenantConfig("acme", { plugins: { hello: { enabled: false } } }, home);
    // re-open to pick up new config
    ops.poolRef.close("acme");
    const ctx2 = ops.open("acme");
    const reg = new PluginRegistry({
      resolver: moduleMapResolver({ "@hello/server": helloModule }),
      discoveryDirs: { builtinConfigDir: builtinDir, home },
    });
    const entries = await reg.ensureForTenant(ctx2);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.state).toBe("disabled");
    expect(ctx).toBeDefined();
  });

  it("enabled plugin activates and surfaces routes", async () => {
    writeBuiltinManifest("hello", {
      id: "hello",
      version: "1.0.0",
      displayName: "Hello",
      server: { entry: "@hello/server" },
      contributes: { apiRoutes: [{ method: "GET", path: "/x", handler: "hello" }] },
    });
    ops.create("acme");
    writeTenantConfig("acme", { plugins: { hello: { enabled: true } } }, home);
    ops.poolRef.close("acme");
    const ctx = ops.open("acme");
    const reg = new PluginRegistry({
      resolver: moduleMapResolver({ "@hello/server": helloModule }),
      discoveryDirs: { builtinConfigDir: builtinDir, home },
    });
    await reg.ensureForTenant(ctx);
    const routes = collectRoutesForTenant(reg, ctx.tenantId);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.method).toBe("GET");
    expect(routes[0]!.path).toBe("/x");
  });

  it("missing route handler marks the plugin failed", async () => {
    writeBuiltinManifest("broken", {
      id: "broken",
      version: "1.0.0",
      displayName: "Broken",
      server: { entry: "@broken/server" },
      contributes: { apiRoutes: [{ method: "GET", path: "/x", handler: "wrong" }] },
    });
    ops.create("acme");
    writeTenantConfig("acme", { plugins: { broken: { enabled: true } } }, home);
    ops.poolRef.close("acme");
    const ctx = ops.open("acme");
    const reg = new PluginRegistry({
      resolver: moduleMapResolver({ "@broken/server": helloModule }),
      discoveryDirs: { builtinConfigDir: builtinDir, home },
    });
    await reg.ensureForTenant(ctx);
    collectRoutesForTenant(reg, ctx.tenantId);
    const entries = reg.listForTenant(ctx.tenantId);
    expect(entries[0]!.state).toBe("failed");
    expect(entries[0]!.failedReason).toMatch(/wrong/);
  });

  it("activate() throwing fails only that plugin", async () => {
    writeBuiltinManifest("good", {
      id: "good",
      version: "1.0.0",
      displayName: "Good",
      server: { entry: "@good/server" },
    });
    writeBuiltinManifest("bad", {
      id: "bad",
      version: "1.0.0",
      displayName: "Bad",
      server: { entry: "@bad/server" },
    });
    ops.create("acme");
    writeTenantConfig(
      "acme",
      { plugins: { good: { enabled: true }, bad: { enabled: true } } },
      home,
    );
    ops.poolRef.close("acme");
    const ctx = ops.open("acme");
    const reg = new PluginRegistry({
      resolver: moduleMapResolver({
        "@good/server": helloModule,
        "@bad/server": { activate: () => { throw new Error("boom"); } },
      }),
      discoveryDirs: { builtinConfigDir: builtinDir, home },
    });
    const entries = await reg.ensureForTenant(ctx);
    const byId = Object.fromEntries(entries.map((e) => [e.manifest.id, e]));
    expect(byId.good!.state).toBe("active");
    expect(byId.bad!.state).toBe("failed");
    expect(byId.bad!.failedReason).toMatch(/boom/);
  });

  it("invalid manifest.json is collected as failed", async () => {
    const dir = path.join(builtinDir, "plugins", "junk");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), "not json");
    ops.create("acme");
    const ctx = ops.open("acme");
    const reg = new PluginRegistry({
      resolver: moduleMapResolver({}),
      discoveryDirs: { builtinConfigDir: builtinDir, home },
    });
    const entries = await reg.ensureForTenant(ctx);
    expect(entries.length).toBe(1);
    expect(entries[0]!.state).toBe("failed");
  });

  it("tenant manifest replaces builtin with same id", async () => {
    writeBuiltinManifest("hello", {
      id: "hello",
      version: "1.0.0",
      displayName: "Builtin Hello",
    });
    ops.create("acme");
    writeTenantConfig("acme", { plugins: { hello: { enabled: false } } }, home);
    ops.poolRef.close("acme");
    const ctx = ops.open("acme");
    const tenantPluginDir = path.join(
      ctx.workspaceDir,
      "_tenant",
      "config",
      "plugins",
      "hello",
    );
    fs.mkdirSync(tenantPluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(tenantPluginDir, "manifest.json"),
      JSON.stringify({ id: "hello", version: "2.0.0", displayName: "Tenant Hello" }),
    );
    const reg = new PluginRegistry({
      resolver: moduleMapResolver({}),
      discoveryDirs: { builtinConfigDir: builtinDir, home },
    });
    const entries = await reg.ensureForTenant(ctx);
    expect(entries[0]!.manifest.displayName).toBe("Tenant Hello");
    expect(entries[0]!.manifest.version).toBe("2.0.0");
    expect(entries[0]!.source).toBe("tenant");
  });

  it("not listed = invisible (not in /api/plugins output)", async () => {
    writeBuiltinManifest("hidden", {
      id: "hidden",
      version: "1.0.0",
      displayName: "Hidden",
    });
    ops.create("acme");
    // No tenant plugins entry at all → discovery still finds builtin,
    // but config marks it disabled. ADR-0003 §4: not listed and
    // disabled differ semantically; both surface in listForTenant() so
    // an admin can see what's available, with state=disabled.
    const ctx = ops.open("acme");
    const reg = new PluginRegistry({
      resolver: moduleMapResolver({}),
      discoveryDirs: { builtinConfigDir: builtinDir, home },
    });
    const entries = await reg.ensureForTenant(ctx);
    expect(entries[0]!.state).toBe("disabled");
  });
});
