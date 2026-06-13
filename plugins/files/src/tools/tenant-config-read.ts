// tenant_config_read — read a file inside the tenant config tree.
// Mirrors `read_file` but rooted at `<tenant>/workspace/_tenant/config/`.

import fs from "node:fs";
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import {
  resolveInTenantConfig,
  toTenantConfigUri,
  TenantConfigPathError,
} from "./tenant-config-helper.js";

export const TC_MAX_TEXT_BYTES = 500_000;

export interface TenantConfigReadResult {
  ok: boolean;
  text: string;
  binary?: boolean;
  size?: number;
  bytesReturned?: number;
  nextOffset?: number;
}

export function tenantConfigReadSchema(): Tool {
  return {
    name: "tenant_config_read",
    description:
      `Read a file from the tenant config tree (skills, etc). ` +
      `Returns up to ${TC_MAX_TEXT_BYTES / 1000} KB per call; for ` +
      `larger files page through with offset+limit. Path is rooted ` +
      `at the tenant-config root, so e.g. ` +
      `"main/skills/skill-creator/SKILL.md" or the URI form ` +
      `"tenant-config:///main/skills/skill-creator/SKILL.md" both work.`,
    parameters: Type.Object({
      path: Type.String({
        description:
          'Path under the tenant-config root (or a tenant-config:/// URI).',
      }),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "Byte offset to start reading from. Default 0.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: `Max bytes to return. Capped at ${TC_MAX_TEXT_BYTES}.`,
        }),
      ),
    }),
  };
}

export function executeTenantConfigRead(
  tenantHomeDir: string,
  args: { path: string; offset?: number; limit?: number },
): TenantConfigReadResult {
  let resolved: string;
  try {
    resolved = resolveInTenantConfig(tenantHomeDir, args.path);
  } catch (err) {
    if (err instanceof TenantConfigPathError) {
      return { ok: false, text: err.message };
    }
    throw err;
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, text: `not found: ${args.path}` };
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return { ok: false, text: `is a directory, not a file: ${args.path}` };
  }
  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const limit = Math.max(
    1,
    Math.min(args.limit ?? TC_MAX_TEXT_BYTES, TC_MAX_TEXT_BYTES),
  );
  const fd = fs.openSync(resolved, "r");
  try {
    const buf = Buffer.alloc(limit);
    const bytesRead = fs.readSync(fd, buf, 0, limit, offset);
    const slice = buf.subarray(0, bytesRead);
    const probe = slice.subarray(0, Math.min(slice.length, 4096));
    if (probe.includes(0)) {
      return {
        ok: true,
        text: `(binary file: ${stat.size} bytes; not shown)`,
        binary: true,
        size: stat.size,
      };
    }
    const content = slice.toString("utf8");
    const nextOffset = offset + bytesRead;
    const more = nextOffset < stat.size;
    const uri = toTenantConfigUri(tenantHomeDir, resolved);
    const header =
      stat.size <= TC_MAX_TEXT_BYTES
        ? `// ${uri} (${stat.size} bytes)`
        : `// ${uri} bytes ${offset}–${nextOffset} of ${stat.size}` +
          (more
            ? ` — call tenant_config_read again with offset=${nextOffset} for the next chunk`
            : " (final chunk)");
    return {
      ok: true,
      text: `${header}\n${content}`,
      size: stat.size,
      bytesReturned: bytesRead,
      nextOffset: more ? nextOffset : undefined,
    };
  } finally {
    fs.closeSync(fd);
  }
}
