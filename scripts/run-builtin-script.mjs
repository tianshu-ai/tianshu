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

// Discover plugins and topologically sort by inter-plugin deps so
// that if plugin A depends on plugin B (via package.json), B builds
// first. Falls back to alphabetical when there's no dependency.
const allIds = fs
  .readdirSync(pluginsRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
  .map((d) => d.name)
  .sort();

const pluginPkgNames = new Map(); // packageName → dirName
for (const id of allIds) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginsRoot, id, "package.json"), "utf8"));
    if (pkg.name) pluginPkgNames.set(pkg.name, id);
  } catch { /* skip */ }
}

// Build a dependency graph: id → Set<depId>
const depGraph = new Map();
for (const id of allIds) {
  const deps = new Set();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginsRoot, id, "package.json"), "utf8"));
    for (const depName of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const depId = pluginPkgNames.get(depName);
      if (depId && depId !== id) deps.add(depId);
    }
  } catch { /* skip */ }
  depGraph.set(id, deps);
}

// Kahn's algorithm for topological sort
const inDegree = new Map();
for (const id of allIds) inDegree.set(id, 0);
for (const [, deps] of depGraph) {
  for (const dep of deps) inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1);
}
// Wait — inDegree counts how many plugins depend on this one.
// Actually for topo sort: if A depends on B, B must come first.
// So edges are A → B (A depends on B), and we want B before A.
// inDegree of A = number of its own deps (B's that must come first).
const inDeg2 = new Map();
for (const id of allIds) inDeg2.set(id, depGraph.get(id)?.size ?? 0);
const queue = allIds.filter((id) => inDeg2.get(id) === 0).sort();
const ids = [];
while (queue.length > 0) {
  const id = queue.shift();
  ids.push(id);
  // Find plugins that depend on `id` and reduce their in-degree
  for (const [other, deps] of depGraph) {
    if (deps.has(id)) {
      inDeg2.set(other, inDeg2.get(other) - 1);
      if (inDeg2.get(other) === 0) {
        // Insert in sorted position for stable ordering
        const idx = queue.findIndex((q) => q > other);
        queue.splice(idx === -1 ? queue.length : idx, 0, other);
      }
    }
  }
}

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
