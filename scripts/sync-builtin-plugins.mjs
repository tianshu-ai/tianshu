// Copy plugin manifests from `plugins/<id>/manifest.json` to
// `packages/server/builtinConfig/plugins/<id>/manifest.json` so the
// server can discover them at runtime without us maintaining two
// source-of-truth copies by hand.
//
// Run automatically by:
//   - `npm run build` (root) before building @tianshu/server
//   - `npm run dev`   (root) on each invocation
//
// Re-run manually with `npm run sync:plugins`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const pluginsDir = path.join(repoRoot, "plugins");
const builtinDir = path.join(repoRoot, "packages", "server", "builtinConfig", "plugins");

if (!fs.existsSync(pluginsDir)) {
  // Nothing to do; the repo isn't using top-level plugins/ yet.
  process.exit(0);
}

const ids = fs
  .readdirSync(pluginsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
  .map((d) => d.name);

let copied = 0;
for (const id of ids) {
  const src = path.join(pluginsDir, id, "manifest.json");
  if (!fs.existsSync(src)) continue;
  const dstDir = path.join(builtinDir, id);
  fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(src, path.join(dstDir, "manifest.json"));
  copied++;
}

// eslint-disable-next-line no-console
console.log(`[sync-builtin-plugins] synced ${copied} manifest(s) from plugins/ → builtinConfig/plugins/`);
