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

import type { AgentTool, AgentToolContext } from "@tianshu/plugin-sdk";
import { listDirSchema, executeListDir } from "./list-dir.js";
import { readFileSchema, executeReadFile } from "./read-file.js";
import { writeFileSchema, executeWriteFile } from "./write-file.js";
import { editFileSchema, executeEditFile } from "./edit-file.js";
import { globSchema, executeGlob } from "./glob.js";

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
    ),
};

export const WriteFileTool: AgentTool = {
  schema: writeFileSchema(),
  execute: (args, ctx: AgentToolContext) =>
    executeWriteFile(ctx.userHomeDir, args as { path: string; content: string }),
};

export const EditFileTool: AgentTool = {
  schema: editFileSchema(),
  execute: (args, ctx: AgentToolContext) =>
    executeEditFile(
      ctx.userHomeDir,
      args as { path: string; old_text: string; new_text: string },
    ),
};

export const GlobTool: AgentTool = {
  schema: globSchema(),
  execute: (args, ctx: AgentToolContext) =>
    executeGlob(ctx.userHomeDir, args as { pattern: string }),
};
