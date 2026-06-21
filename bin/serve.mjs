#!/usr/bin/env node
// Production startup entrypoint.
//
// Invoked from `npm run serve` (and the wizard-installed launchd
// plist, on global installs). Three responsibilities:
//
//   1. Resolve the package root from this file's own location so
//      we work regardless of cwd (launchd's WorkingDirectory may
//      or may not match the install dir; npm's $PWD may or may
//      not expand depending on the shell wrapping behaviour).
//
//   2. Set TIANSHU_WEB_DIST to the bundled web dist so the server
//      hosts the SPA on the API port — one process, one port.
//
//   3. Hand off to the server entry by importing it. Same Node
//      process, so signal handlers + the server's own
//      graceful-shutdown still fire correctly.
//
// We deliberately don't use `npm run dev`-style child processes
// here — that would re-enter the build chain (tsc / vite),
// which fails on global installs without devDependencies.
// See packages/server/src/setup/repo-root.ts (isDevelopmentCheckout)
// for the heuristic the wizard uses to pick `dev` vs `serve`.

import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const webDist = join(packageRoot, "packages", "web", "dist");
const serverDist = join(packageRoot, "packages", "server", "dist", "index.js");

if (existsSync(webDist) && existsSync(join(webDist, "index.html"))) {
  // The server reads this once at boot to decide whether to
  // mount express.static + SPA fallback. Leaving it unset is
  // the legitimate dev-mode signal — the server doesn't try to
  // serve static files when running alongside vite.
  process.env.TIANSHU_WEB_DIST = webDist;
}

if (!existsSync(serverDist)) {
  // eslint-disable-next-line no-console
  console.error(
    `[tianshu] serve: server dist not found at ${serverDist}.\n` +
      "This shouldn't happen on a global install. Try:\n" +
      "  npm install -g @tianshu-ai/tianshu@latest --force",
  );
  process.exit(1);
}

// Dynamic import so the resolution above is visible to the
// server (which reads process.env at module top-level).
await import(serverDist);
