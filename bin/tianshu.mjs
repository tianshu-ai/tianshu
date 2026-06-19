#!/usr/bin/env node
// `tianshu` CLI entrypoint.
//
// This file is the stable bin shim shipped with `npm install -g @tianshu-ai/tianshu`.
// It defers to packages/server/dist/cli.js for the actual command
// implementations; we re-export `main(argv)` from there so the
// shim stays minimal and forward-compatible.
//
// We resolve the dist path *relative to this file* rather than the
// CWD so the bin works regardless of where the user runs it from
// (npm install -g lands this in /usr/local/bin or similar; the
// dist sits a few dirs up).

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(here, "..", "packages", "server", "dist", "cli.js");

if (!existsSync(distEntry)) {
  console.error(
    `[tianshu] cli build missing: ${distEntry}\n\n` +
      `If you cloned the repo, run \`npm install && npm run build\` first.\n` +
      `If you installed via npm and see this, please file a bug — the package is broken.`,
  );
  process.exit(1);
}

const { main } = await import(distEntry);
const code = await main(process.argv.slice(2));
process.exit(typeof code === "number" ? code : 0);
