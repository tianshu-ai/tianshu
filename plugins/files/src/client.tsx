// Client side of the `files` plugin.
//
// The chat shell's PluginRegistry (PR #33) imports this module and
// looks up `components.FilesPanel` based on the manifest's
// `contributes.rightPanels[0].component`. Until PR #33 lands the host
// doesn't actually render this — but exporting the right shape now
// keeps the manifest claim and the code in lockstep.

import { useEffect, useState } from "react";
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

const API_BASE = "/api/p/files";

function FilesPanel({ plugin }: PanelProps) {
  const [dir, setDir] = useState("/");
  const [list, setList] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch(`${API_BASE}/list?dir=${encodeURIComponent(dir)}`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return (await r.json()) as ListResponse;
      })
      .then((data) => {
        if (!cancelled) setList(data);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  const parent = dir === "/" ? null : dir.replace(/\/[^/]+$/, "") || "/";

  return (
    <div className="flex h-full flex-col text-sm">
      <header className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
        <span className="truncate text-xs text-gray-400" title={dir}>
          {dir}
        </span>
        <span className="text-[10px] text-gray-600">{plugin.displayName} v{plugin.version}</span>
      </header>
      {error && (
        <div className="border-b border-rose-700/50 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      )}
      <ul className="flex-1 overflow-y-auto px-2 py-1">
        {parent !== null && (
          <li>
            <button
              type="button"
              onClick={() => setDir(parent)}
              className="w-full rounded px-2 py-1 text-left text-xs text-gray-400 hover:bg-gray-800"
            >
              ..
            </button>
          </li>
        )}
        {list?.entries.map((e) => (
          <li key={e.path}>
            <button
              type="button"
              onClick={() => {
                if (e.type === "directory") setDir(e.path);
              }}
              disabled={e.type !== "directory"}
              className={[
                "flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs",
                e.type === "directory" ? "text-gray-200 hover:bg-gray-800" : "text-gray-500",
              ].join(" ")}
            >
              <span className="truncate">
                {e.type === "directory" ? "📁" : "📄"} {e.name}
              </span>
              {e.type === "file" && (
                <span className="ml-2 flex-shrink-0 text-[10px] text-gray-600">
                  {formatSize(e.size)}
                </span>
              )}
            </button>
          </li>
        ))}
        {list?.truncated && (
          <li className="px-2 py-1 text-[10px] text-amber-400">
            list truncated (over 5000 entries).
          </li>
        )}
      </ul>
    </div>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const exports_: PluginClientExports = {
  components: {
    FilesPanel,
  },
};

export const components = exports_.components;
export default exports_;
