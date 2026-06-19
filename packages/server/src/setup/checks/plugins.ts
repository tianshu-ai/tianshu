// Builtin-plugin manifest sanity check.
//
// Hooks into the same `builtinConfig/plugins/*` directory the
// server's plugin registry consumes. We're not booting the registry
// here (would couple doctor to half the server); we just read the
// manifests and verify each declares a unique id with no obvious
// surface failures (missing entry, malformed JSON).

import fs from "node:fs";
import path from "node:path";
import { CheckGroup } from "../render.js";
import { getBuiltinConfigDir } from "../../core/plugins/discovery.js";

export interface PluginsCheckOpts {
  /** Override builtinConfig dir (test seam / monorepo dev override). */
  builtinConfigDir?: string;
}

export function checkPlugins(opts: PluginsCheckOpts = {}): CheckGroup {
  const lines: CheckGroup["lines"] = [];
  let dir: string;
  try {
    dir = opts.builtinConfigDir ?? getBuiltinConfigDir();
  } catch (err) {
    lines.push({
      severity: "warning",
      text: "builtinConfig dir not found",
      detail: err instanceof Error ? err.message : String(err),
    });
    return { title: "Builtin plugins", lines };
  }

  const pluginsRoot = path.join(dir, "plugins");
  if (!fs.existsSync(pluginsRoot)) {
    lines.push({
      severity: "warning",
      text: "no builtin plugins shipped",
      detail: `${pluginsRoot} doesn't exist; \`npm run sync:plugins\` may not have run yet.`,
    });
    return { title: "Builtin plugins", lines };
  }

  let count = 0;
  for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(pluginsRoot, entry.name, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      lines.push({
        severity: "warning",
        text: `${entry.name}: manifest.json missing`,
        detail: manifestPath,
      });
      continue;
    }
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        id?: string;
        name?: string;
      };
      if (!m.id) {
        lines.push({
          severity: "warning",
          text: `${entry.name}: manifest missing \`id\``,
          detail: manifestPath,
        });
        continue;
      }
      lines.push({
        severity: "ok",
        text: `${m.id}`,
        detail: m.name && m.name !== m.id ? m.name : undefined,
      });
      count += 1;
    } catch (err) {
      lines.push({
        severity: "warning",
        text: `${entry.name}: manifest unreadable`,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (count === 0) {
    lines.push({
      severity: "warning",
      text: "no valid plugin manifests found",
      detail: pluginsRoot,
    });
  }

  return { title: "Builtin plugins", lines };
}
