// tenant_config_list — agent tool that lists entries inside the
// tenant-shared config tree. The path is rooted at
// `<tenant>/workspace/_tenant/config/` so an empty argument lists
// the top-level layers (skills/, main/, workers/, ...).

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import {
  resolveInTenantConfig,
  toTenantConfigUri,
  TenantConfigPathError,
  getTenantConfigRoot,
} from "./tenant-config-helper.js";

const MAX_ENTRIES = 5000;

interface ListEntry {
  name: string;
  path: string;
  type: "directory" | "file" | "other";
  size: number;
  modifiedMs: number;
}

export interface TenantConfigListResult {
  ok: boolean;
  text: string;
  entries?: ListEntry[];
  truncated?: boolean;
}

export function tenantConfigListSchema(): Tool {
  return {
    name: "tenant_config_list",
    description:
      "List entries in the tenant-shared config tree (the root of " +
      "every tenant_config:// path). Use this to discover skills " +
      "under `skills/`, `main/skills/`, or `workers/<kind>/skills/` — " +
      'the path is relative to the config root ("/" = root).',
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description:
            'Path under the config root (e.g. "/", "/main/skills", "tenant-config:///main/skills"). Default "/".',
        }),
      ),
    }),
  };
}

export function executeTenantConfigList(
  tenantHomeDir: string,
  args: { path?: string },
): TenantConfigListResult {
  const requested = args.path ?? "/";
  let resolved: string;
  try {
    resolved = resolveInTenantConfig(tenantHomeDir, requested);
  } catch (err) {
    if (err instanceof TenantConfigPathError) {
      return { ok: false, text: err.message };
    }
    throw err;
  }
  // Auto-create the root on first read so an empty `_tenant/`
  // doesn't 404.
  const root = getTenantConfigRoot(tenantHomeDir);
  if (resolved === root && !fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, text: `not found: ${requested}` };
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return { ok: false, text: `not a directory: ${requested}` };
  }

  const dirents = fs.readdirSync(resolved, { withFileTypes: true });
  const truncated = dirents.length > MAX_ENTRIES;
  const slice = dirents.slice(0, MAX_ENTRIES);
  const entries: ListEntry[] = slice.map((d) => {
    const full = path.join(resolved, d.name);
    let size = 0;
    let modifiedMs = 0;
    try {
      const s = fs.statSync(full);
      size = s.size;
      modifiedMs = s.mtimeMs;
    } catch {
      /* swallow — broken symlinks etc. */
    }
    const type: ListEntry["type"] = d.isDirectory()
      ? "directory"
      : d.isFile()
        ? "file"
        : "other";
    return {
      name: d.name,
      path: toTenantConfigUri(tenantHomeDir, full),
      type,
      size,
      modifiedMs,
    };
  });
  entries.sort((a, b) => {
    if (a.type !== b.type) {
      if (a.type === "directory") return -1;
      if (b.type === "directory") return 1;
    }
    return a.name.localeCompare(b.name);
  });

  const lines = entries.map((e) =>
    e.type === "directory" ? `${e.path}/` : `${e.path}  (${e.size} bytes)`,
  );
  const header = `Tenant config ${toTenantConfigUri(tenantHomeDir, resolved)} (${entries.length} ${entries.length === 1 ? "entry" : "entries"}${truncated ? ", truncated" : ""}):`;
  return {
    ok: true,
    text: [header, ...lines].join("\n"),
    entries,
    truncated,
  };
}
