// Host-mounted "open file" dialog.
//
// Anyone in the host UI (workboard task cards, plugin renderers,
// future surfaces) can ask to open a workspace file by calling
// `useOpenFile()` from @tianshu-ai/plugin-sdk/client. The Files plugin
// implements that hook by emitting a `tianshu:files:open` window
// event; THIS component listens for it, fetches the file via the
// host API (/api/p/files/read for text, /raw for binaries), and
// renders an in-page modal preview.
//
// Why host-mounted instead of inside the Files plugin:
//   - The Files plugin's panel is opt-in (toggled via top-bar
//     button), and we want the dialog to work even when the panel
//     is closed.
//   - Plugin-shipped React components only render at the slots the
//     manifest declares (rightPanels / sidebarSections / etc); we
//     don't have an "always-on overlay" slot. Adding one for one
//     dialog is more code than just owning it here.
//   - The dialog is a generic file viewer — it's the kind of thing
//     the host should provide so every plugin that emits an open
//     intent gets a consistent UX.

import { useCallback, useEffect, useState, type ReactElement } from "react";
import { File as FileIcon, Loader2, X } from "lucide-react";
import { useUiPrimitives } from "@tianshu-ai/plugin-sdk/client";

interface OpenIntent {
  /** Workspace path (URI / leading-slash / relative — same shapes
   *  the file tools accept). */
  path: string;
}

const MAX_TEXT_BYTES = 500_000;

type ViewState =
  | { kind: "loading" }
  | { kind: "text"; content: string; truncated: boolean; size: number; mime: string }
  | { kind: "image"; mime: string }
  | { kind: "pdf" }
  | { kind: "video"; mime: string }
  | { kind: "audio"; mime: string }
  | { kind: "binary"; mime: string; size: number }
  | { kind: "error"; message: string };

function classifyMime(mime: string): ViewState["kind"] {
  if (mime.startsWith("text/") || mime.startsWith("application/json")) {
    return "text";
  }
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "binary";
}

/** Best-effort MIME guess from extension. Mirrors the small table
 *  in plugins/files/src/server.ts so we get the same answer
 *  client-side without round-tripping a HEAD. */
function mimeForExt(path: string): string {
  const ext = path.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    case ".json":
      return "application/json; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".jsx":
    case ".ts":
    case ".tsx":
      return "text/javascript; charset=utf-8";
    case ".csv":
      return "text/csv; charset=utf-8";
    case "":
      return "application/octet-stream";
    default:
      return "text/plain; charset=utf-8";
  }
}

function basenameOf(p: string): string {
  const cleaned = p.replace(/^workspace:\/\/+/, "/");
  const segs = cleaned.split("/").filter(Boolean);
  return segs[segs.length - 1] ?? cleaned;
}

function rawUrl(path: string): string {
  const cleaned = path.replace(/^workspace:\/\/+/, "/");
  return `/api/p/files/raw?path=${encodeURIComponent(cleaned)}`;
}

export default function FileOpenDialog(): ReactElement | null {
  // Modal chrome comes from the host's shared primitive. We pass
  // `hideHeader` because this dialog has its own bespoke header
  // (filename + path + open-in-new-tab link + close button) that
  // we want to keep intact.
  const { Modal, DocumentViewer } = useUiPrimitives();
  const [intent, setIntent] = useState<OpenIntent | null>(null);
  const [view, setView] = useState<ViewState>({ kind: "loading" });

  // ─── Listen for open intents ──────────────────────────────────
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<{ path: string }>).detail;
      if (!detail?.path) return;
      setIntent({ path: detail.path });
    };
    window.addEventListener("tianshu:files:open", handler);
    return () => window.removeEventListener("tianshu:files:open", handler);
  }, []);

  // ─── Fetch on intent ──────────────────────────────────────────
  useEffect(() => {
    if (!intent) return;
    setView({ kind: "loading" });
    const controller = new AbortController();
    const cleaned = intent.path.replace(/^workspace:\/\/+/, "/");

    // Strategy: hit `/api/p/files/read` first. Returns either
    // {binary:false, content, size} (text — show inline) or
    // {binary:true, size} (binary — we then dispatch on extension
    // to pick a native viewer tag, or fall back to a download stub).
    // We deliberately skip a HEAD on /raw because the host's plugin
    // router only registers GET handlers — a HEAD comes back 404.
    void (async () => {
      try {
        const r = await fetch(
          `/api/p/files/read?path=${encodeURIComponent(cleaned)}`,
          { credentials: "include", signal: controller.signal },
        );
        if (r.status === 404) {
          setView({ kind: "error", message: "File not found." });
          return;
        }
        if (r.status === 413) {
          // File above /read's size cap. Fall through to binary
          // view so the user can still download via /raw.
          const j = (await r.json()) as { size?: number };
          setView({
            kind: "binary",
            mime: "application/octet-stream",
            size: j.size ?? 0,
          });
          return;
        }
        if (!r.ok) {
          setView({
            kind: "error",
            message: `read failed: HTTP ${r.status}`,
          });
          return;
        }
        const j = (await r.json()) as {
          content?: string;
          truncated?: boolean;
          binary?: boolean;
          size?: number;
        };
        const size = j.size ?? 0;
        if (!j.binary) {
          const mime = mimeForExt(cleaned);
          setView({
            kind: "text",
            content: j.content ?? "",
            truncated: Boolean(j.truncated),
            size,
            mime,
          });
          return;
        }
        // Binary: pick a viewer by extension.
        const mime = mimeForExt(cleaned);
        const kind = classifyMime(mime);
        if (
          kind === "image" ||
          kind === "pdf" ||
          kind === "video" ||
          kind === "audio"
        ) {
          setView({ kind, mime } as ViewState);
          return;
        }
        setView({ kind: "binary", mime, size });
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        setView({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return () => controller.abort();
  }, [intent]);

  // ─── Keyboard close ────────────────────────────────────────────
  const close = useCallback(() => setIntent(null), []);
  useEffect(() => {
    if (!intent) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [intent, close]);

  if (!intent) return null;
  const name = basenameOf(intent.path);
  const cleanedPath = intent.path.replace(/^workspace:\/\/+/, "/");
  const url = rawUrl(cleanedPath);

  return (
    <Modal isOpen onClose={close} size="xl" hideHeader className="bg-gray-900">
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-gray-800 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <FileIcon size={14} className="shrink-0 text-gray-400" />
            <div className="min-w-0">
              <div className="truncate font-medium text-gray-100" title={cleanedPath}>
                {name}
              </div>
              <div className="truncate font-mono text-[10px] text-gray-500">
                {cleanedPath}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded px-2 py-1 text-[11px] text-gray-400 hover:bg-gray-800 hover:text-gray-200"
              title="Open in new tab / download"
            >
              ↗ raw
            </a>
            <button
              type="button"
              onClick={close}
              className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-gray-200"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-auto bg-gray-950 p-3">
          {view.kind === "loading" && (
            <div className="flex h-32 items-center justify-center text-gray-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading…
            </div>
          )}
          {view.kind === "text" && (
            <>
              {view.truncated && (
                <div className="mb-2 rounded border border-amber-900/40 bg-amber-950/30 px-2 py-1 text-[11px] text-amber-200">
                  Truncated at {MAX_TEXT_BYTES.toLocaleString()} bytes — open
                  in a new tab via the ↗ button to see the full file.
                </div>
              )}
              {/* Shared DocumentViewer dispatches on filename:
                  .md / .markdown render through MarkdownBlock,
                  everything else falls through to a <pre>. Same
                  surface the files-plugin preview uses, so a .md
                  opened here looks identical to one opened from
                  the Files panel. */}
              <DocumentViewer
                content={view.content}
                filename={name}
                className="!p-0"
              />
            </>
          )}
          {view.kind === "image" && (
            <img
              src={url}
              alt={name}
              className="mx-auto max-h-[75vh] object-contain"
            />
          )}
          {view.kind === "pdf" && (
            <iframe
              src={url}
              title={name}
              className="h-[75vh] w-full rounded border border-gray-800 bg-white"
            />
          )}
          {view.kind === "video" && (
            <video
              src={url}
              controls
              className="mx-auto max-h-[75vh] w-full"
            >
              <track kind="captions" />
            </video>
          )}
          {view.kind === "audio" && (
            <audio src={url} controls className="mx-auto w-full">
              <track kind="captions" />
            </audio>
          )}
          {view.kind === "binary" && (
            <div className="space-y-2 text-center text-sm text-gray-300">
              <div className="text-gray-200">
                {view.mime} · {view.size.toLocaleString()} bytes
              </div>
              <div className="text-[12px] text-gray-500">
                Binary file — preview not available. Use the{" "}
                <span className="text-gray-300">↗ raw</span> button to
                download.
              </div>
            </div>
          )}
          {view.kind === "error" && (
            <div className="rounded border border-red-900/50 bg-red-950/40 px-3 py-2 text-[12px] text-red-300">
              {view.message}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
