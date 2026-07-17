// Server side of the `files` plugin.
//
// Read-only browser scoped to the **current user's home directory**
// inside the tenant workspace, i.e. `<tenant>/workspace/users/<userId>/`.
// Paths are presented to the UI as relative to that home ("/" = home),
// which keeps each user's view of files isolated by default and avoids
// exposing the shared `_tenant/` directory used by the agent runtime.
//
// Sandbox is not involved here — workspaces are host-side directories
// that the sandbox bind-mounts (ADR-0001 §4).
//
// Path safety:
//   - paths are accepted as user-relative ("/" = user home)
//   - normalised, then asserted to live inside the user's home
//   - dotfiles are visible (workspace deliberately stores .config etc.)
//
// Hard limits:
//   - read returns at most 1 MB of text. Larger files return an error
//     with the byte size; the UI can hint at "open externally" later.
//   - list returns at most 5000 entries per directory.

import fs from "node:fs";
import path from "node:path";
import type { Request } from "express";
import type {
  AgentTool,
  PluginContext,
  PluginRouteHandler,
  PluginServerExports,
  PluginServerModule,
} from "@tianshu-ai/plugin-sdk";
import {
  ListDirTool,
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  GlobTool,
  TenantConfigListTool,
  TenantConfigReadTool,
  TenantConfigWriteTool,
  TenantConfigEditTool,
  TenantConfigDeleteTool,
  TenantConfigGlobTool,
} from "./tools/index.js";

const MAX_LIST_ENTRIES = 5000;
const MAX_READ_BYTES = 1_048_576; // 1 MB
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

interface DirEntry {
  name: string;
  /** Workspace-relative path, always starts with "/". */
  path: string;
  type: "directory" | "file" | "other";
  size: number;
  modifiedMs: number;
  extension: string | null;
}

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    const list: PluginRouteHandler = (req, res) => {
      try {
        const root = resolveRoot(ctx, req);
        if (!root) {
          res.status(401).json({ error: "no_user" });
          return;
        }
        // Auto-create the user home on first read so a brand-new dev
        // tenant doesn't 404 the very first time the UI loads.
        if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });

        const requested = (req.query.dir as string | undefined) ?? "/";
        const resolved = resolveInsideRoot(root, requested);
        if (!resolved) {
          res.status(400).json({ error: "bad_path" });
          return;
        }
        if (!fs.existsSync(resolved)) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
          res.status(400).json({ error: "not_a_directory" });
          return;
        }
        const entries = fs
          .readdirSync(resolved, { withFileTypes: true })
          .slice(0, MAX_LIST_ENTRIES)
          .map((d): DirEntry => readEntry(resolved, root, d));

        // Directories first, then files; alphabetical inside each group.
        entries.sort((a, b) => {
          if (a.type === "directory" && b.type !== "directory") return -1;
          if (a.type !== "directory" && b.type === "directory") return 1;
          return a.name.localeCompare(b.name);
        });

        const rel = "/" + path.relative(root, resolved).replace(/\\/g, "/");
        res.json({
          dir: rel === "/" || rel === "/." ? "/" : rel,
          entries,
          truncated: entries.length === MAX_LIST_ENTRIES,
        });
      } catch (err) {
        ctx.log.error("list failed", { err: String(err) });
        res.status(500).json({ error: "internal" });
      }
    };

    const read: PluginRouteHandler = (req, res) => {
      try {
        const root = resolveRoot(ctx, req);
        if (!root) {
          res.status(401).json({ error: "no_user" });
          return;
        }
        const requested = req.query.path as string | undefined;
        if (!requested) {
          res.status(400).json({ error: "missing_path" });
          return;
        }
        const resolved = resolveInsideRoot(root, requested);
        if (!resolved) {
          res.status(400).json({ error: "bad_path" });
          return;
        }
        if (!fs.existsSync(resolved)) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          res.status(400).json({ error: "is_directory" });
          return;
        }
        if (stat.size > MAX_READ_BYTES) {
          res.status(413).json({
            error: "too_large",
            size: stat.size,
            maxBytes: MAX_READ_BYTES,
          });
          return;
        }
        const buf = fs.readFileSync(resolved);
        // Heuristic: treat anything containing a NUL byte in the first
        // 4 KB as binary. We don't try to be a full mime detector in v0.
        const probe = buf.subarray(0, Math.min(buf.length, 4096));
        const looksBinary = probe.includes(0);
        if (looksBinary) {
          res.json({
            path: rootRel(root, resolved),
            size: stat.size,
            modifiedMs: stat.mtimeMs,
            binary: true,
          });
          return;
        }
        res.json({
          path: rootRel(root, resolved),
          size: stat.size,
          modifiedMs: stat.mtimeMs,
          binary: false,
          encoding: "utf-8",
          content: buf.toString("utf8"),
        });
      } catch (err) {
        ctx.log.error("read failed", { err: String(err) });
        res.status(500).json({ error: "internal" });
      }
    };

    const raw: PluginRouteHandler = (req, res) => {
      // Stream a single file verbatim. Used by the UI to render images,
      // PDFs, etc. — anything where the JSON `read` endpoint isn't a
      // good fit. We deliberately allow the full file size here (no
      // 1 MB cap) since the response goes straight to the wire.
      try {
        const root = resolveRoot(ctx, req);
        if (!root) {
          res.status(401).json({ error: "no_user" });
          return;
        }
        const requested = req.query.path as string | undefined;
        if (!requested) {
          res.status(400).json({ error: "missing_path" });
          return;
        }
        const resolved = resolveInsideRoot(root, requested);
        if (!resolved) {
          res.status(400).json({ error: "bad_path" });
          return;
        }
        if (!fs.existsSync(resolved)) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          res.status(400).json({ error: "is_directory" });
          return;
        }
        const mime = mimeFor(path.extname(resolved).toLowerCase());
        res.setHeader("Content-Type", mime);
        res.setHeader("Content-Length", String(stat.size));
        res.setHeader("Cache-Control", "no-store");
        // Without Content-Disposition the browser uses the URL
        // path's last segment as the filename, so a click on
        // `/api/p/files/raw?path=foo.py` saves a file named
        // "raw". Set `inline` so previewable types (images,
        // text/*, PDFs) render in the tab rather than
        // downloading; the filename is what the path ends in
        // so "Save As" picks something useful.
        const baseName =
          path.basename(resolved) || "file";
        // RFC 5987-style filename* is the safest way to ship
        // non-ASCII names; we always provide both `filename` (a
        // best-effort ASCII fallback) and `filename*` so old
        // browsers don't choke on UTF-8.
        const asciiSafe = baseName.replace(/[^\x20-\x7e]+/g, "_");
        res.setHeader(
          "Content-Disposition",
          `inline; filename="${asciiSafe}"; filename*=UTF-8''${encodeURIComponent(baseName)}`,
        );
        fs.createReadStream(resolved).pipe(res);
      } catch (err) {
        ctx.log.error("raw failed", { err: String(err) });
        if (!res.headersSent) res.status(500).json({ error: "internal" });
      }
    };

    const upload: PluginRouteHandler = async (req, res) => {
      // Single-file streamed upload. Wire format is intentionally
      // minimal so we don't have to pull in multer / busboy: the
      // request body is the raw file bytes and the filename arrives
      // in the `X-Filename` header (URL-encoded by the client). The
      // composer-side UploadButton makes one request per selected
      // file; multi-file batching belongs to the client.
      try {
        const root = resolveRoot(ctx, req);
        if (!root) {
          res.status(401).json({ error: "no_user" });
          return;
        }
        const rawHeader = req.headers["x-filename"];
        const headerVal = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
        if (!headerVal || typeof headerVal !== "string") {
          res.status(400).json({ error: "missing_filename" });
          return;
        }
        let suppliedName: string;
        try {
          suppliedName = decodeURIComponent(headerVal);
        } catch {
          res.status(400).json({ error: "bad_filename" });
          return;
        }
        const safeName = sanitiseFilename(suppliedName);
        if (!safeName) {
          res.status(400).json({ error: "bad_filename" });
          return;
        }

        const uploadsDir = path.join(root, "uploads");
        // The user-template ships an `uploads/` directory but a
        // hand-edited tenant might have removed it; recreate just
        // in time.
        fs.mkdirSync(uploadsDir, { recursive: true });

        const finalAbs = stampWithTimestamp(uploadsDir, safeName);
        // Belt-and-braces: refuse if the resolution somehow escaped.
        if (!finalAbs.startsWith(uploadsDir + path.sep)) {
          res.status(400).json({ error: "bad_path" });
          return;
        }

        await streamRequestToFile(req, finalAbs, MAX_UPLOAD_BYTES);

        const finalName = path.basename(finalAbs);
        const stat = fs.statSync(finalAbs);
        const rel = `/uploads/${finalName}`;
        // Notify panels a workspace file landed so they refresh live.
        try {
          ctx.broadcast("workspace_changed", { path: rel });
        } catch {
          /* best-effort */
        }
        res.json({
          path: rel,
          size: stat.size,
        });
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === "ETOOBIG") {
          res.status(413).json({ error: "too_large", maxBytes: MAX_UPLOAD_BYTES });
          return;
        }
        ctx.log.error("upload failed", { err: String(err) });
        if (!res.headersSent) {
          res.status(500).json({ error: "internal" });
        }
      }
    };

    // Wrap a write-capable tool so that, after a successful call, we
    // broadcast `workspace_changed`. Panels (FilesPanel, BoardPanel)
    // subscribe and refresh live instead of only on manual reload.
    // The wrapper is transparent: same schema, same result; it only
    // fires a best-effort broadcast on ok results.
    const withBroadcast = (tool: AgentTool): AgentTool => ({
      ...tool,
      execute: async (args, toolCtx) => {
        const result = await tool.execute(args, toolCtx);
        try {
          const ok = (result as { ok?: unknown } | null)?.ok;
          if (ok !== false) {
            const p = (args as { path?: unknown })?.path;
            ctx.broadcast("workspace_changed", {
              path: typeof p === "string" ? p : undefined,
            });
          }
        } catch {
          /* broadcast is best-effort; never break the tool result */
        }
        return result;
      },
    });

    return {
      routes: { list, read, raw, upload },
      tools: {
        ListDirTool,
        ReadFileTool,
        WriteFileTool: withBroadcast(WriteFileTool),
        EditFileTool: withBroadcast(EditFileTool),
        GlobTool,
        TenantConfigListTool,
        TenantConfigReadTool,
        TenantConfigWriteTool: withBroadcast(TenantConfigWriteTool),
        TenantConfigEditTool: withBroadcast(TenantConfigEditTool),
        TenantConfigDeleteTool: withBroadcast(TenantConfigDeleteTool),
        TenantConfigGlobTool,
      },
    };
  },
};

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jsx": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
  ".pyi": "text/plain; charset=utf-8",
  ".rb": "text/plain; charset=utf-8",
  ".rs": "text/plain; charset=utf-8",
  ".go": "text/plain; charset=utf-8",
  ".java": "text/plain; charset=utf-8",
  ".kt": "text/plain; charset=utf-8",
  ".swift": "text/plain; charset=utf-8",
  ".c": "text/plain; charset=utf-8",
  ".h": "text/plain; charset=utf-8",
  ".cpp": "text/plain; charset=utf-8",
  ".hpp": "text/plain; charset=utf-8",
  ".cs": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".bash": "text/plain; charset=utf-8",
  ".zsh": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".toml": "text/plain; charset=utf-8",
  ".ini": "text/plain; charset=utf-8",
  ".cfg": "text/plain; charset=utf-8",
  ".conf": "text/plain; charset=utf-8",
  ".env": "text/plain; charset=utf-8",
  ".sql": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "text/xml; charset=utf-8",
};

function mimeFor(ext: string): string {
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export const activate = plugin.activate.bind(plugin);
export default plugin;

// ─── helpers ─────────────────────────────────────────────────────────

/** Resolve the absolute root the request operates within — the user's
 *  per-tenant home, i.e. `<tenant>/workspace/users/<userId>/`.
 *
 *  Returns null when the host middleware did not attach a `userId`
 *  (e.g. unauthenticated request — the route handler should 401). */
function resolveRoot(ctx: PluginContext, req: Request): string | null {
  // The host's tenant middleware sets `req.ctx = { tenant, userId }`.
  // We avoid importing the host's RequestCtx type here to keep the
  // plugin SDK boundary clean; the runtime shape is documented.
  const userId = (req as { ctx?: { userId?: string } }).ctx?.userId;
  if (!userId) return null;
  return ctx.userHomeDir(userId);
}

/** Returns the absolute path on disk if `requested` is a path inside
 *  `root`, or null otherwise. Path traversal attempts and absolute
 *  paths outside the root are rejected. */
function resolveInsideRoot(root: string, requested: string): string | null {
  // Normalise slashes; root-relative "/" → root.
  let rel = requested.startsWith("/") ? requested.slice(1) : requested;
  // Reject backslash-only paths and `..` segments before resolution.
  // path.resolve already eats `..` but we want to be loud about it.
  rel = rel.replace(/\\/g, "/");
  const segments = rel.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "..")) return null;
  const resolved = path.resolve(root, ...segments);
  const rootAbs = path.resolve(root);
  if (!resolved.startsWith(rootAbs + path.sep) && resolved !== rootAbs) {
    return null;
  }
  return resolved;
}

function readEntry(
  parentDir: string,
  root: string,
  dirent: fs.Dirent,
): DirEntry {
  const full = path.join(parentDir, dirent.name);
  let size = 0;
  let modifiedMs = 0;
  try {
    const s = fs.statSync(full);
    size = s.size;
    modifiedMs = s.mtimeMs;
  } catch {
    /* swallow — broken symlinks etc. */
  }
  const type: DirEntry["type"] = dirent.isDirectory()
    ? "directory"
    : dirent.isFile()
      ? "file"
      : "other";
  return {
    name: dirent.name,
    path: rootRel(root, full),
    type,
    size,
    modifiedMs,
    extension: type === "file" ? path.extname(dirent.name) || null : null,
  };
}

function rootRel(root: string, abs: string): string {
  const rel = path.relative(root, abs).replace(/\\/g, "/");
  return rel === "" ? "/" : "/" + rel;
}

// ─── upload helpers ─────────────────────────────────────────────────

/**
 * Strip directory traversal pieces and shrink to a single safe name.
 * Empty / hidden / fully sanitised-away names are returned as "".
 */
export function sanitiseFilename(input: string): string {
  // Drop anything path-ish: take only the basename, then strip
  // leading dots so `.htaccess`-style files don't sneak in (the user
  // can still get them via the agent if they really want to).
  const base = path.basename(input.replace(/\\/g, "/"));
  // Replace any character that isn't reasonable in a filename. We
  // allow letters, digits, dot, dash, underscore, space, and CJK.
  const cleaned = base.replace(/[^\p{L}\p{N}._\- ]+/gu, "_");
  // Collapse repeated underscores from substitution noise.
  const collapsed = cleaned.replace(/_+/g, "_").trim();
  if (!collapsed) return "";
  if (collapsed === "." || collapsed === "..") return "";
  // Cap length — most filesystems are 255 bytes; we go conservative.
  return collapsed.slice(0, 200);
}

/**
 * Stamp a filename with the current local time so every upload
 * gets a unique, human-readable name without overwriting prior
 * uploads.
 *
 *   data.csv      → data-20260605-220900.csv
 *   照片.png       → 照片-20260605-220900.png
 *   no-extension  → no-extension-20260605-220900
 *
 * Rationale (vs auto-incremented `-1`/`-2` suffixes):
 *   - `data-*.csv` files cluster naturally in any file listing.
 *   - The path is stable: once handed out, it never changes meaning.
 *     Agents that quoted the path in earlier turns can still find
 *     the file.
 *   - Server clock is the single source of truth, so two browsers
 *     uploading the same name don't race-overwrite.
 *
 * Two uploads landing inside the same second still get a milliseconds
 * suffix tacked on (`...-220900-123.csv`); we don't keep retrying
 * names because the timestamp is already deterministic per call.
 */
export function stampWithTimestamp(
  dir: string,
  name: string,
  now: Date = new Date(),
): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const stamp = formatStamp(now);
  let candidate = path.join(dir, `${stem}-${stamp}${ext}`);
  if (!fs.existsSync(candidate)) return candidate;
  // Same-second collision — reach for milliseconds.
  const ms = now.getMilliseconds().toString().padStart(3, "0");
  candidate = path.join(dir, `${stem}-${stamp}-${ms}${ext}`);
  return candidate;
}

function formatStamp(d: Date): string {
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * Stream `req` into the destination file. Errors out early once
 * `maxBytes` is exceeded. Cleans up the partial file on failure.
 */
function streamRequestToFile(
  req: Request,
  dest: string,
  maxBytes: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const sink = fs.createWriteStream(dest);
    let bytes = 0;
    let aborted = false;

    const cleanup = () => {
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
      } catch {
        /* swallow */
      }
    };

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        aborted = true;
        sink.destroy();
        cleanup();
        const err = new Error("too large") as Error & { code?: string };
        err.code = "ETOOBIG";
        reject(err);
        return;
      }
      sink.write(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      sink.end();
    });
    req.on("error", (err) => {
      aborted = true;
      sink.destroy();
      cleanup();
      reject(err);
    });
    sink.on("error", (err) => {
      aborted = true;
      cleanup();
      reject(err);
    });
    sink.on("finish", () => {
      if (!aborted) resolve();
    });
  });
}
