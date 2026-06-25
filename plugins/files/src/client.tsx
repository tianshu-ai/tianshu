// Files plugin — client side.
//
// Visual style mirrors the closed-source predecessor's FilePanel:
// breadcrumbs, filter, sort, list/grid toggle, coloured file-type
// icons, hover row + size + modified columns, click-to-preview.
//
// This is the **read-only** v0 cut: no upload / mkdir / delete / rename
// (write endpoints don't exist yet). The bottom-half SandboxShell from
// the closed-source repo lives in a separate plugin (`console`) that
// will land after the sandbox host capability does.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpDown,
  Archive,
  ChevronRight,
  Code,
  File,
  FileSpreadsheet,
  FileText,
  Film,
  FolderOpen,
  Image as ImageIcon,
  LayoutGrid,
  LayoutList,
  Loader2,
  Music,
  RefreshCw,
  Search,
} from "lucide-react";
import type {
  AttachmentRendererProps,
  ComposerActionProps,
  PanelProps,
  PluginClientExports,
} from "@tianshu-ai/plugin-sdk/client";
import { __installOpenFileApi, useUiPrimitives } from "@tianshu-ai/plugin-sdk/client";
import { Paperclip } from "lucide-react";

interface DirEntry {
  name: string;
  path: string;
  type: "directory" | "file" | "other";
  size: number;
  modifiedMs: number;
  extension: string | null;
}

interface ListResponse {
  dir: string;
  entries: DirEntry[];
  truncated: boolean;
}

interface ReadResponse {
  path: string;
  size: number;
  modifiedMs: number;
  binary: boolean;
  encoding?: "utf-8";
  content?: string;
}

const API_BASE = "/api/p/files";

type SortKey = "name" | "size" | "modified";
type SortDir = "asc" | "desc";
type ViewMode = "list" | "grid";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg"]);
const CODE_EXTS = new Set([
  ".js", ".cjs", ".mjs", ".ts", ".jsx", ".tsx",
  ".py", ".rb", ".go", ".rs", ".c", ".cpp", ".h", ".java", ".kt", ".swift",
  ".sh", ".bash", ".zsh",
  ".lua", ".php", ".pl", ".vue", ".svelte",
]);
const STRUCT_EXTS = new Set([".json", ".yaml", ".yml", ".toml", ".xml", ".csv", ".tsv"]);
const VIDEO_EXTS = new Set([".mp4", ".avi", ".mov", ".mkv", ".webm", ".m4v"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a"]);
const ARCHIVE_EXTS = new Set([".zip", ".tar", ".gz", ".tgz", ".rar", ".7z", ".bz2"]);
const TEXT_EXTS = new Set([".md", ".markdown", ".txt", ".log", ".html", ".css", ".env"]);

function fileIcon(e: DirEntry) {
  if (e.type === "directory")
    return <FolderOpen size={16} className="text-yellow-500" />;
  const ext = (e.extension ?? "").toLowerCase();
  if (IMAGE_EXTS.has(ext)) return <ImageIcon size={16} className="text-green-400" />;
  if (CODE_EXTS.has(ext)) return <Code size={16} className="text-blue-400" />;
  if (STRUCT_EXTS.has(ext)) return <FileSpreadsheet size={16} className="text-orange-400" />;
  if (VIDEO_EXTS.has(ext)) return <Film size={16} className="text-purple-400" />;
  if (AUDIO_EXTS.has(ext)) return <Music size={16} className="text-pink-400" />;
  if (ARCHIVE_EXTS.has(ext)) return <Archive size={16} className="text-gray-400" />;
  if (TEXT_EXTS.has(ext)) return <FileText size={16} className="text-gray-300" />;
  return <File size={16} className="text-gray-500" />;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatModified(ms: number): string {
  if (ms === 0) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function FilesPanel({ plugin }: PanelProps) {
  const [dir, setDir] = useState("/");
  const [list, setList] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [view, setView] = useState<ViewMode>("list");
  const [preview, setPreview] = useState<DirEntry | null>(null);

  const fetchList = useCallback(async (target: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/list?dir=${encodeURIComponent(target)}`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error(`${r.status}`);
      const data = (await r.json()) as ListResponse;
      setList(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setList(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchList(dir);
  }, [dir, fetchList]);

  const sorted = useMemo(() => {
    if (!list) return [];
    const copy = [...list.entries];
    copy.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      let cmp = 0;
      if (sortKey === "name") cmp = a.name.localeCompare(b.name);
      else if (sortKey === "size") cmp = a.size - b.size;
      else cmp = a.modifiedMs - b.modifiedMs;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [list, sortKey, sortDir]);

  const filtered = useMemo(() => {
    if (!filter) return sorted;
    const q = filter.toLowerCase();
    return sorted.filter((e) => e.name.toLowerCase().includes(q));
  }, [sorted, filter]);

  const navigate = (target: string) => {
    setFilter("");
    setDir(target);
  };

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const breadcrumbs = dir === "/" ? ["/"] : ["/", ...dir.split("/").filter(Boolean)];

  return (
    <div className="flex h-full flex-col bg-gray-950 text-gray-300">
      {/* Toolbar — breadcrumbs */}
      <div className="space-y-2 border-b border-gray-800 px-3 py-2">
        <div className="flex items-center gap-1 overflow-x-auto text-sm">
          {dir !== "/" && (
            <button
              type="button"
              onClick={() => navigate(dir.substring(0, dir.lastIndexOf("/")) || "/")}
              className="mr-1 shrink-0 text-gray-500 hover:text-gray-300"
              title="Up one level"
            >
              <ArrowLeft size={14} />
            </button>
          )}
          {breadcrumbs.map((part, i) => {
            const path = i === 0 ? "/" : "/" + breadcrumbs.slice(1, i + 1).join("/");
            const isLast = i === breadcrumbs.length - 1;
            return (
              <span key={i} className="flex shrink-0 items-center">
                {i > 0 && <ChevronRight size={12} className="mx-0.5 text-gray-600" />}
                <button
                  type="button"
                  onClick={() => navigate(path)}
                  className={[
                    "rounded px-1 hover:text-white",
                    isLast ? "font-medium text-white" : "text-gray-500",
                  ].join(" ")}
                >
                  {i === 0 ? "~" : part}
                </button>
              </span>
            );
          })}
        </div>

        {/* Filter + actions */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500"
            />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter files..."
              className="w-full rounded border border-gray-800 bg-gray-900 py-1 pl-8 pr-2 text-sm text-gray-300 placeholder-gray-600 focus:border-gray-600 focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => fetchList(dir)}
            className="rounded p-1.5 text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            type="button"
            onClick={() => setView(view === "list" ? "grid" : "list")}
            className="rounded p-1.5 text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            title="Toggle view"
          >
            {view === "list" ? <LayoutGrid size={14} /> : <LayoutList size={14} />}
          </button>
        </div>
      </div>

      {/* Sort header (list view only) */}
      {view === "list" && (
        <div className="flex select-none items-center border-b border-gray-800/50 px-3 py-1 text-xs text-gray-500">
          <button
            type="button"
            onClick={() => toggleSort("name")}
            className="flex flex-1 items-center gap-1 text-left hover:text-gray-300"
          >
            Name {sortKey === "name" && <ArrowUpDown size={10} />}
          </button>
          <button
            type="button"
            onClick={() => toggleSort("size")}
            className="flex w-20 items-center justify-end gap-1 text-right hover:text-gray-300"
          >
            Size {sortKey === "size" && <ArrowUpDown size={10} />}
          </button>
          <button
            type="button"
            onClick={() => toggleSort("modified")}
            className="flex w-24 items-center justify-end gap-1 text-right hover:text-gray-300"
          >
            Modified {sortKey === "modified" && <ArrowUpDown size={10} />}
          </button>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-auto">
        {loading && !list ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 size={20} className="animate-spin text-gray-500" />
          </div>
        ) : error ? (
          <div className="p-4 text-center text-sm text-rose-400">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-600">
            {filter ? "No matching files" : "Empty directory"}
          </div>
        ) : view === "list" ? (
          <ul className="divide-y divide-gray-800/30">
            {filtered.map((e) => (
              <li
                key={e.path}
                className="group flex cursor-pointer items-center px-3 py-1.5 hover:bg-gray-800/50"
                onClick={() => {
                  if (e.type === "directory") navigate(e.path);
                  else setPreview(e);
                }}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {fileIcon(e)}
                  <span className="truncate text-sm">{e.name}</span>
                </div>
                <span className="w-20 text-right text-xs text-gray-500">
                  {e.type === "file" ? formatSize(e.size) : "—"}
                </span>
                <span className="w-24 text-right text-xs text-gray-500">
                  {formatModified(e.modifiedMs)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="grid grid-cols-3 gap-2 p-3">
            {filtered.map((e) => (
              <button
                key={e.path}
                type="button"
                onClick={() => {
                  if (e.type === "directory") navigate(e.path);
                  else setPreview(e);
                }}
                className="flex cursor-pointer flex-col items-center rounded-lg p-3 hover:bg-gray-800/50"
              >
                <div className="mb-1">{fileIcon(e)}</div>
                <span className="w-full truncate text-center text-xs">{e.name}</span>
              </button>
            ))}
          </div>
        )}

        {list?.truncated && (
          <div className="px-3 py-2 text-[10px] text-amber-400">
            Listing truncated at 5000 entries.
          </div>
        )}
      </div>

      {preview && <FilePreviewModal entry={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

// ─── preview ─────────────────────────────────────────────────────────

function FilePreviewModal({
  entry,
  onClose,
}: {
  entry: DirEntry;
  onClose: () => void;
}) {
  // Modal chrome + body dispatch come from the host's shared UI
  // primitives. We keep an image short-circuit because the plugin
  // streams binary bytes through /raw rather than inlining into
  // the JSON `read` response.
  const { Modal, DocumentViewer } = useUiPrimitives();
  const [data, setData] = useState<ReadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const ext = (entry.extension ?? "").toLowerCase();
  const isImage = IMAGE_EXTS.has(ext);

  useEffect(() => {
    if (isImage) {
      // Skip the JSON read path; we'll <img src=/raw> below.
      setData({
        path: entry.path,
        size: entry.size,
        modifiedMs: entry.modifiedMs,
        binary: true,
      });
      return;
    }
    let cancelled = false;
    setError(null);
    setLoading(true);
    fetch(`${API_BASE}/read?path=${encodeURIComponent(entry.path)}`, {
      credentials: "include",
    })
      .then(async (r) => {
        if (!r.ok) {
          if (r.status === 413) {
            const body = (await r.json()) as { size: number; maxBytes: number };
            throw new Error(
              `File is ${formatSize(body.size)}, exceeds the ${formatSize(body.maxBytes)} preview cap.`,
            );
          }
          throw new Error(`HTTP ${r.status}`);
        }
        return (await r.json()) as ReadResponse;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entry.path, entry.size, entry.modifiedMs, isImage]);

  return (
    <Modal isOpen onClose={onClose} title={entry.name} size="lg">
      <div className="flex h-full flex-col">
        {/* Sub-header with file metadata + icon. Modal already
            owns the close button + name in its own header. */}
        <div className="flex items-center gap-2 border-b border-gray-800 px-4 py-2 text-[11px] text-gray-500">
          {fileIcon(entry)}
          <span>
            {formatSize(entry.size)} · {formatModified(entry.modifiedMs)}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-gray-950">
          {isImage ? (
            <img
              src={`${API_BASE}/raw?path=${encodeURIComponent(entry.path)}`}
              alt={entry.name}
              className="mx-auto max-h-full max-w-full"
            />
          ) : (
            <DocumentViewer
              content={data && !data.binary ? data.content ?? "" : null}
              filename={entry.name}
              binary={data?.binary === true && !isImage}
              loading={loading}
              error={error}
              sizeBytes={data?.size ?? entry.size}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

// ─── Composer button: file uploads ─────────────────────────────────
//
// Renders one paperclip button in the chat composer. On click the
// native file picker opens (multi-select). For each selected file:
//
//   1. composer.addAttachment({ status: "uploading" })
//   2. POST /api/p/files/upload as raw bytes (X-Filename header)
//   3. composer.updateAttachment(id, { status: "ready", path })
//      or { status: "error", error } on failure
//
// We register a draft transform once so that whenever the composer
// sends, the user's text gets a `[Attached files]` addendum. The
// agent learns about ./uploads/ via the system prompt (PR #46) so
// the addendum is purely informational.

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function UploadButton(props: ComposerActionProps) {
  const { composer } = props;
  const inputRef = useRef<HTMLInputElement>(null);

  // We do NOT register a draft transform anymore: image attachments
  // ride on the WS prompt's `attachments` field as first-class
  // content. The server constructs a multimodal UserMessage. For
  // non-image files the server appends a brief text note pointing
  // at the path so the agent can `read_file` if it wants.

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = ""; // reset so picking the same file twice still works

    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        composer.addAttachment({
          name: file.name,
          size: file.size,
          status: "error",
          error: `File exceeds ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)} MB cap`,
          mimeType: file.type || "application/octet-stream",
        });
        continue;
      }
      const id = composer.addAttachment({
        name: file.name,
        size: file.size,
        status: "uploading",
        mimeType: file.type || "application/octet-stream",
      });
      void uploadOne(file, id, composer);
    }
  };

  const click = () => inputRef.current?.click();

  return (
    <>
      <button
        type="button"
        onClick={click}
        title="Attach file"
        aria-label="Attach file"
        className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-700 hover:text-gray-200"
      >
        <Paperclip size={16} />
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onPick}
      />
    </>
  );
}

async function uploadOne(
  file: File,
  attachmentId: string,
  composer: ComposerActionProps["composer"],
): Promise<void> {
  try {
    const resp = await fetch(`${API_BASE}/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": encodeURIComponent(file.name),
      },
      body: file,
    });
    if (!resp.ok) {
      const text = await safeText(resp);
      composer.updateAttachment(attachmentId, {
        status: "error",
        error: `${resp.status}: ${text}`,
      });
      return;
    }
    const json = (await resp.json()) as { path: string; size: number };
    composer.updateAttachment(attachmentId, {
      status: "ready",
      path: json.path,
      size: json.size,
    });
  } catch (err) {
    composer.updateAttachment(attachmentId, {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 200);
  } catch {
    return "(no body)";
  }
}



// ─── Attachment renderers ────────────────────────────────────────────────
//
// Two contributions: ImageAttachment (mimePattern "image/*") and
// FileAttachment (mimePattern "*/*", catch-all). The host walks
// renderers in order so an image always reaches the image one
// first; everything else falls through to the chip.
//
// `props.rawUrl` is provided by the host so we don't hard-code the
// /api/p/files/raw path.

function ImageAttachment({ attachment, rawUrl }: AttachmentRendererProps) {
  const url = rawUrl(attachment.path);
  const label = attachment.name ?? attachment.path;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={label}
      className="overflow-hidden rounded-md border border-gray-800 bg-gray-900/60"
    >
      <img
        src={url}
        alt={label}
        className="block max-h-48 max-w-[16rem] object-contain"
        loading="lazy"
      />
    </a>
  );
}

function FileAttachment({ attachment }: AttachmentRendererProps) {
  const label = attachment.name ?? attachment.path;
  return (
    <div
      className="flex items-center gap-1.5 rounded-md border border-gray-800 bg-gray-900/60 px-2 py-1 text-xs text-gray-200"
      title={attachment.path}
    >
      <File size={12} className="text-gray-400" />
      <span className="max-w-[12rem] truncate">{label}</span>
      <span className="text-[10px] text-gray-500">
        {formatSize(attachment.size ?? 0)}
      </span>
    </div>
  );
}

// Register the Files plugin's `OpenFileApi` implementation as soon
// as the bundle loads. Anyone who calls `useOpenFile()` after this
// runs gets the modal-dialog flow below; before this runs, the host
// bootstrap fallback opens the raw URL in a new tab. The handler
// just sets a window event so the always-mounted FilesOpenHost
// component can render the dialog — we can't render React from a
// module top-level.
__installOpenFileApi({
  open(path: string): void {
    window.dispatchEvent(
      new CustomEvent("tianshu:files:open", {
        detail: { path },
      }),
    );
  },
});

const exports_: PluginClientExports = {
  components: {
    FilesPanel,
    // Cast through a wide ComponentType because the SDK's components
    // map is a union over PanelProps / SidebarSectionProps /
    // ComposerActionProps / AttachmentRendererProps, and individual
    // components are narrower than the union.
    UploadButton: UploadButton as PluginClientExports["components"][string],
    ImageAttachment: ImageAttachment as PluginClientExports["components"][string],
    FileAttachment: FileAttachment as PluginClientExports["components"][string],
  },
};

export const components = exports_.components;
export default exports_;
