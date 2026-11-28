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
import { MAX_RETURN_CHARS, truncateForReturn } from "./return-cap.js";
import { alignUtf8Boundaries } from "./utf8-boundary.js";
import {
  badCharRatio,
  detectBinary,
  extractionHint,
  MAX_BAD_CHAR_RATIO,
} from "./binary-detect.js";
import {
  resolveInUserHome,
  toWorkspaceUri,
  PathOutsideRootError,
} from "./path-helper.js";

// NOTE: this caps how much we READ per call (data reachability via
// offset paging). It is deliberately generous. The limit on how much
// the MODEL sees in one tool result is MAX_RETURN_CHARS in
// return-cap.ts — a single 500 KB read would otherwise be ~125K
// tokens, which no model turn budget accommodates.
export const MAX_TEXT_BYTES = 500_000;

export interface ReadFileToolResult {
  ok: boolean;
  text: string;
  binary?: boolean;
  size?: number;
  bytesReturned?: number;
  nextOffset?: number;
  /** True when the returned text was middle-truncated to fit
   *  MAX_RETURN_CHARS. */
  truncated?: boolean;
  /** Character count of the returned (post-cap) text. */
  returnChars?: number;
  /** The character budget that applied. */
  maxReturnChars?: number;
  images?: Array<{ base64: string; mimeType?: string }>;
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
to text first via another tool if you need their contents.

Tool results are capped at ${MAX_RETURN_CHARS} characters. Larger content is folded \
(head + tail kept, middle elided) — page through with offset/limit for the rest.`,
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
    // Byte offsets page through the file, so a chunk boundary can land
    // mid-way through a multi-byte UTF-8 character. Decoding such a
    // slice yields U+FFFD at the seam — and because the next page
    // starts at the same byte, that character is never legible in
    // either page. Snap the slice to character boundaries instead.
    const aligned = alignUtf8Boundaries(buf.subarray(0, bytesRead), {
      atEnd: offset + bytesRead >= stat.size,
    });
    const slice = aligned.bytes;

    // Binary detection. L0 (NUL probe) is cheap but misses files
    // whose header region is printable ASCII while the payload is
    // compressed — PDF is the canonical case. detectBinary() layers
    // an extension allow-list and magic-byte signatures on top; the
    // decoded-text plausibility check (L3) runs further down, after
    // we have a string.
    const probe = slice.subarray(0, Math.min(slice.length, 4096));
    const verdict = detectBinary(resolved, probe);
    if (verdict.binary) {
      // Image files: return base64 so vision models can see them.
      const ext = resolved.split(".").pop()?.toLowerCase() ?? "";
      const imageMimes: Record<string, string> = {
        jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
        gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
        svg: "image/svg+xml", heic: "image/heic", heif: "image/heif",
        tif: "image/tiff", tiff: "image/tiff", avif: "image/avif",
      };
      const mime = imageMimes[ext];
      if (mime) {
        const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
        if (stat.size > MAX_IMAGE_BYTES) {
          return {
            ok: true,
            text: `(image too large for inline viewing: ${(stat.size / 1024 / 1024).toFixed(1)} MB — max ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`,
            binary: true,
            size: stat.size,
          };
        }
        const imgBuf = fs.readFileSync(resolved);
        const b64 = imgBuf.toString("base64");
        return {
          ok: true,
          text: `(image: ${toWorkspaceUri(userHome, resolved)}, ${stat.size} bytes, ${mime})`,
          binary: true,
          size: stat.size,
          images: [{ base64: b64, mimeType: mime }],
        };
      }
      // Not an image — tell the model WHAT it is and how to extract
      // it, rather than a bare "not shown" dead end.
      return {
        ok: true,
        text:
          `(binary file: ${stat.size} bytes; not shown as text)\n` +
          extractionHint(resolved, verdict.format, toWorkspaceUri(userHome, resolved)),
        binary: true,
        size: stat.size,
      };
    }

    const content = slice.toString("utf8");
    const nextOffset = offset + bytesRead;
    const more = nextOffset < stat.size;

    // L3 — last line of defence for unknown formats that slipped past
    // both the extension and magic checks (e.g. an extensionless
    // proprietary blob). Deliberately only applied on the FIRST chunk:
    // a mid-file page of a genuine text file can legitimately contain
    // an odd byte run, and the cheap checks already ran on the head.
    if (offset === 0) {
      const ratio = badCharRatio(content);
      if (ratio > MAX_BAD_CHAR_RATIO) {
        return {
          ok: true,
          text:
            `(binary file: ${stat.size} bytes — ${(ratio * 100).toFixed(0)}% of the ` +
            `first ${bytesRead} bytes are not valid UTF-8; not shown as text)\n` +
            extractionHint(resolved, undefined, toWorkspaceUri(userHome, resolved)),
          binary: true,
          size: stat.size,
        };
      }
    }

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

    // Cap what the model actually sees. A file well under
    // MAX_TEXT_BYTES can still decode to far more characters than a
    // turn can afford — and a mis-detected binary (e.g. a PDF whose
    // header bytes are all printable ASCII) decodes to hundreds of
    // thousands of U+FFFD replacement chars. Folding the middle here
    // keeps both cases inside the context budget while still showing
    // the head (imports/headers) and tail (final results/errors).
    const capped = truncateForReturn(`${header}\n${content}`, {
      resumeHint: more
        ? undefined
        : `Re-read with offset=<byte offset> to page through the rest.`,
    });

    return {
      ok: true,
      text: capped.text,
      size: stat.size,
      bytesReturned: bytesRead,
      nextOffset: more ? nextOffset : undefined,
      truncated: capped.truncated,
      returnChars: capped.text.length,
      maxReturnChars: MAX_RETURN_CHARS,
    };
  } finally {
    fs.closeSync(fd);
  }
}
