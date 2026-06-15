// tenant_config_write — create / overwrite a file in the tenant
// config tree. Write boundary is enforced by `checkWritable`:
//
//   main agent     → skills/...,            main/skills/...
//   worker:<kind>  → workers/<kind>/skills/...
//
// Reads are unrestricted (see tenant_config_list / read), but writes
// outside the agent's allowed scope are rejected so a worker can't
// rewrite the main agent's skills and a misbehaved main agent can't
// touch a worker's tree.

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import {
  AgentScope,
  checkWritable,
  resolveInTenantConfig,
  toTenantConfigUri,
  TenantConfigPathError,
} from "./tenant-config-helper.js";

const MAX_WRITE_BYTES = 5_000_000; // 5 MB

export interface TenantConfigWriteResult {
  ok: boolean;
  text: string;
  bytesWritten?: number;
  scope?: string;
}

export function tenantConfigWriteSchema(): Tool {
  return {
    name: "tenant_config_write",
    description:
      "Create or overwrite a file in the tenant config tree. The " +
      "write boundary is scope-aware: main agents may write under " +
      "`skills/` or `main/skills/`; workers may write only under " +
      "`workers/<their-kind>/skills/`. Reads are unrestricted. Use " +
      "this to author or update a SKILL.md (and its sibling files " +
      "like scripts/foo.py, references/bar.md, assets/baz.txt).\n\n" +
      "Guidelines:\n" +
      "- Use `tenant_config_write` ONLY for new files or complete " +
      "rewrites. For targeted changes prefer `tenant_config_edit` " +
      "(its `edits[]` accepts multiple disjoint replacements in " +
      "one call).\n" +
      "- For long content, write a skeleton first and fill the " +
      "placeholders with `tenant_config_edit`. One `write` call " +
      "carrying thousands of lines of `content` will trip the " +
      "provider's tool-call stream truncation and the call will " +
      "fail with `content` missing entirely.",
    parameters: Type.Object({
      path: Type.String({
        description:
          'Path under the tenant-config root, e.g. "main/skills/foo/SKILL.md".',
      }),
      content: Type.String({
        description: "Full UTF-8 file contents to write.",
      }),
    }),
  };
}

export function executeTenantConfigWrite(
  tenantHomeDir: string,
  scope: AgentScope,
  args: { path: string; content: string },
): TenantConfigWriteResult {
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
    return {
      ok: false,
      text: `not writable: ${writable.reason}`,
    };
  }
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return { ok: false, text: `is a directory: ${args.path}` };
  }
  const buf = Buffer.from(args.content, "utf8");
  if (buf.length > MAX_WRITE_BYTES) {
    return {
      ok: false,
      text: `content too large: ${buf.length} bytes > ${MAX_WRITE_BYTES} cap`,
    };
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tmp = `${resolved}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, resolved);
  return {
    ok: true,
    text: `wrote ${buf.length} bytes to ${toTenantConfigUri(tenantHomeDir, resolved)} [scope=${writable.scopeLabel}]`,
    bytesWritten: buf.length,
    scope: writable.scopeLabel,
  };
}
