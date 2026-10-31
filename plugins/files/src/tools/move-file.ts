// move_file — agent tool that moves/renames a file or directory
// within the user workspace.
//
// Path-safe: refuses to resolve outside the user home (path-helper
// enforced). Creates parent directories for the destination
// automatically. Refuses to move the workspace root itself.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import {
  resolveInUserHome,
  toWorkspaceUri,
  PathOutsideRootError,
} from "./path-helper.js";

/** Walk up from a path to find the nearest .git directory. */
function findGitRoot(filePath: string): string | null {
  let dir = path.dirname(filePath);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

export interface MoveFileToolResult {
  ok: boolean;
  text: string;
}

export function moveFileSchema(): Tool {
  return {
    name: "move_file",
    description:
      "Move or rename a file or directory within the workspace. " +
      "Paths are relative to the workspace root. " +
      "Parent directories for the destination are created automatically. " +
      "Also works as a rename when source and destination are in the same directory.",
    parameters: Type.Object({
      source: Type.String({
        description:
          'Source path relative to workspace root, e.g. "notes/old-name.md".',
      }),
      destination: Type.String({
        description:
          'Destination path relative to workspace root, e.g. "notes/new-name.md".',
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

export function executeMoveFile(
  userHome: string,
  args: { source: string; destination: string; overwrite?: boolean },
): MoveFileToolResult {
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
  if (srcResolved === path.resolve(userHome)) {
    return { ok: false, text: `cannot move the workspace root` };
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

    // If overwrite and destination exists, remove it first
    if (fs.existsSync(dstResolved) && args.overwrite) {
      const dstStat = fs.statSync(dstResolved);
      if (dstStat.isDirectory()) {
        fs.rmSync(dstResolved, { recursive: true, force: true });
      } else {
        fs.rmSync(dstResolved);
      }
    }

    // Try git mv first if source is inside a git repo
    let usedGit = false;
    const gitRoot = findGitRoot(srcResolved);
    if (gitRoot) {
      try {
        execSync(
          `git mv ${JSON.stringify(srcResolved)} ${JSON.stringify(dstResolved)}`,
          { cwd: gitRoot, stdio: "pipe" },
        );
        usedGit = true;
      } catch {
        // git mv failed (untracked file, etc.) — fall through to fs move
      }
    }

    if (!usedGit) {
      fs.renameSync(srcResolved, dstResolved);
    }
  } catch (err) {
    // renameSync fails across filesystems; fall back to copy+delete
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      try {
        const stat = fs.statSync(srcResolved);
        if (stat.isDirectory()) {
          fs.cpSync(srcResolved, dstResolved, { recursive: true });
        } else {
          fs.copyFileSync(srcResolved, dstResolved);
        }
        fs.rmSync(srcResolved, { recursive: true, force: true });
      } catch (copyErr) {
        return {
          ok: false,
          text: `move failed (cross-device): ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`,
        };
      }
    } else {
      return {
        ok: false,
        text: `move failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { ok: true, text: `moved ${srcUri} → ${dstUri}` };
}
