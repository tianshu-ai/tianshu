// Board plugin — side panel.
//
// Lists the user's boards (board/<name>/index.html) and renders the
// selected one in a sandboxed iframe served by the plugin route
// GET /api/p/board/boards/<name>/index.html.
//
// Boards can be grouped: board/<group>/<name>/index.html. The panel
// shows a group selector that defaults to "ungrouped" (boards directly
// under board/). Grouped boards live in board/<group>/<name>/.
//
// This is the browse-anytime surface; the agent can also drop a board
// into the chat via the show_board tool (rendered by the shared MCP-UI
// iframe path). Refreshes its list on workspace changes.

import { useCallback, useEffect, useRef, useState } from "react";
import { Globe, ChevronDown, RefreshCw, Maximize2, Minimize2, Pin, FolderOpen } from "lucide-react";
import type { PanelProps, PluginClientExports } from "@tianshu-ai/plugin-sdk/client";
import { subscribeToWsEvent, sendWsMessage, usePluginT } from "@tianshu-ai/plugin-sdk/client";

const API_BASE = "/api/p/board";

/** null group = ungrouped */
const UNGROUPED = "__ungrouped__";

interface BoardMeta {
  name: string;
  group: string | null;
  title: string | null;
}

function BoardPanel(_props: PanelProps) {
  const t = usePluginT("board");
  const [allBoards, setAllBoards] = useState<BoardMeta[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>(UNGROUPED);
  const [selected, _setSelected] = useState<string | null>(null);
  const initialLoadDone = useRef(false);
  const setSelected = useCallback((v: string | null | ((prev: string | null) => string | null)) => {
    _setSelected((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      // Only persist when value actually changes
      if (next !== prev && initialLoadDone.current) {
        fetch("/api/preferences/board.selectedBoard", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: next }),
        }).catch(() => {});
      }
      return next;
    });
  }, []);
  const [iframeKey, setIframeKey] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);

  // Escape exits fullscreen
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);
  const [loading, setLoading] = useState(true);

  // Pin state
  const [isPinned, setIsPinned] = useState(false);
  useEffect(() => {
    const store = (window as any).__tianshuComposerStore;
    if (!store?.subscribe) return;
    const update = () => {
      const pins = store.getState().pinnedContexts ?? [];
      setIsPinned(selected ? pins.some((c: { id: string }) => c.id === `board:${selected}`) : false);
    };
    update();
    return store.subscribe(update);
  }, [selected]);

  const togglePin = () => {
    if (!selected) return;
    const store = (window as any).__tianshuComposerStore;
    if (!store?.getState?.()?.pinContext) return;
    const state = store.getState();
    const pinId = `board:${selected}`;
    if (state.pinnedContexts.some((c: { id: string }) => c.id === pinId)) {
      state.unpinContext(pinId);
    } else {
      state.pinContext({
        id: pinId,
        kind: "task" as const,
        label: `board:${selected}`,
        summary: `board=${selected}`,
      });
    }
  };
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  /** Board ref for API urls: "name" or "group/name". */
  const boardRef = useCallback((b: BoardMeta) => b.group ? `${b.group}/${b.name}` : b.name, []);

  /** Boards filtered by the selected group. */
  const visibleBoards = allBoards.filter((b) => {
    if (selectedGroup === UNGROUPED) return b.group === null;
    return b.group === selectedGroup;
  });

  const fetchBoards = useCallback(() => {
    fetch(`${API_BASE}/boards`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((res: { boards: string[]; boardsMeta?: BoardMeta[]; groups?: string[] }) => {
        const entries: BoardMeta[] = res.boardsMeta ?? res.boards.map((b) => ({ name: b, group: null, title: null }));
        const grps: string[] = res.groups ?? [];
        setAllBoards(entries);
        setGroups(grps);

        // Auto-select: if current selection still valid, keep it
        setSelected((cur) => {
          if (cur) {
            const still = entries.find((e) => (e.group ? `${e.group}/${e.name}` : e.name) === cur);
            if (still) return cur;
          }
          // Fallback: first ungrouped board
          const first = entries.find((e) => e.group === null);
          return first ? first.name : (entries[0] ? (entries[0].group ? `${entries[0].group}/${entries[0].name}` : entries[0].name) : null);
        });
      })
      .catch(() => { setAllBoards([]); setGroups([]); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    // Load persisted board selection THEN fetch board list
    fetch("/api/preferences/board.selectedBoard", { credentials: "include" })
      .then((r) => r.json())
      .then((j: { value?: string | null }) => {
        if (j.value) {
          _setSelected(j.value);
          // Infer group from persisted value
          const parts = j.value.split("/");
          if (parts.length === 2) {
            setSelectedGroup(parts[0]!);
          } else {
            setSelectedGroup(UNGROUPED);
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        initialLoadDone.current = true;
        fetchBoards();
      });
    return subscribeToWsEvent<{
      type: string;
      event?: string;
      payload?: { name?: string };
    }>("plugin_event", (ev) => {
      if (!ev.event) return;
      if (ev.event === "board:board_show") {
        const name = ev.payload?.name;
        if (typeof name === "string" && name) {
          setSelected(name);
          // Infer group
          const parts = name.split("/");
          if (parts.length === 2) setSelectedGroup(parts[0]!);
          else setSelectedGroup(UNGROUPED);
          setIframeKey((k) => k + 1);
          fetchBoards();
        }
        return;
      }
      if (ev.event.startsWith("board:board_act")) return;
      if (/board|workspace/i.test(ev.event)) {
        fetchBoards();
        setIframeKey((k) => k + 1);
      }
    });
  }, [fetchBoards]);

  // board_act bridge
  useEffect(() => {
    const offReq = subscribeToWsEvent<{
      type: string;
      event?: string;
      payload?: { reqId?: string; name?: string; op?: unknown };
    }>("plugin_event", (ev) => {
      if (ev.event !== "board:board_act_request") return;
      const reqId = ev.payload?.reqId;
      const name = ev.payload?.name;
      const op = ev.payload?.op;
      if (!reqId) return;
      if (name && name !== selectedRef.current) return;
      const win = iframeRef.current?.contentWindow;
      if (!win) {
        if (name && name === selectedRef.current) {
          sendWsMessage({
            type: "board_act_response",
            reqId,
            ok: false,
            error: `Board "${name}" is selected but its frame isn't ready yet.`,
          });
        }
        return;
      }
      win.postMessage({ type: "tianshu:board_act", reqId, op }, "*");
    });

    const onMsg = (ev: MessageEvent) => {
      const win = iframeRef.current?.contentWindow;
      if (win && ev.source !== win) return;
      const msg = ev.data as {
        type?: string;
        reqId?: string;
        ok?: boolean;
        data?: unknown;
        error?: string;
      } | null;
      if (!msg || msg.type !== "tianshu:board_act_response" || !msg.reqId) return;
      sendWsMessage({
        type: "board_act_response",
        reqId: msg.reqId,
        ok: msg.ok === true,
        data: msg.data,
        error: msg.error,
      });
    };
    window.addEventListener("message", onMsg);
    return () => {
      offReq();
      window.removeEventListener("message", onMsg);
    };
  }, []);

  const reload = () => {
    fetchBoards();
    setIframeKey((k) => k + 1);
  };

  const src = selected
    ? `${API_BASE}/boards/${encodeURIComponent(selected).replace(/%2F/g, "/")}/index.html`
    : "";

  const hasGroups = groups.length > 0;

  return (
    <div className={`flex flex-col overflow-hidden text-fg-default ${
      fullscreen
        ? "fixed inset-0 z-[9999] bg-bg-base"
        : "h-full"
    }`}>
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-surface px-3 py-1.5 relative z-10">
        {/* Group selector — only shown when groups exist */}
        {hasGroups && (
          <div className="relative">
            <select
              value={selectedGroup}
              onChange={(e) => {
                const g = e.target.value;
                setSelectedGroup(g);
                // Auto-select first board in the new group
                const inGroup = allBoards.filter((b) =>
                  g === UNGROUPED ? b.group === null : b.group === g
                );
                const first = inGroup[0];
                if (first) {
                  const ref = first.group ? `${first.group}/${first.name}` : first.name;
                  setSelected(ref);
                  setIframeKey((k) => k + 1);
                } else {
                  setSelected(null);
                }
              }}
              className="appearance-none rounded-md bg-bg-raised pl-2 pr-5 py-1 text-xs font-medium text-fg-muted hover:bg-bg-hover focus:outline-none cursor-pointer transition-colors"
            >
              <option value={UNGROUPED}>
                {t("panel.ungrouped")}
              </option>
              {groups.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
            <FolderOpen
              size={10}
              className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-fg-faint"
            />
          </div>
        )}

        {/* Board selector */}
        {visibleBoards.length > 0 ? (
          <div className="relative">
            <select
              value={selected ?? ""}
              onChange={(e) => {
                setSelected(e.target.value);
                setIframeKey((k) => k + 1);
              }}
              className="appearance-none rounded-md bg-bg-raised pl-2.5 pr-6 py-1 text-xs font-medium text-fg-muted hover:bg-bg-hover focus:outline-none cursor-pointer transition-colors"
            >
              {visibleBoards.map((b) => {
                const ref = b.group ? `${b.group}/${b.name}` : b.name;
                return (
                  <option key={ref} value={ref}>
                    {b.title || b.name}
                  </option>
                );
              })}
            </select>
            <ChevronDown
              size={12}
              className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-faint"
            />
          </div>
        ) : (
          <span className="text-sm text-fg-faint">{t("panel.noBoards")}</span>
        )}
        {selected && (
          <button
            onClick={togglePin}
            title={isPinned ? "Unpin board" : "Pin board to message"}
            className={`ml-auto rounded p-1 transition-colors ${
              isPinned ? "text-accent" : "text-fg-faint hover:text-fg-default hover:bg-bg-hover"
            }`}
          >
            <Pin size={12} />
          </button>
        )}
        <button
          onClick={reload}
          title={t("panel.refresh")}
          className={`${selected ? '' : 'ml-auto'} rounded p-1 text-fg-faint hover:text-fg-default hover:bg-bg-hover transition-colors`}
        >
          <RefreshCw size={12} />
        </button>
        <button
          onClick={() => setFullscreen((v) => !v)}
          title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          className="rounded p-1 text-fg-faint hover:text-fg-default hover:bg-bg-hover transition-colors"
        >
          {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
      </div>

      {selected && !loading && visibleBoards.some((b) => (b.group ? `${b.group}/${b.name}` : b.name) === selected) ? (
        <iframe
          key={iframeKey}
          ref={iframeRef}
          src={src}
          title={selected}
          sandbox="allow-scripts allow-forms allow-popups allow-same-origin allow-downloads"
          className="w-full flex-1 border-0 bg-white"
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center text-fg-fainter">
          <Globe size={28} className="mb-2 opacity-30" />
          <span className="text-xs">
            {loading ? t("panel.loading") : t("panel.noBoards")}
          </span>
          <span className="mt-1 text-xs text-fg-fainter">
            {t("panel.addHint")}
          </span>
        </div>
      )}
    </div>
  );
}

const exports: PluginClientExports = {
  components: { BoardPanel },
};

export default exports;
