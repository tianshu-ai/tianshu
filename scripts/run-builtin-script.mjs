// Run an npm script (build / test / dev) across every plugin
// directory under `plugins/` that has a package.json + that script
// declared.
//
// This replaces the hand-maintained list of `-w plugins/files -w
// plugins/microsandbox …` in root scripts. ADR-0004 N+1.5 made the
// runtime side dynamic; this script does the same for the build side
// so adding a new plugin = drop a directory + ensure it has a
// `build` and `test` script. No edit to root package.json.
//
// Usage: node scripts/run-builtin-script.mjs <script-name> [extra-args...]
// Exits with the first non-zero exit code from a child.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const pluginsRoot = path.join(repoRoot, "plugins");
const scriptName = process.argv[2];
const extra = process.argv.slice(3);

if (!scriptName) {
  console.error("usage: run-builtin-script.mjs <script-name> [args...]");
  process.exit(2);
}

if (!fs.existsSync(pluginsRoot)) {
  // Nothing to do.
  process.exit(0);
}

const ids = fs
  .readdirSync(pluginsRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
  .map((d) => d.name)
  .sort();

let ran = 0;
for (const id of ids) {
  const pkgPath = path.join(pluginsRoot, id, "package.json");
  if (!fs.existsSync(pkgPath)) continue;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch (err) {
    console.error(`[run-builtin-script] ${id}: bad package.json — ${err.message}`);
    continue;
  }
  if (!pkg.scripts || typeof pkg.scripts[scriptName] !== "string") {
    // Plugin doesn't declare this script — silently skip. Lets a
    // plugin opt out of e.g. test if it has nothing to test.
    continue;
  }
  const args = ["run", scriptName, "-w", `plugins/${id}`, ...extra];
  console.log(`[run-builtin-script] npm ${args.join(" ")}`);
  const result = spawnSync("npm", args, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  ran++;
}

console.log(`[run-builtin-script] ran "${scriptName}" in ${ran} plugin(s)`);
