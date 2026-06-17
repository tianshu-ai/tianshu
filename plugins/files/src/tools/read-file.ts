// read_file — agent tool that returns the contents of a small text file.
//
// Hard cap of 500 KB per call. For larger files the agent must page
// through with `offset` and `limit` (the response includes the next
// args you should pass).
//
// Binary files are detected heuristically (NUL byte in first 4 KB)
// and returned as a stub message rather than raw bytes — preserving
// the LLM's context window.

import fs from "node:fs";
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import { markChunk } from "./read-tracker.js";
import {
  resolveInUserHome,
  toWorkspaceUri,
  PathOutsideRootError,
} from "./path-helper.js";

export const MAX_TEXT_BYTES = 500_000;

export interface ReadFileToolResult {
  ok: boolean;
  text: string;
  binary?: boolean;
  size?: number;
  bytesReturned?: number;
  nextOffset?: number;
}

export function readFileSchema(): Tool {
  return {
    name: "read_file",
    description: `Read a text file from the workspace. Returns up to ${MAX_TEXT_BYTES / 1000} KB per call. \
For larger files, pass \`offset\` (byte offset to start at) and \`limit\` (max bytes); the \
response will tell you the file's full size and the next offset to use.

Paths are interpreted relative to the workspace root; prefer relative paths \
(\`notes/today.md\`) over leading-slash forms. A leading slash here resolves \
to the workspace root — NOT the sandbox OS root — so to avoid confusion when \
\`exec\` is also in play, write paths without a leading slash.

Binary files (image, archive, etc.) return a short stub instead of bytes — extract them \
to text first via another tool if you need their contents.`,
    parameters: Type.Object({
      path: Type.String({
        description: 'Path relative to the workspace root, e.g. "notes/today.md".',
      }),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "Byte offset to start reading from. Default 0.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: `Max bytes to return. Capped at ${MAX_TEXT_BYTES}.`,
        }),
      ),
    }),
  };
}

export function executeReadFile(
  userHome: string,
  args: { path: string; offset?: number; limit?: number },
  sessionId?: string,
): ReadFileToolResult {
  let resolved: string;
  try {
    resolved = resolveInUserHome(userHome, args.path);
  } catch (err) {
    if (err instanceof PathOutsideRootError) {
      return { ok: false, text: `path is outside the workspace: ${args.path}` };
    }
    throw err;
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, text: `not found: ${args.path}` };
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return { ok: false, text: `is a directory, not a file: ${args.path}` };
  }

  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const limit = Math.max(
    1,
    Math.min(args.limit ?? MAX_TEXT_BYTES, MAX_TEXT_BYTES),
  );

  const fd = fs.openSync(resolved, "r");
  try {
    const buf = Buffer.alloc(limit);
    const bytesRead = fs.readSync(fd, buf, 0, limit, offset);
    const slice = buf.subarray(0, bytesRead);

    // Binary check — first 4 KB of the slice.
    const probe = slice.subarray(0, Math.min(slice.length, 4096));
    if (probe.includes(0)) {
      return {
        ok: true,
        text: `(binary file: ${stat.size} bytes; not shown)`,
        binary: true,
        size: stat.size,
      };
    }

    const content = slice.toString("utf8");
    const nextOffset = offset + bytesRead;
    const more = nextOffset < stat.size;

    // Track which chunk this call covered. The session-level read
    // tracker accumulates start/end coverage across multiple
    // `read_file` calls so that a paged read sequence (offset=0 +
    // ... + final !more) ends up satisfying the read-required
    // precondition just like a single one-shot read does. A purely
    // mid-file partial read (offset>0 AND more=true) is a no-op
    // — the agent paged a region without seeing either endpoint.
    markChunk(sessionId, resolved, offset === 0, !more);

    const uri = toWorkspaceUri(userHome, resolved);
    const header =
      stat.size <= MAX_TEXT_BYTES
        ? `// ${uri} (${stat.size} bytes)`
        : `// ${uri} bytes ${offset}–${nextOffset} of ${stat.size}` +
          (more
            ? ` — call read_file again with offset=${nextOffset} for the next chunk`
            : " (final chunk)");

    return {
      ok: true,
      text: `${header}\n${content}`,
      size: stat.size,
      bytesReturned: bytesRead,
      nextOffset: more ? nextOffset : undefined,
    };
  } finally {
    fs.closeSync(fd);
  }
}
