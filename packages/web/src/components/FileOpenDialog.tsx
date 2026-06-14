// Host-mounted "open file" dialog.
//
// Anyone in the host UI (workboard task cards, plugin renderers,
// future surfaces) can ask to open a workspace file by calling
// `useOpenFile()` from @tianshu/plugin-sdk/client. The Files plugin
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

    void (async () => {
      try {
        // Use HEAD on /raw to grab the MIME without paying for the
        // body — most browsers send a Range request afterwards
        // anyway when we set the <img>/<video> src.
        const head = await fetch(rawUrl(cleaned), {
          method: "HEAD",
          credentials: "include",
          signal: controller.signal,
        });
        if (head.status === 404) {
          setView({ kind: "error", message: "File not found." });
          return;
        }
        if (!head.ok) {
          setView({
            kind: "error",
            message: `HEAD ${rawUrl(cleaned)} → ${head.status}`,
          });
          return;
        }
        const mime = head.headers.get("Content-Type") ?? "application/octet-stream";
        const size = Number(head.headers.get("Content-Length") ?? "0");
        const kind = classifyMime(mime);

        if (kind === "text") {
          // Pull text content via /read so we can show it inline
          // with truncation + line wrap.
          const r = await fetch(
            `/api/p/files/read?path=${encodeURIComponent(cleaned)}`,
            { credentials: "include", signal: controller.signal },
          );
          if (!r.ok) {
            setView({
              kind: "error",
              message: `read failed: HTTP ${r.status}`,
            });
            return;
          }
          const j = (await r.json()) as { content?: string; truncated?: boolean };
          setView({
            kind: "text",
            content: j.content ?? "",
            truncated: Boolean(j.truncated),
            size,
            mime,
          });
          return;
        }
        if (kind === "binary") {
          setView({ kind: "binary", mime, size });
          return;
        }
        // image / pdf / video / audio: hand the URL to a native tag.
        setView({ kind, mime } as ViewState);
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={close}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-lg border border-gray-700 bg-gray-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
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
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-gray-200">
                {view.content}
              </pre>
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
    </div>
  );
}
