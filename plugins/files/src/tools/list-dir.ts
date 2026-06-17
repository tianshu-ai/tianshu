// list_dir — agent tool that lists directory contents.
//
// Visibility scope is the per-user home (per-user-tools rule, see
// path-helper.ts). Returns a JSON-friendly tool-result; the agent
// then decides how to render or chain calls.

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import {
  resolveInUserHome,
  toWorkspaceUri,
  PathOutsideRootError,
} from "./path-helper.js";

const MAX_ENTRIES = 5000;

interface ListEntry {
  name: string;
  path: string;
  type: "directory" | "file" | "other";
  size: number;
  modifiedMs: number;
}

export interface ListDirToolResult {
  ok: boolean;
  text: string;
  entries?: ListEntry[];
  truncated?: boolean;
}

/** Build the tool definition (Type schema) and a separate executor.
 *  Keeping these separate lets the chat handler register the schema
 *  with pi-ai while invoking the executor inside its own loop with
 *  the per-request user home. */
export function listDirSchema(): Tool {
  return {
    name: "list_dir",
    description:
      "List the entries in a directory inside the workspace. Use this to discover " +
      "what files exist. Paths are interpreted relative to the workspace root; " +
      "prefer relative paths (`notes`, `src/foo`) over leading-slash forms. " +
      "Use `.` (or omit `path`) for the workspace root itself. " +
      "NOTE: a leading-slash path here means \"workspace root\", NOT the sandbox " +
      "OS root \u2014 inside `exec`, the same `/foo` would resolve to the sandbox " +
      "filesystem root. Stick to relative paths to keep both worlds aligned. " +
      "Returns at most 5000 entries; if truncated the response says so.",
    parameters: Type.Object({
      path: Type.String({
        description:
          'Directory path relative to the workspace root, e.g. ".", "notes", or "src/foo". Default "." (workspace root).',
      }),
    }),
  };
}

export function executeListDir(
  userHome: string,
  args: { path?: string },
): ListDirToolResult {
  const requested = args.path ?? "/";
  let resolved: string;
  try {
    resolved = resolveInUserHome(userHome, requested);
  } catch (err) {
    if (err instanceof PathOutsideRootError) {
      return { ok: false, text: `path is outside the workspace: ${requested}` };
    }
    throw err;
  }

  // Auto-create the user home on first read. Sub-paths are NOT auto-
  // created — that's a 404 the agent should observe.
  if (resolved === path.resolve(userHome) && !fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }

  if (!fs.existsSync(resolved)) {
    return { ok: false, text: `not found: ${requested}` };
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return { ok: false, text: `not a directory: ${requested}` };
  }

  const dirents = fs.readdirSync(resolved, { withFileTypes: true });
  const truncated = dirents.length > MAX_ENTRIES;
  const slice = dirents.slice(0, MAX_ENTRIES);
  const entries: ListEntry[] = slice.map((d) => {
    const full = path.join(resolved, d.name);
    let size = 0;
    let modifiedMs = 0;
    try {
      const s = fs.statSync(full);
      size = s.size;
      modifiedMs = s.mtimeMs;
    } catch {
      /* swallow — broken symlinks etc. */
    }
    const type: ListEntry["type"] = d.isDirectory()
      ? "directory"
      : d.isFile()
        ? "file"
        : "other";
    return {
      name: d.name,
      path: toWorkspaceUri(userHome, full),
      type,
      size,
      modifiedMs,
    };
  });
  // Directories first, then files alphabetically.
  entries.sort((a, b) => {
    if (a.type !== b.type) {
      if (a.type === "directory") return -1;
      if (b.type === "directory") return 1;
    }
    return a.name.localeCompare(b.name);
  });

  const lines = entries.map((e) =>
    e.type === "directory" ? `${e.path}/` : `${e.path}  (${e.size} bytes)`,
  );
  const header = `Directory ${toWorkspaceUri(userHome, resolved)} (${entries.length} ${entries.length === 1 ? "entry" : "entries"}${truncated ? ", truncated" : ""}):`;
  return {
    ok: true,
    text: [header, ...lines].join("\n"),
    entries,
    truncated,
  };
}
