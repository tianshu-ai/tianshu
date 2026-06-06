// Agent tools.
//
// Two layers:
//   - **Core fs tools** (always on): list_dir, read_file, write_file,
//     edit_file, glob — rooted at the per-user home
//     `<tenant>/workspace/users/<userId>/`.
//   - **Plugin-contributed tools**: every active plugin's
//     `exports.tools[<module-key>]` is collected each turn via
//     `pluginRegistry.toolsForTenant(...)` and gated through each
//     tool's `available()` hook (ADR-0004 §10).
//
// The chat handler imports `buildToolset({...})` once per request
// so config flips (plugin enable/disable, capability changes) take
// effect on the next agent turn without a session restart.

import type { Tool } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolContext, PluginLogger } from "@tianshu/plugin-sdk";
import type { HostCapabilityHandle } from "../core/plugins/registry.js";
import { listDirSchema, executeListDir, type ListDirToolResult } from "./list-dir.js";
import { readFileSchema, executeReadFile, type ReadFileToolResult } from "./read-file.js";
import { writeFileSchema, executeWriteFile, type WriteFileToolResult } from "./write-file.js";
import { editFileSchema, executeEditFile, type EditFileToolResult } from "./edit-file.js";
import { globSchema, executeGlob, type GlobToolResult } from "./glob.js";

export type CoreToolResult =
  | ListDirToolResult
  | ReadFileToolResult
  | WriteFileToolResult
  | EditFileToolResult
  | GlobToolResult;

/** A plugin-contributed tool result is anything the tool returns —
 *  the chat handler normalises it via `runOneTool` for the log. */
export type ToolResult = CoreToolResult | unknown;

export type ToolExecutor = (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

export interface Toolset {
  /** pi-ai Tool schemas to pass to streamSimple/agent loop. */
  schemas: Tool[];
  /** Map of tool name → executor. */
  executors: Record<string, ToolExecutor>;
}

export interface BuildToolsetOpts {
  userHome: string;
  /** Plugin tools collected from `pluginRegistry.toolsForTenant`. */
  pluginTools?: Array<{ pluginId: string; tool: AgentTool }>;
  /** Context passed to each plugin tool's `available()` and
   *  `execute()`. Required iff `pluginTools` is non-empty. */
  toolContext?: BuildToolContext;
}

/** Subset of `AgentToolContext` the host always knows. The handler
 *  fills in `pluginId` per tool when it invokes one. */
export interface BuildToolContext {
  tenantId: string;
  userId: string;
  capabilities: HostCapabilityHandle;
  userHomeDir: string;
  tenantHomeDir: string;
  log: PluginLogger;
}

/**
 * Build a per-request toolset. Plugin tools are registered iff
 * their `available()` hook (default: true) returns truthy.
 */
export async function buildToolset(opts: BuildToolsetOpts): Promise<Toolset> {
  const { userHome, pluginTools, toolContext } = opts;

  const schemas: Tool[] = [
    listDirSchema(),
    readFileSchema(),
    writeFileSchema(),
    editFileSchema(),
    globSchema(),
  ];
  const executors: Record<string, ToolExecutor> = {
    list_dir: (args) => executeListDir(userHome, args as { path?: string }),
    read_file: (args) =>
      executeReadFile(userHome, args as { path: string; offset?: number; limit?: number }),
    write_file: (args) =>
      executeWriteFile(userHome, args as { path: string; content: string }),
    edit_file: (args) =>
      executeEditFile(
        userHome,
        args as { path: string; old_text: string; new_text: string },
      ),
    glob: (args) => executeGlob(userHome, args as { pattern: string }),
  };

  if (pluginTools && pluginTools.length > 0) {
    if (!toolContext) {
      throw new Error("buildToolset: toolContext required when pluginTools are provided");
    }
    for (const { pluginId, tool } of pluginTools) {
      const ctx: AgentToolContext = {
        pluginId,
        tenantId: toolContext.tenantId,
        userId: toolContext.userId,
        capabilities: toolContext.capabilities,
        userHomeDir: toolContext.userHomeDir,
        tenantHomeDir: toolContext.tenantHomeDir,
        log: toolContext.log,
      };
      let available = true;
      if (tool.available) {
        try {
          available = (await tool.available(ctx)) === true;
        } catch (err) {
          toolContext.log.warn(
            `[plugin:${pluginId}] tool "${tool.schema.name}" available() threw — hiding tool: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          available = false;
        }
      }
      if (!available) continue;

      const name = tool.schema.name;
      if (executors[name]) {
        toolContext.log.warn(
          `[plugin:${pluginId}] tool "${name}" collides with an existing tool name; skipping`,
        );
        continue;
      }
      schemas.push(tool.schema);
      executors[name] = (args) => tool.execute(args, ctx);
    }
  }

  return { schemas, executors };
}

export {
  listDirSchema,
  executeListDir,
  readFileSchema,
  executeReadFile,
  writeFileSchema,
  executeWriteFile,
  editFileSchema,
  executeEditFile,
  globSchema,
  executeGlob,
};
export type {
  ListDirToolResult,
  ReadFileToolResult,
  WriteFileToolResult,
  EditFileToolResult,
  GlobToolResult,
};
