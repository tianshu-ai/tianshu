// Type-check every plugin under `plugins/` that has a tsconfig.json.
// Mirrors run-builtin-script.mjs but stays inside tsc rather than
// going through npm scripts (faster, less noise).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const pluginsRoot = path.join(repoRoot, "plugins");

if (!fs.existsSync(pluginsRoot)) process.exit(0);

const ids = fs
  .readdirSync(pluginsRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
  .map((d) => d.name)
  .sort();

for (const id of ids) {
  const tsconfig = path.join(pluginsRoot, id, "tsconfig.json");
  if (!fs.existsSync(tsconfig)) continue;
  const result = spawnSync(
    "npx",
    ["tsc", "-p", tsconfig, "--noEmit"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
