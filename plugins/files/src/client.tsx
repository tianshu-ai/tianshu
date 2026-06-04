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
  X,
} from "lucide-react";
import type { PanelProps, PluginClientExports } from "@tianshu/plugin-sdk/client";

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

      {/* Footer */}
      <div className="border-t border-gray-800 px-3 py-1.5 text-[10px] text-gray-600">
        {plugin.displayName} v{plugin.version}
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
  const [data, setData] = useState<ReadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ext = (entry.extension ?? "").toLowerCase();
  const isImage = IMAGE_EXTS.has(ext);

  useEffect(() => {
    if (isImage) {
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
      });
    return () => {
      cancelled = true;
    };
  }, [entry.path, entry.size, entry.modifiedMs, isImage]);

  // ESC closes
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-full max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-gray-700 bg-gray-900 shadow-2xl"
        onClick={(ev) => ev.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            {fileIcon(entry)}
            <span className="truncate text-sm font-medium text-gray-100">
              {entry.name}
            </span>
            <span className="flex-shrink-0 text-[11px] text-gray-500">
              {formatSize(entry.size)} · {formatModified(entry.modifiedMs)}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost p-1.5"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto bg-gray-950">
          {error ? (
            <div className="p-6 text-center text-sm text-rose-300">{error}</div>
          ) : !data ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 size={20} className="animate-spin text-gray-500" />
            </div>
          ) : isImage ? (
            <img
              src={`${API_BASE}/raw?path=${encodeURIComponent(entry.path)}`}
              alt={entry.name}
              className="mx-auto max-h-full max-w-full"
            />
          ) : data.binary ? (
            <div className="p-6 text-center text-sm text-gray-500">
              Binary file ({formatSize(data.size)}). No preview available.
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-all p-4 font-mono text-xs text-gray-200">
              {data.content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

const exports_: PluginClientExports = {
  components: {
    FilesPanel,
  },
};

export const components = exports_.components;
export default exports_;
