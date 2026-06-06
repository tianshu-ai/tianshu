import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildBuiltinResolver,
  buildReloadingBuiltinResolver,
} from "./builtin-loader.js";

let pluginsRoot: string;
let logs: Array<{ level: "info" | "warn"; msg: string }>;

beforeEach(() => {
  pluginsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-builtin-loader-"));
  logs = [];
});

afterEach(() => {
  fs.rmSync(pluginsRoot, { recursive: true, force: true });
});

const log = (level: "info" | "warn", msg: string) => logs.push({ level, msg });

function writePlugin(
  id: string,
  manifest: object,
  serverModuleSource?: string,
): void {
  const dir = path.join(pluginsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  if (serverModuleSource) {
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "server.js"), serverModuleSource);
  }
}

describe("buildBuiltinResolver", () => {
  it("loads a plugin's compiled server module by manifest.server.entry", async () => {
    writePlugin(
      "alpha",
      {
        id: "alpha",
        version: "1.0.0",
        displayName: "Alpha",
        server: { entry: "@scope/alpha/server" },
      },
      // Plain ESM with `export default`.
      "export default { activate: () => ({ routes: { ping: () => 'pong' } }) };\n",
    );
    const resolver = await buildBuiltinResolver({ pluginsRoot, log });
    const mod = await resolver.resolve("@scope/alpha/server");
    expect(mod).not.toBeNull();
    expect(typeof mod!.activate).toBe("function");
  });

  it("accepts both `export default { activate }` and named `export function activate`", async () => {
    writePlugin(
      "beta",
      {
        id: "beta",
        version: "1.0.0",
        displayName: "Beta",
        server: { entry: "@scope/beta/server" },
      },
      "export function activate() { return { routes: {} }; }\n",
    );
    const resolver = await buildBuiltinResolver({ pluginsRoot, log });
    const mod = await resolver.resolve("@scope/beta/server");
    expect(mod).not.toBeNull();
    expect(typeof mod!.activate).toBe("function");
  });

  it("logs a warning and skips a plugin missing dist/server.js", async () => {
    writePlugin("gamma", {
      id: "gamma",
      version: "1.0.0",
      displayName: "Gamma",
      server: { entry: "@scope/gamma/server" },
    });
    const resolver = await buildBuiltinResolver({ pluginsRoot, log });
    expect(await resolver.resolve("@scope/gamma/server")).toBeNull();
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("missing"))).toBe(true);
  });

  it("ignores client-only plugins (no server.entry) without warning", async () => {
    writePlugin("delta", {
      id: "delta",
      version: "1.0.0",
      displayName: "Delta",
      client: { entry: "@scope/delta/client" },
    });
    const resolver = await buildBuiltinResolver({ pluginsRoot, log });
    expect(await resolver.resolve("@scope/delta/client")).toBeNull();
    expect(logs.filter((l) => l.level === "warn")).toEqual([]);
  });

  it("skips a plugin whose JSON is malformed", async () => {
    const dir = path.join(pluginsRoot, "epsilon");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), "not json");
    const resolver = await buildBuiltinResolver({ pluginsRoot, log });
    expect(await resolver.resolve("@scope/epsilon/server")).toBeNull();
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("bad manifest.json"))).toBe(true);
  });

  it("returns an empty resolver if pluginsRoot does not exist", async () => {
    fs.rmSync(pluginsRoot, { recursive: true });
    const resolver = await buildBuiltinResolver({ pluginsRoot, log });
    expect(await resolver.resolve("@anything")).toBeNull();
  });

  it("reloading resolver picks up plugins added after construction", async () => {
    // Boot with one plugin only.
    writePlugin(
      "alpha",
      {
        id: "alpha",
        version: "1.0.0",
        displayName: "Alpha",
        server: { entry: "@scope/alpha/server" },
      },
      "export default { activate: () => ({}) };\n",
    );
    const resolver = await buildReloadingBuiltinResolver({ pluginsRoot, log });
    expect(await resolver.resolve("@scope/alpha/server")).not.toBeNull();
    expect(await resolver.resolve("@scope/late/server")).toBeNull();

    // Drop a second plugin while the server is running.
    writePlugin(
      "late",
      {
        id: "late",
        version: "1.0.0",
        displayName: "Late",
        server: { entry: "@scope/late/server" },
      },
      "export default { activate: () => ({}) };\n",
    );

    // Until reload(), the resolver still doesn't see it.
    expect(await resolver.resolve("@scope/late/server")).toBeNull();

    await resolver.reload();
    expect(await resolver.resolve("@scope/late/server")).not.toBeNull();
    // Old entry survives.
    expect(await resolver.resolve("@scope/alpha/server")).not.toBeNull();
  });

  it("ignores entries starting with . or _", async () => {
    writePlugin(
      "_internal",
      {
        id: "x",
        version: "1.0.0",
        displayName: "X",
        server: { entry: "@scope/x/server" },
      },
      "export default { activate: () => ({}) };\n",
    );
    const resolver = await buildBuiltinResolver({ pluginsRoot, log });
    expect(await resolver.resolve("@scope/x/server")).toBeNull();
  });

  // chore/plugin-sdk-cleanup: dist file mtime is appended as a query
  // string so re-importing after a rebuild bypasses Node's ESM cache.
  // Without this, plugin authors had to restart the server every
  // edit — which is exactly the pain that motivated the fix.
  it("reload picks up edited plugin code on the next import (cache-bust)", async () => {
    const id = "shifty";
    writePlugin(
      id,
      {
        id,
        version: "1.0.0",
        displayName: "Shifty",
        server: { entry: "@shifty/server" },
      },
      "export default { activate: () => ({ marker: 'v1' }) };\n",
    );
    const resolver = await buildReloadingBuiltinResolver({ pluginsRoot, log });
    const v1 = await resolver.resolve("@shifty/server");
    expect(v1).not.toBeNull();
    const out1 = await (
      v1!.activate as () => Promise<{ marker: string }>
    )();
    expect(out1.marker).toBe("v1");

    // Edit the file in place; bump mtime so the cache-bust query
    // string changes.
    const distFile = path.join(pluginsRoot, id, "dist", "server.js");
    fs.writeFileSync(
      distFile,
      "export default { activate: () => ({ marker: 'v2' }) };\n",
    );
    const future = (Date.now() + 1000) / 1000;
    fs.utimesSync(distFile, future, future);

    await resolver.reload();
    const v2 = await resolver.resolve("@shifty/server");
    const out2 = await (
      v2!.activate as () => Promise<{ marker: string }>
    )();
    expect(out2.marker).toBe("v2");
  });
});
