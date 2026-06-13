// tenant_config_glob — find files inside the tenant config tree
// using a shell-style glob. Mirrors `glob` but rooted at the tenant
// config root (`<tenant>/workspace/_tenant/config/`).

import fs from "node:fs";
import fg from "fast-glob";
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import {
  getTenantConfigRoot,
  toTenantConfigUri,
} from "./tenant-config-helper.js";

const MAX_RESULTS = 1000;

export interface TenantConfigGlobResult {
  ok: boolean;
  text: string;
  matches?: string[];
  truncated?: boolean;
}

export function tenantConfigGlobSchema(): Tool {
  return {
    name: "tenant_config_glob",
    description:
      `Find files inside the tenant config tree matching a glob ` +
      `pattern. Supports \`*\`, \`**\`, \`?\`, \`{a,b}\`. Returns up ` +
      `to ${MAX_RESULTS} matching paths, sorted alphabetically. ` +
      `Useful to enumerate every SKILL.md (\`**/SKILL.md\`).`,
    parameters: Type.Object({
      pattern: Type.String({
        description:
          'Glob pattern relative to the config root, e.g. "**/SKILL.md".',
      }),
    }),
  };
}

export async function executeTenantConfigGlob(
  tenantHomeDir: string,
  args: { pattern: string },
): Promise<TenantConfigGlobResult> {
  if (!args.pattern || typeof args.pattern !== "string") {
    return { ok: false, text: "pattern is required" };
  }
  let pat = args.pattern.replace(/\\/g, "/");
  if (pat.startsWith("tenant-config:///")) {
    pat = pat.slice("tenant-config:///".length);
  } else if (pat.startsWith("tenant-config://")) {
    pat = pat.slice("tenant-config://".length);
  }
  if (pat.startsWith("/")) pat = pat.slice(1);
  if (pat.includes("..")) {
    return { ok: false, text: `pattern cannot contain ".."` };
  }
  if (pat.length === 0) {
    return { ok: false, text: "pattern is empty" };
  }

  const root = getTenantConfigRoot(tenantHomeDir);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });

  const found = await fg(pat, {
    cwd: root,
    onlyFiles: true,
    dot: true,
    suppressErrors: true,
    followSymbolicLinks: false,
  });
  found.sort();
  const truncated = found.length > MAX_RESULTS;
  const slice = truncated ? found.slice(0, MAX_RESULTS) : found;
  const matches = slice.map((rel) =>
    toTenantConfigUri(tenantHomeDir, `${root}/${rel}`),
  );
  const header = `${matches.length} match${matches.length === 1 ? "" : "es"}${truncated ? ` (truncated at ${MAX_RESULTS})` : ""}:`;
  return {
    ok: true,
    text: [header, ...matches].join("\n"),
    matches,
    truncated,
  };
}
