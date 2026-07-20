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
let localesCopied = 0;
let agentSeedFiles = 0;
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

  // Locales — flat `{key: text}` JSON per supported language
  // (`en.json`, `zh.json`, ...). Ships alongside the manifest so
  // the server can serve them to the web client, which merges
  // them under the namespace `plugin.<id>.*` at boot. Only
  // `<lang>.json` names are copied so unrelated files (drafts,
  // .DS_Store, etc.) don't leak into builtinConfig.
  const localesSrc = path.join(pluginsDir, id, "locales");
  if (fs.existsSync(localesSrc) && fs.statSync(localesSrc).isDirectory()) {
    const localesDst = path.join(dstDir, "locales");
    fs.mkdirSync(localesDst, { recursive: true });
    for (const entry of fs.readdirSync(localesSrc, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      if (entry.name.startsWith(".")) continue;
      fs.copyFileSync(
        path.join(localesSrc, entry.name),
        path.join(localesDst, entry.name),
      );
      localesCopied++;
    }
  }

  // Agent seeds — each entry in `contributes.agentSeeds` is a
  // directory bundle copied verbatim into the tenant on first
  // plugin activation (see core/agent-seeds.ts). Mirror the
  // whole subtree so `<manifest-dir>/<seed.path>/...` resolves
  // identically in dev and packaged installs.
  const agentSeedsSrc = path.join(pluginsDir, id, "agent-seeds");
  if (
    fs.existsSync(agentSeedsSrc) &&
    fs.statSync(agentSeedsSrc).isDirectory()
  ) {
    const agentSeedsDst = path.join(dstDir, "agent-seeds");
    fs.rmSync(agentSeedsDst, { recursive: true, force: true });
    fs.cpSync(agentSeedsSrc, agentSeedsDst, { recursive: true });
    // Count files for the summary line; cpSync doesn't return one.
    const stack = [agentSeedsDst];
    while (stack.length) {
      const dir = stack.pop();
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) agentSeedFiles++;
      }
    }
  }
}

// eslint-disable-next-line no-console
console.log(
  `[sync-builtin-plugins] synced ${copied} manifest(s), ${skillsCopied} skill file(s), ${templatesCopied} template file(s), ${localesCopied} locale file(s), and ${agentSeedFiles} agent-seed file(s) from plugins/ → builtinConfig/plugins/`,
);
