// tenant_config_delete — remove a file or empty directory inside
// the tenant config tree. The same write-boundary check applies, so
// a worker can only delete things under its own kind layer.

import fs from "node:fs";
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import {
  AgentScope,
  checkWritable,
  resolveInTenantConfig,
  toTenantConfigUri,
  TenantConfigPathError,
} from "./tenant-config-helper.js";

export interface TenantConfigDeleteResult {
  ok: boolean;
  text: string;
}

export function tenantConfigDeleteSchema(): Tool {
  return {
    name: "tenant_config_delete",
    description:
      "Remove a file or directory inside the tenant config tree. " +
      "Same scope boundary as tenant_config_write. Set " +
      "`recursive: true` to delete a non-empty directory (e.g. an " +
      "entire skill bundle); without it, only files and empty " +
      "directories are removed.",
    parameters: Type.Object({
      path: Type.String({
        description: "Path under the tenant-config root.",
      }),
      recursive: Type.Optional(
        Type.Boolean({
          description:
            "Allow deleting a non-empty directory recursively. Default false.",
        }),
      ),
    }),
  };
}

export function executeTenantConfigDelete(
  tenantHomeDir: string,
  scope: AgentScope,
  args: { path: string; recursive?: boolean },
): TenantConfigDeleteResult {
  let resolved: string;
  try {
    resolved = resolveInTenantConfig(tenantHomeDir, args.path);
  } catch (err) {
    if (err instanceof TenantConfigPathError) {
      return { ok: false, text: err.message };
    }
    throw err;
  }
  const writable = checkWritable(tenantHomeDir, resolved, scope);
  if (!writable.ok) {
    return { ok: false, text: `not writable: ${writable.reason}` };
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, text: `not found: ${args.path}` };
  }
  const stat = fs.statSync(resolved);
  try {
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved);
      if (entries.length > 0 && !args.recursive) {
        return {
          ok: false,
          text: `directory not empty: ${args.path} (pass recursive=true to delete the whole bundle)`,
        };
      }
      fs.rmSync(resolved, { force: true, recursive: true });
    } else {
      fs.rmSync(resolved, { force: true });
    }
  } catch (err) {
    return {
      ok: false,
      text: `delete failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    ok: true,
    text: `deleted ${toTenantConfigUri(tenantHomeDir, resolved)}`,
  };
}
