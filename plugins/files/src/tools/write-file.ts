// write_file — agent tool that creates or overwrites a file.
//
// Atomic-ish: writes via a `<file>.tmp.<pid>` sibling and renames into
// place, so a partial write doesn't leave a half-baked target if the
// process crashes mid-write.
//
// Parent directories are created on demand.
//
// Refuses to write outside the user home (path-helper enforced).

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import { loadPrompt } from "./load-prompt.js";
import {
  resolveInUserHome,
  toWorkspaceUri,
  PathOutsideRootError,
} from "./path-helper.js";

const MAX_WRITE_BYTES = 5_000_000; // 5 MB

export interface WriteFileToolResult {
  ok: boolean;
  text: string;
  bytesWritten?: number;
}

export function writeFileSchema(): Tool {
  return {
    name: "write_file",
    description: loadPrompt("write-file.prompt.md"),
    parameters: Type.Object({
      path: Type.String({
        description: 'Path relative to the workspace root, e.g. "/notes/today.md".',
      }),
      content: Type.String({
        description: "Full file contents to write. UTF-8 encoded.",
      }),
    }),
  };
}

export function executeWriteFile(
  userHome: string,
  args: { path: string; content: string },
): WriteFileToolResult {
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
    return { ok: false, text: `cannot write to the workspace root` };
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
  // Write to a temp sibling and rename so partial writes don't trash
  // the target on crash.
  const tmp = `${resolved}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, resolved);

  return {
    ok: true,
    // Emit the canonical workspace:// URI so the LLM has one shape
    // to reference produced files in its reply (the chat UI's
    // urlTransform recognises it). Single source of truth: every
    // fs tool round-trips paths through toWorkspaceUri.
    text: `wrote ${buf.length} bytes to ${toWorkspaceUri(userHome, resolved)}`,
    bytesWritten: buf.length,
  };
}
