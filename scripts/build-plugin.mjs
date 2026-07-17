// Shared plugin build: bundle the SERVER entry with its third-party JS
// deps inlined, then emit .d.ts with tsc.
//
// Why bundle the server entry
// ---------------------------
// A plugin is its own package with its own `dependencies` (e.g. cron →
// croner, wechat → qrcode). But the product ships as ONE published npm
// package (`@tianshu-ai/tianshu`): the plugins' `dist/` land in that
// package as static files, WITHOUT their per-plugin node_modules. npm
// doesn't install a nested package's deps for a consumer of the root
// package, so at runtime `plugins/<id>/dist/server.js` would `import
// "croner"` and fail — the builtin-loader catches the import error and
// marks the plugin `failed` ("server.entry not registered").
//
// Hoisting each plugin dep into the root package.json "works" but
// breaks the point of plugins being independent: adding a dep to a
// plugin shouldn't require editing the host package. So instead we
// make each plugin's server bundle SELF-CONTAINED: esbuild inlines the
// third-party JS deps into dist/server.js. The only things left
// external are what the HOST provides at runtime (the SDK, native
// addons) and node builtins.
//
// The CLIENT entry is NOT bundled here: dist/client.js is consumed by
// the web build via `import.meta.glob(..., { eager: true })`, so React
// / lucide-react / the SDK client are resolved by the web bundle's own
// dependency tree, not the plugin's. We only tsc it for types + a
// transpiled module the web glob can pick up.
//
// Usage (from a plugin dir, via its package.json "build" script):
//   node ../../scripts/build-plugin.mjs
//
// Assumes the standard plugin layout: src/server.ts (+ optional
// src/client.tsx), tsconfig.json extending the repo base.

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const pluginDir = process.cwd();
const pkg = JSON.parse(
  fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"),
);
const label = pkg.name ?? path.basename(pluginDir);

const serverEntry = path.join(pluginDir, "src", "server.ts");
const clientEntryTs = path.join(pluginDir, "src", "client.tsx");
const clientEntryTsx = fs.existsSync(clientEntryTs)
  ? clientEntryTs
  : path.join(pluginDir, "src", "client.ts");
const hasServer = fs.existsSync(serverEntry);
const hasClient = fs.existsSync(clientEntryTsx);

// Everything the HOST supplies at runtime must stay external — never
// bundle a second copy into the plugin. Anything else (croner, qrcode,
// typebox, …) gets inlined so the published single package is
// self-sufficient without the plugin's own node_modules.
//
// - @tianshu-ai/plugin-sdk (+ subpaths): injected by the host; a
//   bundled copy would break the singleton globals (useComposer, WS
//   API, capability registry).
// - better-sqlite3 / sharp / other native addons: the host owns the
//   compiled binary; a plugin gets its DB handle via ctx.db.
// - express: the host's HTTP layer; plugins only import its types.
const EXTERNAL = [
  "@tianshu-ai/plugin-sdk",
  "@tianshu-ai/plugin-sdk/*",
  "better-sqlite3",
  "sharp",
  "express",
];

async function bundleServer() {
  if (!hasServer) return;
  await build({
    entryPoints: [serverEntry],
    outfile: path.join(pluginDir, "dist", "server.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // node builtins are external automatically on platform:node.
    external: EXTERNAL,
    sourcemap: true,
    logLevel: "info",
    // Keep import.meta / dynamic require working in ESM output.
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
  });
}

// Types-only tsc pass: emits .d.ts (+ maps) for both entries without
// re-emitting the JS esbuild already produced for the server, and
// producing the client JS the web glob imports. We run tsc with
// emitDeclarationOnly for the server side but still need client JS, so
// the simplest robust path is: tsc emits everything to dist, THEN we
// overwrite dist/server.js with the bundled one. To avoid a race we
// bundle the server AFTER tsc.
function tscEmit() {
  const res = spawnSync(
    "npx",
    ["tsc", "-p", path.join(pluginDir, "tsconfig.json")],
    { cwd: pluginDir, stdio: "inherit" },
  );
  if (res.status !== 0) {
    console.error(`[build-plugin] ${label}: tsc failed`);
    process.exit(res.status ?? 1);
  }
}

async function main() {
  // 1. tsc first: type-check everything + emit .d.ts and the client JS
  //    (dist/client.js) the web build consumes. It also emits a
  //    dist/server.js, which we immediately replace below.
  tscEmit();
  // 2. Re-emit dist/server.js as a self-contained bundle (deps inlined,
  //    host-provided packages external). Overwrites tsc's server.js.
  await bundleServer();
  console.log(
    `[build-plugin] ${label}: built${hasServer ? " server(bundled)" : ""}${
      hasClient ? " client" : ""
    } + types`,
  );
}

main().catch((err) => {
  console.error(`[build-plugin] ${label}: ${err?.message ?? err}`);
  process.exit(1);
});
