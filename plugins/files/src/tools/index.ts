// Agent tools the `files` plugin contributes.
//
// These five tools (list_dir / read_file / write_file / edit_file /
// glob) operate on the **per-user host workspace** \u2014
// <tenant>/workspace/users/<userId>/. They are NOT sandbox-aware:
// when the microsandbox plugin is also enabled, the agent will see
// these alongside microsandbox's `exec` etc. and use whichever fits
// the task (host fs is direct + persistent; sandbox fs lives inside
// /workspace which is bind-mounted from the same dir, so changes
// flow both ways).
//
// Ownership rationale: the `files` plugin already owns the file
// browser UI panel + upload + the HTTP /list /read /raw /upload
// routes. Putting the agent tools here keeps every "files for the
// agent / user" surface in one plugin.

import { readFileSync } from "node:fs";
import type {
  AgentTool,
  AgentToolContext,
  LspCapability,
  LspDiagnoseResult,
} from "@tianshu/plugin-sdk";
import { resolveInUserHome } from "./path-helper.js";
import { listDirSchema, executeListDir } from "./list-dir.js";
import { readFileSchema, executeReadFile } from "./read-file.js";
import { writeFileSchema, executeWriteFile } from "./write-file.js";
import { editFileSchema, executeEditFile } from "./edit-file.js";
import { globSchema, executeGlob } from "./glob.js";
import {
  tenantConfigListSchema,
  executeTenantConfigList,
} from "./tenant-config-list.js";
import {
  tenantConfigReadSchema,
  executeTenantConfigRead,
} from "./tenant-config-read.js";
import {
  tenantConfigWriteSchema,
  executeTenantConfigWrite,
} from "./tenant-config-write.js";
import {
  tenantConfigEditSchema,
  executeTenantConfigEdit,
} from "./tenant-config-edit.js";
import {
  tenantConfigGlobSchema,
  executeTenantConfigGlob,
} from "./tenant-config-glob.js";
import {
  tenantConfigDeleteSchema,
  executeTenantConfigDelete,
} from "./tenant-config-delete.js";
import type { AgentScope } from "./tenant-config-helper.js";

/** Pull the agent's scope from the host-supplied context. Defaults
 *  to main if the host doesn't provide one (older host versions). */
function scopeFromCtx(ctx: AgentToolContext): AgentScope {
  return ctx.agentScope ?? { kind: "main" };
}

export const ListDirTool: AgentTool = {
  schema: listDirSchema(),
  execute: (args, ctx: AgentToolContext) =>
    executeListDir(ctx.userHomeDir, args as { path?: string }),
};

export const ReadFileTool: AgentTool = {
  schema: readFileSchema(),
  execute: (args, ctx: AgentToolContext) =>
    executeReadFile(
      ctx.userHomeDir,
      args as { path: string; offset?: number; limit?: number },
      ctx.sessionId,
    ),
};

export const WriteFileTool: AgentTool = {
  schema: writeFileSchema(),
  execute: async (args, ctx: AgentToolContext) => {
    const result = executeWriteFile(
      ctx.userHomeDir,
      args as { path: string; content: string },
      ctx.sessionId,
    );
    return appendLspDiagnostics(
      result,
      ctx,
      args as { path: string; content: string },
    );
  },
};

export const EditFileTool: AgentTool = {
  schema: editFileSchema(),
  execute: async (args, ctx: AgentToolContext) => {
    const result = executeEditFile(
      ctx.userHomeDir,
      args as {
        path: string;
        edits?: Array<{ old_text: string; new_text: string }>;
        old_text?: string;
        new_text?: string;
      },
      ctx.sessionId,
    );
    return appendLspDiagnostics(
      result,
      ctx,
      args as { path: string },
    );
  },
};

/**
 * After a successful write/edit, ask the host's LSP service for
 * diagnostics on the touched file and append the formatted block
 * to the tool's text. ADR-0005 §"Diagnostic delivery" — sync,
 * 3 s timeout, never throws, degrades silently when LSP is
 * disabled or the language has no LSP. The text appended is
 * what we want the model to see in the same turn that produced
 * the edit, so it can react inline rather than several tool
 * calls later.
 */
async function appendLspDiagnostics<
  T extends { ok: boolean; text: string },
>(
  result: T,
  ctx: AgentToolContext,
  args: { path: string; content?: string },
): Promise<T> {
  // Don't bother on failed writes — there's nothing on disk to
  // diagnose.
  if (!result.ok) return result;
  const cap = ctx.capabilities.get<LspCapability>("host.lsp");
  if (!cap) return result;
  let resolved: string;
  try {
    resolved = resolveInUserHome(ctx.userHomeDir, args.path);
  } catch {
    // Path checks already happened in the underlying tool; if it
    // somehow rejects here just skip diagnostics.
    return result;
  }
  // We need the post-edit contents to push via didChange. For
  // write_file the agent supplied them; for edit_file the
  // executor returned ok without echoing them, so we read from
  // disk — cheap (we just wrote it) and avoids drifting from
  // what the LS will actually see when it loads the file.
  let contents: string;
  if (typeof args.content === "string") {
    contents = args.content;
  } else {
    try {
      contents = fsReadFile(resolved);
    } catch {
      return result;
    }
  }
  let diag: LspDiagnoseResult;
  try {
    diag = await cap.diagnoseAfterEdit({
      filePath: resolved,
      contents,
    });
  } catch {
    // Capability is supposed to never throw, but if it does
    // we'd rather drop diagnostics than break the edit.
    return result;
  }
  if (!diag.text && !diag.unavailable) return result;
  const trailer = diag.text
    ? `\n\n${diag.text}`
    : `\n\n[lsp] diagnostics unavailable: ${diag.unavailable}`;
  return { ...result, text: result.text + trailer };
}

function fsReadFile(absolutePath: string): string {
  // Lazy-import node:fs so this module stays browser-bundle-safe
  // (the SDK consumer only imports tool schemas).
  return readFileSync(absolutePath, "utf8");
}

export const GlobTool: AgentTool = {
  schema: globSchema(),
  execute: (args, ctx: AgentToolContext) =>
    executeGlob(ctx.userHomeDir, args as { pattern: string }),
};

// ─── Tenant-config tools ────────────────────────────────────────
//
// These five mirror the per-user fs tools but operate on the
// tenant-shared config tree at `<tenant>/workspace/_tenant/config/`.
// Reads are unrestricted; writes are scope-gated (main agent vs
// worker:<kind>) by `tenant-config-helper.checkWritable`.

export const TenantConfigListTool: AgentTool = {
  schema: tenantConfigListSchema(),
  execute: (args, ctx: AgentToolContext) =>
    executeTenantConfigList(ctx.tenantHomeDir, args as { path?: string }),
};

export const TenantConfigReadTool: AgentTool = {
  schema: tenantConfigReadSchema(),
  execute: (args, ctx: AgentToolContext) =>
    executeTenantConfigRead(
      ctx.tenantHomeDir,
      args as { path: string; offset?: number; limit?: number },
    ),
};

export const TenantConfigWriteTool: AgentTool = {
  schema: tenantConfigWriteSchema(),
  execute: (args, ctx: AgentToolContext) =>
    executeTenantConfigWrite(
      ctx.tenantHomeDir,
      scopeFromCtx(ctx),
      args as { path: string; content: string },
    ),
};

export const TenantConfigEditTool: AgentTool = {
  schema: tenantConfigEditSchema(),
  execute: (args, ctx: AgentToolContext) =>
    executeTenantConfigEdit(
      ctx.tenantHomeDir,
      scopeFromCtx(ctx),
      args as {
        path: string;
        edits?: Array<{ old_text: string; new_text: string }>;
        old_text?: string;
        new_text?: string;
      },
    ),
};

export const TenantConfigDeleteTool: AgentTool = {
  schema: tenantConfigDeleteSchema(),
  execute: (args, ctx: AgentToolContext) =>
    executeTenantConfigDelete(
      ctx.tenantHomeDir,
      scopeFromCtx(ctx),
      args as { path: string; recursive?: boolean },
    ),
};

export const TenantConfigGlobTool: AgentTool = {
  schema: tenantConfigGlobSchema(),
  execute: (args, ctx: AgentToolContext) =>
    executeTenantConfigGlob(
      ctx.tenantHomeDir,
      args as { pattern: string },
    ),
};


