// tenant_config_edit — batch exact text replacement inside a
// tenant config file. Same shape as `edit_file` (same uniqueness
// contract, same atomic write semantics, same single-edit
// shorthand) but resolves paths under `_tenant/config/...` and
// honours the per-scope write boundary.

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

interface SingleEdit {
  old_text: string;
  new_text: string;
}

export interface TenantConfigEditResult {
  ok: boolean;
  text: string;
  edits?: Array<{ ok: true; oldLen: number; newLen: number }>;
  failedEditIndex?: number;
}

export function tenantConfigEditSchema(): Tool {
  return {
    name: "tenant_config_edit",
    description:
      "Apply one or more exact-text replacements inside an existing " +
      "file in the tenant config tree. Pass `edits: [{old_text, " +
      "new_text}, ...]` for a batch (atomic — all-or-nothing). Each " +
      "`old_text` must appear EXACTLY ONCE at the moment its edit " +
      "runs. Same scope boundary as `tenant_config_write`.\n\n" +
      "Single-edit shorthand `{path, old_text, new_text}` still works.",
    parameters: Type.Object({
      path: Type.String({
        description: "Path under the tenant-config root.",
      }),
      edits: Type.Optional(
        Type.Array(
          Type.Object({
            old_text: Type.String({
              description:
                "Exact text to find. Must appear exactly once at edit time.",
            }),
            new_text: Type.String({
              description: "Replacement text.",
            }),
          }),
          {
            description:
              "List of edits to apply in order; atomic (all or nothing). " +
              "Skip if you're using the legacy single-edit shorthand.",
          },
        ),
      ),
      old_text: Type.Optional(Type.String()),
      new_text: Type.Optional(Type.String()),
    }),
  };
}

export function executeTenantConfigEdit(
  tenantHomeDir: string,
  scope: AgentScope,
  args: {
    path: string;
    edits?: SingleEdit[];
    old_text?: string;
    new_text?: string;
  },
): TenantConfigEditResult {
  const edits: SingleEdit[] | null = args.edits
    ? args.edits
    : args.old_text !== undefined && args.new_text !== undefined
      ? [{ old_text: args.old_text, new_text: args.new_text }]
      : null;
  if (!edits) {
    return {
      ok: false,
      text: "tenant_config_edit: pass either `edits` array or both `old_text` + `new_text`",
    };
  }
  if (edits.length === 0) {
    return { ok: false, text: "tenant_config_edit: edits array is empty" };
  }

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

  const original = fs.readFileSync(resolved, "utf8");
  const applied: Array<{ ok: true; oldLen: number; newLen: number }> = [];
  let working = original;

  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]!;
    if (e.old_text.length === 0) {
      return {
        ok: false,
        text: `tenant_config_edit: edit #${i + 1} has empty old_text`,
        failedEditIndex: i + 1,
      };
    }
    if (e.old_text === e.new_text) {
      return {
        ok: false,
        text: `tenant_config_edit: edit #${i + 1} old_text and new_text are identical`,
        failedEditIndex: i + 1,
      };
    }
    const occ = countOccurrences(working, e.old_text);
    if (occ === 0) {
      return {
        ok: false,
        text: `tenant_config_edit: edit #${i + 1} old_text not found in ${args.path} (after ${i} prior edit${i === 1 ? "" : "s"})`,
        failedEditIndex: i + 1,
      };
    }
    if (occ > 1) {
      return {
        ok: false,
        text: `tenant_config_edit: edit #${i + 1} old_text appears ${occ} times in ${args.path} (after ${i} prior edit${i === 1 ? "" : "s"}); pull a wider unique window`,
        failedEditIndex: i + 1,
      };
    }
    working = working.replace(e.old_text, e.new_text);
    applied.push({
      ok: true,
      oldLen: e.old_text.length,
      newLen: e.new_text.length,
    });
  }

  const tmp = `${resolved}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, working);
  fs.renameSync(tmp, resolved);

  const totalDelta = applied.reduce(
    (acc, a) => acc + (a.newLen - a.oldLen),
    0,
  );
  const summary =
    applied.length === 1
      ? `edited ${toTenantConfigUri(tenantHomeDir, resolved)} (${applied[0]!.oldLen} → ${applied[0]!.newLen} chars)`
      : `edited ${toTenantConfigUri(tenantHomeDir, resolved)} (${applied.length} edits, net ${totalDelta >= 0 ? "+" : ""}${totalDelta} chars)`;
  return { ok: true, text: summary, edits: applied };
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
