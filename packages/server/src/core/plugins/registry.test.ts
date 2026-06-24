import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginServerModule } from "@tianshu-ai/plugin-sdk";
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

  it("builtin not listed in tenant config still appears as disabled (ADR-0004 §17)", async () => {
    writeBuiltinManifest("hidden", {
      id: "hidden",
      version: "1.0.0",
      displayName: "Hidden",
    });
    ops.create("acme");
    // No tenant plugins entry at all → discovery still finds builtin
    // and surfaces it as disabled so the Plugin Manager UI can show
    // it ("installed = on disk", config decides activation only).
    const ctx = ops.open("acme");
    const reg = new PluginRegistry({
      resolver: moduleMapResolver({}),
      discoveryDirs: { builtinConfigDir: builtinDir, home },
    });
    const entries = await reg.ensureForTenant(ctx);
    expect(entries[0]!.state).toBe("disabled");
    expect(entries[0]!.capabilityInfo).toEqual({
      provided: [],
      requires: [],
      missing: [],
    });
  });

  // ADR-0004 — capability + requires + exclusivity tests ----------

  it("sandbox.shell capability is registered when a sandboxes-shell contribution is present", async () => {
    writeBuiltinManifest("sb", {
      id: "sb",
      version: "1.0.0",
      displayName: "Sandbox",
      provides: ["sandbox.shell"],
      server: { entry: "@sb/server" },
      contributes: {
        sandboxes: [
          { id: "main", kind: "shell", displayName: "main", module: "Runner" },
        ],
      },
    });
    const fakeRunner = { id: "sb.main", kind: "shell" };
    ops.create("acme");
    writeTenantConfig("acme", { plugins: { sb: { enabled: true } } }, home);
    ops.poolRef.close("acme");
    const ctx = ops.open("acme");
    const reg = new PluginRegistry({
      resolver: moduleMapResolver({
        "@sb/server": {
          activate: () => ({ sandboxes: { Runner: fakeRunner } }),
        },
      }),
      discoveryDirs: { builtinConfigDir: builtinDir, home },
    });
    const entries = await reg.ensureForTenant(ctx);
    expect(entries[0]!.state).toBe("active");
    expect(entries[0]!.capabilityInfo.provided).toEqual(["sandbox.shell"]);
    expect(reg.capabilityFor(ctx.tenantId, "sandbox.shell")).toBe(fakeRunner);
  });

  it("requires capability that no plugin provides → plugin fails with named reason", async () => {
    writeBuiltinManifest("consumer", {
      id: "consumer",
      version: "1.0.0",
      displayName: "Consumer",
      requires: ["sandbox.shell"],
      server: { entry: "@consumer/server" },
    });
    ops.create("acme");
    writeTenantConfig("acme", { plugins: { consumer: { enabled: true } } }, home);
    ops.poolRef.close("acme");
    const ctx = ops.open("acme");
    const reg = new PluginRegistry({
      resolver: moduleMapResolver({
        "@consumer/server": { activate: () => ({}) },
      }),
      discoveryDirs: { builtinConfigDir: builtinDir, home },
    });
    const entries = await reg.ensureForTenant(ctx);
    expect(entries[0]!.state).toBe("failed");
    expect(entries[0]!.failedReason).toMatch(/requires capability "sandbox.shell"/);
    expect(entries[0]!.capabilityInfo.missing).toEqual(["sandbox.shell"]);
  });

  it("two providers of an exclusive capability → second one fails", async () => {
    const runnerA = { id: "a.main", kind: "shell" };
    const runnerB = { id: "b.main", kind: "shell" };
    for (const id of ["sba", "sbb"]) {
      writeBuiltinManifest(id, {
        id,
        version: "1.0.0",
        displayName: id,
        provides: ["sandbox.shell"],
        server: { entry: `@${id}/server` },
        contributes: {
          sandboxes: [
            { id: "main", kind: "shell", displayName: "main", module: "R" },
          ],
        },
      });
    }
    ops.create("acme");
    writeTenantConfig(
      "acme",
      { plugins: { sba: { enabled: true }, sbb: { enabled: true } } },
      home,
    );
    ops.poolRef.close("acme");
    const ctx = ops.open("acme");
    const reg = new PluginRegistry({
      resolver: moduleMapResolver({
        "@sba/server": { activate: () => ({ sandboxes: { R: runnerA } }) },
        "@sbb/server": { activate: () => ({ sandboxes: { R: runnerB } }) },
      }),
      discoveryDirs: { builtinConfigDir: builtinDir, home },
    });
    const entries = await reg.ensureForTenant(ctx);
    const byId = Object.fromEntries(entries.map((e) => [e.manifest.id, e]));
    // Topo order is alphabetical when no edges; sba wins.
    expect(byId.sba!.state).toBe("active");
    expect(byId.sbb!.state).toBe("failed");
    expect(byId.sbb!.failedReason).toMatch(/already provided by plugin sba/);
    expect(reg.capabilityFor(ctx.tenantId, "sandbox.shell")).toBe(runnerA);
  });

  it("requires → provider activation order is correct", async () => {
    const order: string[] = [];
    const runner = { id: "prov.main", kind: "shell" };
    writeBuiltinManifest("prov", {
      id: "prov",
      version: "1.0.0",
      displayName: "Provider",
      provides: ["sandbox.shell"],
      server: { entry: "@prov/server" },
      contributes: {
        sandboxes: [
          { id: "main", kind: "shell", displayName: "main", module: "R" },
        ],
      },
    });
    writeBuiltinManifest("cons", {
      id: "cons",
      version: "1.0.0",
      displayName: "Consumer",
      requires: ["sandbox.shell"],
      server: { entry: "@cons/server" },
    });
    ops.create("acme");
    writeTenantConfig(
      "acme",
      { plugins: { prov: { enabled: true }, cons: { enabled: true } } },
      home,
    );
    ops.poolRef.close("acme");
    const ctx = ops.open("acme");
    const reg = new PluginRegistry({
      resolver: moduleMapResolver({
        "@prov/server": {
          activate: () => {
            order.push("prov");
            return { sandboxes: { R: runner } };
          },
        },
        "@cons/server": {
          activate: (pluginCtx) => {
            order.push("cons");
            // Consumer's requires must be satisfied by the time it activates.
            expect(pluginCtx.capabilities.has("sandbox.shell")).toBe(true);
            expect(pluginCtx.capabilities.get("sandbox.shell")).toBe(runner);
            return {};
          },
        },
      }),
      discoveryDirs: { builtinConfigDir: builtinDir, home },
    });
    const entries = await reg.ensureForTenant(ctx);
    expect(order).toEqual(["prov", "cons"]);
    expect(entries.every((e) => e.state === "active")).toBe(true);
  });

  it("PluginContext.pluginConfig surfaces tenant config[plugins][id].config", async () => {
    writeBuiltinManifest("sink", {
      id: "sink",
      version: "1.0.0",
      displayName: "Sink",
      server: { entry: "@sink/server" },
    });
    let captured: unknown = null;
    ops.create("acme");
    writeTenantConfig(
      "acme",
      { plugins: { sink: { enabled: true, config: { foo: 42 } } } },
      home,
    );
    ops.poolRef.close("acme");
    const ctx = ops.open("acme");
    const reg = new PluginRegistry({
      resolver: moduleMapResolver({
        "@sink/server": {
          activate: (pluginCtx) => {
            captured = pluginCtx.pluginConfig;
            return {};
          },
        },
      }),
      discoveryDirs: { builtinConfigDir: builtinDir, home },
    });
    await reg.ensureForTenant(ctx);
    expect(captured).toEqual({ foo: 42 });
  });

  it("provides[sandbox.shell] without backing sandboxes contribution → manifest rejected", async () => {
    // Validator-level check (lives in core/plugins/manifest.ts): a
    // plugin can't claim provides["sandbox.shell"] without an actual
    // sandboxes[] contribution of kind=shell.
    writeBuiltinManifest("empty", {
      id: "empty",
      version: "1.0.0",
      displayName: "Empty",
      provides: ["sandbox.shell"],
      server: { entry: "@empty/server" },
    });
    ops.create("acme");
    writeTenantConfig("acme", { plugins: { empty: { enabled: true } } }, home);
    ops.poolRef.close("acme");
    const ctx = ops.open("acme");
    const reg = new PluginRegistry({
      resolver: moduleMapResolver({
        "@empty/server": { activate: () => ({}) },
      }),
      discoveryDirs: { builtinConfigDir: builtinDir, home },
    });
    const entries = await reg.ensureForTenant(ctx);
    expect(entries[0]!.state).toBe("failed");
    expect(entries[0]!.failedReason).toMatch(
      /declared provides\["sandbox\.shell"\] without a backing sandboxes/,
    );
  });

  // ADR-0004 N+3 — contributes.tools[] -----------------------------------

  it("toolsForTenant() collects tools from every active plugin", async () => {
    writeBuiltinManifest("toolsy", {
      id: "toolsy",
      version: "1.0.0",
      displayName: "Toolsy",
      server: { entry: "@toolsy/server" },
      contributes: {
        tools: [
          { id: "first", module: "FirstTool" },
          { id: "second", module: "SecondTool" },
        ],
      },
    });
    const FirstTool = {
      schema: { name: "first", description: "", parameters: { type: "object" } },
      execute: async () => ({ ok: true }),
    };
    const SecondTool = {
      schema: { name: "second", description: "", parameters: { type: "object" } },
      execute: async () => ({ ok: true }),
    };
    ops.create("acme");
    writeTenantConfig("acme", { plugins: { toolsy: { enabled: true } } }, home);
    ops.poolRef.close("acme");
    const ctx = ops.open("acme");
    const reg = new PluginRegistry({
      resolver: moduleMapResolver({
        "@toolsy/server": {
          activate: () => ({ tools: { FirstTool, SecondTool } }),
        },
      }),
      discoveryDirs: { builtinConfigDir: builtinDir, home },
    });
    await reg.ensureForTenant(ctx);
    const tools = reg.toolsForTenant(ctx.tenantId);
    expect(tools.map((t) => t.tool.schema.name).sort()).toEqual(["first", "second"]);
    expect(tools[0]!.pluginId).toBe("toolsy");
  });

  it("missing tool module marks the plugin failed when toolsForTenant() is called", async () => {
    writeBuiltinManifest("broken-tools", {
      id: "broken-tools",
      version: "1.0.0",
      displayName: "Broken",
      server: { entry: "@broken/server" },
      contributes: {
        tools: [{ id: "missing", module: "NotExported" }],
      },
    });
    ops.create("acme");
    writeTenantConfig("acme", { plugins: { "broken-tools": { enabled: true } } }, home);
    ops.poolRef.close("acme");
    const ctx = ops.open("acme");
    const reg = new PluginRegistry({
      resolver: moduleMapResolver({
        "@broken/server": { activate: () => ({ tools: {} }) },
      }),
      discoveryDirs: { builtinConfigDir: builtinDir, home },
    });
    await reg.ensureForTenant(ctx);
    reg.toolsForTenant(ctx.tenantId);
    const entries = reg.listForTenant(ctx.tenantId);
    expect(entries[0]!.state).toBe("failed");
    expect(entries[0]!.failedReason).toMatch(/tools\["NotExported"\] missing/);
  });

  // chore-ai/plugin-sdk-cleanup: invalidate() must call each active
  // plugin's deactivate() so resources (sandbox VMs, child procs,
  // watchers) get released before the next ensureForTenant().
  it("invalidate calls deactivate() on active plugins (reverse order)", async () => {
    const order: string[] = [];
    writeBuiltinManifest("prov", {
      id: "prov",
      version: "1.0.0",
      displayName: "Prov",
      provides: ["sandbox.shell"],
      server: { entry: "@prov/server" },
      contributes: {
        sandboxes: [
          { id: "main", kind: "shell", displayName: "main", module: "R" },
        ],
      },
    });
    writeBuiltinManifest("cons", {
      id: "cons",
      version: "1.0.0",
      displayName: "Cons",
      requires: ["sandbox.shell"],
      server: { entry: "@cons/server" },
    });
    ops.create("acme");
    writeTenantConfig(
      "acme",
      { plugins: { prov: { enabled: true }, cons: { enabled: true } } },
      home,
    );
    ops.poolRef.close("acme");
    const ctx = ops.open("acme");
    const runner = { id: "prov.main", kind: "shell" };
    const reg = new PluginRegistry({
      resolver: moduleMapResolver({
        "@prov/server": {
          activate: () => ({ sandboxes: { R: runner } }),
          deactivate: () => {
            order.push("prov");
          },
        },
        "@cons/server": {
          activate: () => ({}),
          deactivate: () => {
            order.push("cons");
          },
        },
      }),
      discoveryDirs: { builtinConfigDir: builtinDir, home },
    });
    await reg.ensureForTenant(ctx);
    await reg.invalidate(ctx.tenantId);
    // Both deactivated. v0 ordering is reverse-of-entries (entries
    // are id-sorted) which is good enough — plugins shouldn't rely
    // on each other's capabilities during deactivate. A future PR
    // can promote this to true reverse-topological if a plugin
    // needs that.
    expect(order.sort()).toEqual(["cons", "prov"]);
  });

  it("invalidate swallows deactivate() errors and continues", async () => {
    writeBuiltinManifest("alpha", {
      id: "alpha",
      version: "1.0.0",
      displayName: "A",
      server: { entry: "@a/server" },
    });
    writeBuiltinManifest("beta", {
      id: "beta",
      version: "1.0.0",
      displayName: "B",
      server: { entry: "@b/server" },
    });
    let bDeactivated = false;
    ops.create("acme");
    writeTenantConfig(
      "acme",
      { plugins: { alpha: { enabled: true }, beta: { enabled: true } } },
      home,
    );
    ops.poolRef.close("acme");
    const ctx = ops.open("acme");
    const reg = new PluginRegistry({
      resolver: moduleMapResolver({
        "@a/server": {
          activate: () => ({}),
          deactivate: () => {
            throw new Error("a-fails");
          },
        },
        "@b/server": {
          activate: () => ({}),
          deactivate: () => {
            bDeactivated = true;
          },
        },
      }),
      discoveryDirs: { builtinConfigDir: builtinDir, home },
    });
    await reg.ensureForTenant(ctx);
    await expect(reg.invalidate(ctx.tenantId)).resolves.toBeUndefined();
    expect(bDeactivated).toBe(true);
  });

  describe("refreshStaleToolsets", () => {
    function makeProvider(opts: {
      name: string;
      stale: boolean;
      onRefresh: () => void;
    }): import("@tianshu-ai/plugin-sdk").ToolsetProvider {
      const snapshotState = opts.stale
        ? {
            name: opts.name,
            prefix: "",
            endpoint: undefined,
            tools: [],
            lastRefreshAt: undefined,
            lastError: undefined,
          }
        : {
            name: opts.name,
            prefix: "",
            endpoint: "http://127.0.0.1:9999",
            tools: [{ toolName: "x", upstream: { name: "x" } }],
            lastRefreshAt: Date.now(),
            lastError: undefined,
          };
      return {
        name: opts.name,
        snapshot: () => snapshotState,
        listTools: () => [],
        refresh: async () => {
          opts.onRefresh();
        },
      } as unknown as import("@tianshu-ai/plugin-sdk").ToolsetProvider;
    }

    async function setupTenantWithToolsets(providers: Record<string, import("@tianshu-ai/plugin-sdk").ToolsetProvider>) {
      writeBuiltinManifest("toolsetshost", {
        id: "toolsetshost",
        version: "1.0.0",
        displayName: "With toolsets",
        server: { entry: "@toolsets/server" },
        contributes: {
          toolsets: Object.keys(providers).map((id) => ({
            id,
            module: id,
            displayName: id,
          })),
        },
      });
      ops.create("acme");
      writeTenantConfig(
        "acme",
        { plugins: { toolsetshost: { enabled: true } } },
        home,
      );
      ops.poolRef.close("acme");
      const ctx = ops.open("acme");
      const mod: PluginServerModule = {
        activate: () => ({
          toolsetProviders: providers as unknown as Record<
            string,
            import("@tianshu-ai/plugin-sdk").ToolsetProvider
          >,
        }),
      };
      const reg = new PluginRegistry({
        resolver: moduleMapResolver({ "@toolsets/server": mod }),
        discoveryDirs: { builtinConfigDir: builtinDir, home },
      });
      await reg.ensureForTenant(ctx);
      return { reg, ctx };
    }

    it("refreshes only stale providers and skips healthy ones", async () => {
      const calls = { stale: 0, fresh: 0 };
      const { reg, ctx } = await setupTenantWithToolsets({
        stale: makeProvider({
          name: "stale",
          stale: true,
          onRefresh: () => calls.stale++,
        }),
        fresh: makeProvider({
          name: "fresh",
          stale: false,
          onRefresh: () => calls.fresh++,
        }),
      });
      const refreshed = await reg.refreshStaleToolsets(ctx.tenantId, 2000);
      expect(refreshed).toBe(1);
      expect(calls.stale).toBe(1);
      expect(calls.fresh).toBe(0);
    });

    it("swallows per-toolset refresh errors", async () => {
      const { reg, ctx } = await setupTenantWithToolsets({
        bad: {
          name: "bad",
          snapshot: () => ({
            name: "bad",
            prefix: "",
            endpoint: undefined,
            tools: [],
            lastRefreshAt: undefined,
            lastError: undefined,
          }),
          listTools: () => [],
          refresh: async () => {
            throw new Error("upstream-down");
          },
        } as unknown as import("@tianshu-ai/plugin-sdk").ToolsetProvider,
      });
      // Doesn't throw; counts the call regardless of outcome.
      await expect(
        reg.refreshStaleToolsets(ctx.tenantId, 2000),
      ).resolves.toBe(1);
    });

    it("returns 0 when nothing is stale", async () => {
      const { reg, ctx } = await setupTenantWithToolsets({
        a: makeProvider({ name: "a", stale: false, onRefresh: () => {} }),
        b: makeProvider({ name: "b", stale: false, onRefresh: () => {} }),
      });
      await expect(
        reg.refreshStaleToolsets(ctx.tenantId, 2000),
      ).resolves.toBe(0);
    });

    it("caps total wait at deadlineMs even when refresh hangs", async () => {
      let resolved = false;
      const slow: import("@tianshu-ai/plugin-sdk").ToolsetProvider = {
        name: "slow",
        snapshot: () => ({
          name: "slow",
          prefix: "",
          endpoint: undefined,
          tools: [],
          lastRefreshAt: undefined,
          lastError: undefined,
        }),
        listTools: () => [],
        refresh: () =>
          new Promise<void>((r) => {
            setTimeout(() => {
              resolved = true;
              r();
            }, 10_000);
          }),
      } as unknown as import("@tianshu-ai/plugin-sdk").ToolsetProvider;
      const { reg, ctx } = await setupTenantWithToolsets({ slow });
      const t0 = Date.now();
      const count = await reg.refreshStaleToolsets(ctx.tenantId, 100);
      const elapsed = Date.now() - t0;
      expect(count).toBe(1);
      expect(elapsed).toBeLessThan(2000);
      expect(resolved).toBe(false);
    });
  });

  // -------- host-owned tools (opts.hostTools) -----------------------------

  describe("hostTools", () => {
    const fakeTool = {
      schema: {
        name: "host_owned_tool",
        description: "Demo host-owned.",
        parameters: { type: "object" },
      },
      execute: async () => ({ ok: true }),
    };

    it("toolsForTenant() includes host-owned tools under pluginId 'core'", async () => {
      ops.create("acme");
      writeTenantConfig("acme", { plugins: {} }, home);
      ops.poolRef.close("acme");
      const ctx = ops.open("acme");
      const reg = new PluginRegistry({
        resolver: moduleMapResolver({}),
        discoveryDirs: { builtinConfigDir: builtinDir, home },
        hostTools: [
          { name: "host_owned_tool", since: "0.3.22", tool: fakeTool },
        ],
      });
      await reg.ensureForTenant(ctx);
      const tools = reg.toolsForTenant(ctx.tenantId);
      expect(tools).toHaveLength(1);
      expect(tools[0]!.pluginId).toBe("core");
      expect(tools[0]!.tool.schema.name).toBe("host_owned_tool");
    });

    it("toolCatalogForTenant() reports host-owned tools with their since", async () => {
      ops.create("acme");
      writeTenantConfig("acme", { plugins: {} }, home);
      ops.poolRef.close("acme");
      const ctx = ops.open("acme");
      const reg = new PluginRegistry({
        resolver: moduleMapResolver({}),
        discoveryDirs: { builtinConfigDir: builtinDir, home },
        hostTools: [
          { name: "host_owned_tool", since: "0.3.22", tool: fakeTool },
        ],
      });
      await reg.ensureForTenant(ctx);
      const cat = reg.toolCatalogForTenant(ctx.tenantId);
      const entry = cat.find((c) => c.toolName === "host_owned_tool");
      expect(entry).toBeTruthy();
      expect(entry!.pluginId).toBe("core");
      expect(entry!.since).toBe("0.3.22");
      expect(entry!.description).toBe("Demo host-owned.");
    });

    it("hostTools coexist with plugin-contributed tools", async () => {
      writeBuiltinManifest("toolsy", {
        id: "toolsy",
        version: "1.0.0",
        displayName: "Toolsy",
        server: { entry: "@toolsy/server" },
        contributes: {
          tools: [{ id: "plug_tool", module: "PlugTool", since: "0.1.0" }],
        },
      });
      const PlugTool = {
        schema: {
          name: "plug_tool",
          description: "plug",
          parameters: { type: "object" },
        },
        execute: async () => ({ ok: true }),
      };
      ops.create("acme");
      writeTenantConfig("acme", { plugins: { toolsy: { enabled: true } } }, home);
      ops.poolRef.close("acme");
      const ctx = ops.open("acme");
      const reg = new PluginRegistry({
        resolver: moduleMapResolver({
          "@toolsy/server": {
            activate: () => ({ tools: { PlugTool } }),
          },
        }),
        discoveryDirs: { builtinConfigDir: builtinDir, home },
        hostTools: [
          { name: "host_owned_tool", since: "0.3.22", tool: fakeTool },
        ],
      });
      await reg.ensureForTenant(ctx);
      const tools = reg.toolsForTenant(ctx.tenantId);
      const names = tools.map((t) => t.tool.schema.name).sort();
      expect(names).toEqual(["host_owned_tool", "plug_tool"]);
      const cat = reg.toolCatalogForTenant(ctx.tenantId);
      const byPlugin = Object.fromEntries(cat.map((c) => [c.toolName, c.pluginId]));
      expect(byPlugin.plug_tool).toBe("toolsy");
      expect(byPlugin.host_owned_tool).toBe("core");
    });
  });
});
