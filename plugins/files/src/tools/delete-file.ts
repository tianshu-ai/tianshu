// delete_file — agent tool that removes a file or directory from the
// user workspace.
//
// Path-safe: refuses to resolve outside the user home (path-helper
// enforced) and refuses to delete the workspace root itself.
//
// Directories: a non-empty directory needs `recursive: true`
// (deleting a whole tree is destructive, so it's opt-in). Files and
// empty directories delete without the flag.

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import {
  resolveInUserHome,
  toWorkspaceUri,
  PathOutsideRootError,
} from "./path-helper.js";

export interface DeleteFileToolResult {
  ok: boolean;
  text: string;
}

export function deleteFileSchema(): Tool {
  return {
    name: "delete_file",
    description:
      "Delete a file or directory from the workspace. " +
      'Path is relative to the workspace root, e.g. "notes/old.md". ' +
      "Files and empty directories are removed directly; to delete a " +
      "non-empty directory (and everything under it) pass " +
      "`recursive: true`. This is destructive and cannot be undone.",
    parameters: Type.Object({
      path: Type.String({
        description:
          'Path relative to the workspace root, e.g. "notes/old.md". ' +
          "A leading slash means workspace root, NOT the sandbox OS root.",
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

export function executeDeleteFile(
  userHome: string,
  args: { path: string; recursive?: boolean },
): DeleteFileToolResult {
  let resolved: string;
  try {
    resolved = resolveInUserHome(userHome, args.path);
  } catch (err) {
    if (err instanceof PathOutsideRootError) {
      return { ok: false, text: `path is outside the workspace: ${args.path}` };
    }
    throw err;
  }
  if (resolved === path.resolve(userHome)) {
    return { ok: false, text: `cannot delete the workspace root` };
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, text: `not found: ${args.path}` };
  }
  const uri = toWorkspaceUri(userHome, resolved);
  const stat = fs.statSync(resolved);
  try {
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved);
      if (entries.length > 0 && !args.recursive) {
        return {
          ok: false,
          text: `directory not empty: ${args.path} (pass recursive=true to delete it and everything under it)`,
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
  return { ok: true, text: `deleted ${uri}` };
}
