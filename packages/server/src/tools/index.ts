// Agent fs tools.
//
// Five tools, all rooted at the per-user home (`<tenant>/workspace/users/<userId>/`):
//   - list_dir
//   - read_file
//   - write_file
//   - edit_file
//   - glob
//
// `exec` and command-execution tools are intentionally absent in v0;
// they require sandbox host capability (ADR-0002 §8) which lands later.
//
// The chat handler (PR #21b) imports `buildToolset(userHome)` to get
// both the pi-ai schema list and the executor map. Each request gets
// its own toolset because the user home is per-request.

import type { Tool } from "@earendil-works/pi-ai";
import { listDirSchema, executeListDir, type ListDirToolResult } from "./list-dir.js";
import { readFileSchema, executeReadFile, type ReadFileToolResult } from "./read-file.js";
import { writeFileSchema, executeWriteFile, type WriteFileToolResult } from "./write-file.js";
import { editFileSchema, executeEditFile, type EditFileToolResult } from "./edit-file.js";
import { globSchema, executeGlob, type GlobToolResult } from "./glob.js";

export type ToolResult =
  | ListDirToolResult
  | ReadFileToolResult
  | WriteFileToolResult
  | EditFileToolResult
  | GlobToolResult;

export type ToolExecutor = (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

export interface Toolset {
  /** pi-ai Tool schemas to pass to streamSimple/agent loop. */
  schemas: Tool[];
  /** Map of tool name → executor. */
  executors: Record<string, ToolExecutor>;
}

export function buildToolset(userHome: string): Toolset {
  return {
    schemas: [
      listDirSchema(),
      readFileSchema(),
      writeFileSchema(),
      editFileSchema(),
      globSchema(),
    ],
    executors: {
      list_dir: (args) =>
        executeListDir(userHome, args as { path?: string }),
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
    },
  };
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
