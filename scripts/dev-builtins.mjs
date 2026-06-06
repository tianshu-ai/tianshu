// Spawn `concurrently` with one stream per plugin in `plugins/` that
// declares a `dev` script, plus the server + web dev streams.
//
// Replaces the hand-maintained list of `-w plugins/files` flags in
// root `npm run dev`. Adding a plugin with `"dev": "tsc --watch"` =
// the dev session picks it up automatically.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const pluginsRoot = path.join(repoRoot, "plugins");

const pluginIds = fs.existsSync(pluginsRoot)
  ? fs
      .readdirSync(pluginsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
      .map((d) => d.name)
      .filter((id) => {
        const pkg = path.join(pluginsRoot, id, "package.json");
        if (!fs.existsSync(pkg)) return false;
        try {
          return Boolean(JSON.parse(fs.readFileSync(pkg, "utf8")).scripts?.dev);
        } catch {
          return false;
        }
      })
      .sort()
  : [];

const cmds = [
  { name: "server", color: "blue", cmd: "npm run dev -w packages/server" },
  { name: "web", color: "green", cmd: "npm run dev -w packages/web" },
];
const pluginColors = ["magenta", "cyan", "yellow", "red", "white"];
for (let i = 0; i < pluginIds.length; i++) {
  const id = pluginIds[i];
  cmds.push({
    name: `plugin-${id}`,
    color: pluginColors[i % pluginColors.length],
    cmd: `npm run dev -w plugins/${id}`,
  });
}

const args = [
  "concurrently",
  "-n",
  cmds.map((c) => c.name).join(","),
  "-c",
  cmds.map((c) => c.color).join(","),
  ...cmds.map((c) => c.cmd),
];

const child = spawn("npx", args, { cwd: repoRoot, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
