// tenant_config_edit — exact text replacement inside a tenant
// config file. Same uniqueness contract as `edit_file`: old_text
// must appear exactly once. Same write boundary as
// tenant_config_write.

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

export interface TenantConfigEditResult {
  ok: boolean;
  text: string;
  occurrences?: number;
}

export function tenantConfigEditSchema(): Tool {
  return {
    name: "tenant_config_edit",
    description:
      "Replace one exact substring with another inside an existing " +
      "file in the tenant config tree. `old_text` must appear " +
      "EXACTLY ONCE — pull a wider unique window if it doesn't. " +
      "Same scope boundary as tenant_config_write.",
    parameters: Type.Object({
      path: Type.String({
        description: "Path under the tenant-config root.",
      }),
      old_text: Type.String({
        description:
          "Exact text to find and replace. Must appear exactly once.",
      }),
      new_text: Type.String({
        description: "Replacement text.",
      }),
    }),
  };
}

export function executeTenantConfigEdit(
  tenantHomeDir: string,
  scope: AgentScope,
  args: { path: string; old_text: string; new_text: string },
): TenantConfigEditResult {
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
  if (fs.statSync(resolved).isDirectory()) {
    return { ok: false, text: `is a directory: ${args.path}` };
  }
  if (args.old_text.length === 0) {
    return { ok: false, text: "old_text must be non-empty" };
  }
  if (args.old_text === args.new_text) {
    return { ok: false, text: "old_text and new_text are identical" };
  }
  const original = fs.readFileSync(resolved, "utf8");
  const occurrences = countOccurrences(original, args.old_text);
  if (occurrences === 0) {
    return { ok: false, text: `old_text not found in ${args.path}` };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      text: `old_text appears ${occurrences} times in ${args.path}; pull a wider unique window`,
      occurrences,
    };
  }
  const updated = original.replace(args.old_text, args.new_text);
  const tmp = `${resolved}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, updated);
  fs.renameSync(tmp, resolved);
  return {
    ok: true,
    text: `edited ${toTenantConfigUri(tenantHomeDir, resolved)} (${args.old_text.length} → ${args.new_text.length} chars)`,
    occurrences: 1,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}
