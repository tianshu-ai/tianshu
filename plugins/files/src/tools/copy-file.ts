// copy_file — agent tool that copies a file or directory within the
// user workspace.
//
// Path-safe: refuses to resolve outside the user home (path-helper
// enforced). Creates parent directories for the destination
// automatically.

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import {
  resolveInUserHome,
  toWorkspaceUri,
  PathOutsideRootError,
} from "./path-helper.js";

export interface CopyFileToolResult {
  ok: boolean;
  text: string;
}

export function copyFileSchema(): Tool {
  return {
    name: "copy_file",
    description:
      "Copy a file or directory within the workspace. " +
      "Paths are relative to the workspace root. " +
      "Parent directories for the destination are created automatically. " +
      "For directories, the copy is recursive.",
    parameters: Type.Object({
      source: Type.String({
        description:
          'Source path relative to workspace root, e.g. "notes/draft.md".',
      }),
      destination: Type.String({
        description:
          'Destination path relative to workspace root, e.g. "notes/draft-backup.md".',
      }),
      overwrite: Type.Optional(
        Type.Boolean({
          description:
            "Allow overwriting an existing file at the destination. Default false.",
        }),
      ),
    }),
  };
}

export function executeCopyFile(
  userHome: string,
  args: { source: string; destination: string; overwrite?: boolean },
): CopyFileToolResult {
  let srcResolved: string;
  let dstResolved: string;
  try {
    srcResolved = resolveInUserHome(userHome, args.source);
  } catch (err) {
    if (err instanceof PathOutsideRootError) {
      return { ok: false, text: `source path is outside the workspace: ${args.source}` };
    }
    throw err;
  }
  try {
    dstResolved = resolveInUserHome(userHome, args.destination);
  } catch (err) {
    if (err instanceof PathOutsideRootError) {
      return { ok: false, text: `destination path is outside the workspace: ${args.destination}` };
    }
    throw err;
  }
  if (!fs.existsSync(srcResolved)) {
    return { ok: false, text: `source not found: ${args.source}` };
  }
  if (fs.existsSync(dstResolved) && !args.overwrite) {
    return {
      ok: false,
      text: `destination already exists: ${args.destination} (pass overwrite=true to replace)`,
    };
  }

  const srcUri = toWorkspaceUri(userHome, srcResolved);
  const dstUri = toWorkspaceUri(userHome, dstResolved);

  try {
    // Ensure parent directories exist
    fs.mkdirSync(path.dirname(dstResolved), { recursive: true });

    const stat = fs.statSync(srcResolved);
    if (stat.isDirectory()) {
      fs.cpSync(srcResolved, dstResolved, { recursive: true, force: !!args.overwrite });
    } else {
      fs.copyFileSync(srcResolved, dstResolved);
    }
  } catch (err) {
    return {
      ok: false,
      text: `copy failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, text: `copied ${srcUri} → ${dstUri}` };
}
