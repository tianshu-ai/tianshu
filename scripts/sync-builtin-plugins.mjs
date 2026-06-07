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
let skillsCopied = 0;
let templatesCopied = 0;
for (const id of ids) {
  const src = path.join(pluginsDir, id, "manifest.json");
  if (!fs.existsSync(src)) continue;
  const dstDir = path.join(builtinDir, id);
  fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(src, path.join(dstDir, "manifest.json"));
  copied++;

  // Skills (markdown files) live next to the manifest at runtime
  // so registry.skillsForTenant() can resolve `contributes.skills[].path`
  // against the manifest dir. Mirror the whole skills/ tree to
  // builtinConfig.
  const skillsSrc = path.join(pluginsDir, id, "skills");
  if (fs.existsSync(skillsSrc) && fs.statSync(skillsSrc).isDirectory()) {
    const skillsDst = path.join(dstDir, "skills");
    fs.mkdirSync(skillsDst, { recursive: true });
    for (const entry of fs.readdirSync(skillsSrc, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      fs.copyFileSync(
        path.join(skillsSrc, entry.name),
        path.join(skillsDst, entry.name),
      );
      skillsCopied++;
    }
  }

  // Templates (yaml files) — same shape as skills. Plugins that
  // ship Sandboxfile templates (like microsandbox) read them at
  // activate-time, and the resolution path is
  // `<manifest-dir>/templates/<file>`. We don't enforce a schema
  // here; missing files surface as activation errors in the
  // plugin, which is what we want.
  const templatesSrc = path.join(pluginsDir, id, "templates");
  if (fs.existsSync(templatesSrc) && fs.statSync(templatesSrc).isDirectory()) {
    const templatesDst = path.join(dstDir, "templates");
    fs.mkdirSync(templatesDst, { recursive: true });
    for (const entry of fs.readdirSync(templatesSrc, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      // Allow yaml + readme; skip dotfiles.
      if (entry.name.startsWith(".")) continue;
      const lower = entry.name.toLowerCase();
      if (
        !lower.endsWith(".yaml") &&
        !lower.endsWith(".yml") &&
        !lower.endsWith(".md")
      )
        continue;
      fs.copyFileSync(
        path.join(templatesSrc, entry.name),
        path.join(templatesDst, entry.name),
      );
      templatesCopied++;
    }
  }
}

// eslint-disable-next-line no-console
console.log(
  `[sync-builtin-plugins] synced ${copied} manifest(s), ${skillsCopied} skill file(s), and ${templatesCopied} template file(s) from plugins/ → builtinConfig/plugins/`,
);
