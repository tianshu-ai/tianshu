// Server side of the `files` plugin.
//
// Read-only workspace browser. Lists directories and reads small text
// files from the tenant workspace at `<tenant>/workspace/`. We don't
// touch sandbox at all — the workspace is a host-side directory; the
// sandbox just bind-mounts it (per ADR-0001 §4).
//
// Path safety:
//   - paths are accepted as workspace-relative ("/" = workspace root)
//   - normalised, then asserted to live inside workspaceDir
//   - dotfiles are visible (workspace deliberately stores .config etc.)
//
// Hard limits:
//   - read returns at most 1 MB of text. Larger files return an error
//     with the byte size; the UI can hint at "open externally" later.
//   - list returns at most 5000 entries per directory.

import fs from "node:fs";
import path from "node:path";
import type {
  PluginContext,
  PluginRouteHandler,
  PluginServerExports,
  PluginServerModule,
} from "@tianshu/plugin-sdk";

const MAX_LIST_ENTRIES = 5000;
const MAX_READ_BYTES = 1_048_576; // 1 MB

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
        const requested = (req.query.dir as string | undefined) ?? "/";
        const resolved = resolveInsideWorkspace(ctx.workspaceDir, requested);
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
          .map((d): DirEntry => readEntry(resolved, ctx.workspaceDir, d));

        // Directories first, then files; alphabetical inside each group.
        entries.sort((a, b) => {
          if (a.type === "directory" && b.type !== "directory") return -1;
          if (a.type !== "directory" && b.type === "directory") return 1;
          return a.name.localeCompare(b.name);
        });

        const rel = "/" + path.relative(ctx.workspaceDir, resolved).replace(/\\/g, "/");
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
        const requested = req.query.path as string | undefined;
        if (!requested) {
          res.status(400).json({ error: "missing_path" });
          return;
        }
        const resolved = resolveInsideWorkspace(ctx.workspaceDir, requested);
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
            path: workspaceRel(ctx.workspaceDir, resolved),
            size: stat.size,
            modifiedMs: stat.mtimeMs,
            binary: true,
          });
          return;
        }
        res.json({
          path: workspaceRel(ctx.workspaceDir, resolved),
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
        const requested = req.query.path as string | undefined;
        if (!requested) {
          res.status(400).json({ error: "missing_path" });
          return;
        }
        const resolved = resolveInsideWorkspace(ctx.workspaceDir, requested);
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
        fs.createReadStream(resolved).pipe(res);
      } catch (err) {
        ctx.log.error("raw failed", { err: String(err) });
        if (!res.headersSent) res.status(500).json({ error: "internal" });
      }
    };

    return { routes: { list, read, raw } };
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
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function mimeFor(ext: string): string {
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export const activate = plugin.activate.bind(plugin);
export default plugin;

// ─── helpers ─────────────────────────────────────────────────────────

/** Returns the absolute path on disk if `requested` is a path inside
 *  `workspaceDir`, or null otherwise. Path traversal attempts and
 *  absolute paths outside the workspace are rejected. */
function resolveInsideWorkspace(workspaceDir: string, requested: string): string | null {
  // Normalise slashes; workspace-relative "/" → workspaceDir.
  let rel = requested.startsWith("/") ? requested.slice(1) : requested;
  // Reject backslash-only paths and `..` segments before resolution.
  // path.resolve already eats `..` but we want to be loud about it.
  rel = rel.replace(/\\/g, "/");
  const segments = rel.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "..")) return null;
  const resolved = path.resolve(workspaceDir, ...segments);
  const wsAbs = path.resolve(workspaceDir);
  if (!resolved.startsWith(wsAbs + path.sep) && resolved !== wsAbs) {
    return null;
  }
  return resolved;
}

function readEntry(
  parentDir: string,
  workspaceDir: string,
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
    path: workspaceRel(workspaceDir, full),
    type,
    size,
    modifiedMs,
    extension: type === "file" ? path.extname(dirent.name) || null : null,
  };
}

function workspaceRel(workspaceDir: string, abs: string): string {
  const rel = path.relative(workspaceDir, abs).replace(/\\/g, "/");
  return rel === "" ? "/" : "/" + rel;
}
