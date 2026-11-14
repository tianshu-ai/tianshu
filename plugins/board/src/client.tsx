// Board plugin — side panel with sharing support.
//
// Lists the user's boards + boards shared by others, renders the
// selected one in a sandboxed iframe. Supports sharing boards with
// other users in the same tenant.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Globe, ChevronDown, RefreshCw, Maximize2, Minimize2, Pin,
  FolderOpen, Share2, X, UserPlus, Users, Check,
} from "lucide-react";
import type { PanelProps, PluginClientExports } from "@tianshu-ai/plugin-sdk/client";
import { subscribeToWsEvent, sendWsMessage, usePluginT } from "@tianshu-ai/plugin-sdk/client";

const API_BASE = "/api/p/board";

const UNGROUPED = "__ungrouped__";

interface BoardMeta {
  name: string;
  group: string | null;
  title: string | null;
}

interface SharedBoard {
  ownerUserId: string;
  boardRef: string;
  name: string;
  title: string | null;
  shared: true;
}

interface TenantUser {
  id: string;
  displayName: string;
  provider: string;
}

interface ShareEntry {
  userId: string;
  createdAt: number;
}

// ─── Share Dialog ────────────────────────────────────────────────

function ShareDialog({
  boardRef,
  onClose,
}: {
  boardRef: string;
  onClose: () => void;
}) {
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [shares, setShares] = useState<ShareEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [sharing, setSharing] = useState<string | null>(null);

  const fetchData = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch(`${API_BASE}/users`, { credentials: "include" })
        .then(r => r.json())
        .catch(() => ({ users: [] })),
      fetch(`${API_BASE}/board-shares/${encodeURIComponent(boardRef)}`, { credentials: "include" })
        .then(r => r.json())
        .catch(() => ({ shares: [] })),
    ]).then(([uRes, sRes]) => {
      setUsers(uRes.users ?? []);
      setShares(sRes.shares ?? []);
    }).finally(() => setLoading(false));
  }, [boardRef]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const sharedUserIds = new Set(shares.map(s => s.userId));

  const toggleShare = async (userId: string) => {
    setSharing(userId);
    try {
      if (sharedUserIds.has(userId)) {
        await fetch(`${API_BASE}/board-shares/${encodeURIComponent(boardRef)}/remove/${userId}`, {
          method: "DELETE", credentials: "include",
        });
      } else {
        await fetch(`${API_BASE}/board-shares/${encodeURIComponent(boardRef)}/add`, {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId }),
        });
      }
      fetchData();
    } catch { /* ignore */ }
    setSharing(null);
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[300px] max-h-[360px] rounded-xl border border-border-default shadow-2xl flex flex-col overflow-hidden bg-bg-surface"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
          <Share2 size={14} className="text-accent" />
          <span className="text-sm font-medium text-fg-default">共享看板</span>
          <span className="text-xs text-fg-faint ml-1 truncate max-w-[140px]">{boardRef}</span>
          <button onClick={onClose} className="ml-auto p-1 rounded text-fg-faint hover:text-fg-default hover:bg-bg-hover">
            <X size={14} />
          </button>
        </div>

        {/* User list */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading ? (
            <div className="flex items-center justify-center py-6 text-fg-faint text-xs">加载中...</div>
          ) : users.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-fg-faint text-xs">
              <Users size={20} className="opacity-30" />
              <span>当前租户没有其他用户</span>
            </div>
          ) : (
            users
              .filter(u => u.provider !== "auth:token-mint" && u.provider !== "auth:bridge")
              .map(u => {
                const isShared = sharedUserIds.has(u.id);
                const isBusy = sharing === u.id;
                return (
                  <div
                    key={u.id}
                    className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-bg-hover transition-colors"
                  >
                    <div className="w-6 h-6 rounded-full bg-bg-raised flex items-center justify-center text-fg-faint text-[10px] font-medium shrink-0">
                      {u.displayName.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-fg-default truncate">{u.displayName}</div>
                      <div className="text-[10px] text-fg-faint truncate">{u.id}</div>
                    </div>
                    <button
                      onClick={() => toggleShare(u.id)}
                      disabled={isBusy}
                      className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
                        isShared
                          ? "bg-accent/15 text-accent hover:bg-rose-500/15 hover:text-rose-400"
                          : "bg-bg-raised text-fg-muted hover:bg-accent/15 hover:text-accent"
                      }`}
                    >
                      {isBusy ? "..." : isShared ? (
                        <span className="flex items-center gap-1"><Check size={10} />已共享</span>
                      ) : (
                        <span className="flex items-center gap-1"><UserPlus size={10} />共享</span>
                      )}
                    </button>
                  </div>
                );
              })
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Board Panel ─────────────────────────────────────────────────

function BoardPanel(_props: PanelProps) {
  const t = usePluginT("board");
  const [allBoards, setAllBoards] = useState<BoardMeta[]>([]);
  const [sharedBoards, setSharedBoards] = useState<SharedBoard[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>(UNGROUPED);
  const [selected, _setSelected] = useState<string | null>(null);
  // Track whether selection is a shared board
  const [selectedShared, setSelectedShared] = useState<SharedBoard | null>(null);
  const initialLoadDone = useRef(false);
  const [shareDialogBoard, setShareDialogBoard] = useState<string | null>(null);

  const setSelected = useCallback((v: string | null | ((prev: string | null) => string | null)) => {
    _setSelected((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
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

  const boardRef = useCallback((b: BoardMeta) => b.group ? `${b.group}/${b.name}` : b.name, []);

  const visibleBoards = allBoards.filter((b) => {
    if (selectedGroup === UNGROUPED) return b.group === null;
    return b.group === selectedGroup;
  });

  const fetchBoards = useCallback(() => {
    fetch(`${API_BASE}/boards`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((res: { boards: string[]; boardsMeta?: BoardMeta[]; groups?: string[]; sharedBoards?: SharedBoard[] }) => {
        const entries: BoardMeta[] = res.boardsMeta ?? res.boards.map((b: string) => ({ name: b, group: null, title: null }));
        const grps: string[] = res.groups ?? [];
        setAllBoards(entries);
        setGroups(grps);
        setSharedBoards(res.sharedBoards ?? []);

        setSelected((cur) => {
          if (cur) {
            // Check own boards
            const still = entries.find((e) => (e.group ? `${e.group}/${e.name}` : e.name) === cur);
            if (still) return cur;
            // Check shared boards
            const sharedStill = (res.sharedBoards ?? []).find(
              (s: SharedBoard) => `shared:${s.ownerUserId}/${s.boardRef}` === cur
            );
            if (sharedStill) return cur;
          }
          const first = entries.find((e) => e.group === null);
          return first ? first.name : (entries[0] ? (entries[0].group ? `${entries[0].group}/${entries[0].name}` : entries[0].name) : null);
        });
      })
      .catch(() => { setAllBoards([]); setGroups([]); setSharedBoards([]); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetch("/api/preferences/board.selectedBoard", { credentials: "include" })
      .then((r) => r.json())
      .then((j: { value?: string | null }) => {
        if (j.value) {
          _setSelected(j.value);
          const parts = j.value.split("/");
          if (parts.length === 2 && !j.value.startsWith("shared:")) {
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
      payload?: { name?: string; ownerUserId?: string; boardRef?: string; sharedWithUserId?: string };
    }>("plugin_event", (ev) => {
      if (!ev.event) return;
      if (ev.event === "board:board_show") {
        const name = ev.payload?.name;
        if (typeof name === "string" && name) {
          setSelected(name);
          setSelectedShared(null);
          const parts = name.split("/");
          if (parts.length === 2) setSelectedGroup(parts[0]!);
          else setSelectedGroup(UNGROUPED);
          setIframeKey((k) => k + 1);
          fetchBoards();
        }
        return;
      }
      // Someone shared a board with us — refresh list
      if (ev.event === "board:board_shared") {
        fetchBoards();
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

  // Determine iframe src based on whether it's a shared board or own board
  const src = (() => {
    if (!selected) return "";
    if (selectedShared) {
      return `${API_BASE}/shared/${encodeURIComponent(selectedShared.ownerUserId)}/${encodeURIComponent(selectedShared.boardRef)}/index.html`;
    }
    return `${API_BASE}/boards/${encodeURIComponent(selected).replace(/%2F/g, "/")}/index.html`;
  })();

  const hasGroups = groups.length > 0;
  const hasShared = sharedBoards.length > 0;

  // Can the current board be shown in iframe?
  const canShowBoard = selected && !loading && (
    visibleBoards.some((b) => (b.group ? `${b.group}/${b.name}` : b.name) === selected)
    || selectedShared !== null
  );

  return (
    <div className={`relative flex flex-col overflow-hidden text-fg-default ${
      fullscreen
        ? "fixed inset-0 z-[9999] bg-bg-base"
        : "h-full"
    }`}>
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-surface px-3 py-1.5 relative z-10">
        {/* Group selector */}
        {(hasGroups || hasShared) && (
          <div className="relative">
            <select
              value={selectedGroup}
              onChange={(e) => {
                const g = e.target.value;
                setSelectedGroup(g);
                if (g === "__shared__") {
                  // Select first shared board
                  const first = sharedBoards[0];
                  if (first) {
                    const key = `shared:${first.ownerUserId}/${first.boardRef}`;
                    setSelected(key);
                    setSelectedShared(first);
                    setIframeKey((k) => k + 1);
                  }
                  return;
                }
                setSelectedShared(null);
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
              {hasShared && (
                <option value="__shared__">
                  共享给我 ({sharedBoards.length})
                </option>
              )}
            </select>
            <FolderOpen
              size={10}
              className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-fg-faint"
            />
          </div>
        )}

        {/* Board selector */}
        {selectedGroup === "__shared__" ? (
          sharedBoards.length > 0 ? (
            <div className="relative">
              <select
                value={selected ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setSelected(val);
                  const sb = sharedBoards.find(s => `shared:${s.ownerUserId}/${s.boardRef}` === val);
                  setSelectedShared(sb ?? null);
                  setIframeKey((k) => k + 1);
                }}
                className="appearance-none rounded-md bg-bg-raised pl-2.5 pr-6 py-1 text-xs font-medium text-fg-muted hover:bg-bg-hover focus:outline-none cursor-pointer transition-colors"
              >
                {sharedBoards.map((s) => {
                  const key = `shared:${s.ownerUserId}/${s.boardRef}`;
                  return (
                    <option key={key} value={key}>
                      {s.boardRef} (by {s.ownerUserId.slice(0, 8)})
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
            <span className="text-sm text-fg-faint">没有共享给你的看板</span>
          )
        ) : (
          visibleBoards.length > 0 ? (
            <div className="relative">
              <select
                value={selected ?? ""}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setSelectedShared(null);
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
          )
        )}

        {/* Spacer to push action buttons right */}
        <div className="ml-auto" />

        {/* Share button — only for own boards */}
        {selected && !selectedShared && (
          <button
            onClick={() => setShareDialogBoard(selected)}
            title="共享看板"
            className="rounded p-1 text-fg-faint hover:text-fg-default hover:bg-bg-hover transition-colors"
          >
            <Share2 size={12} />
          </button>
        )}

        {selected && (
          <button
            onClick={togglePin}
            title={isPinned ? "Unpin board" : "Pin board to message"}
            className={`rounded p-1 transition-colors ${
              isPinned ? "text-accent" : "text-fg-faint hover:text-fg-default hover:bg-bg-hover"
            }`}
          >
            <Pin size={12} />
          </button>
        )}
        <button
          onClick={reload}
          title={t("panel.refresh")}
          className="rounded p-1 text-fg-faint hover:text-fg-default hover:bg-bg-hover transition-colors"
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

      {canShowBoard ? (
        <iframe
          key={iframeKey}
          ref={iframeRef}
          src={src}
          title={selected ?? "board"}
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

      {/* Share dialog */}
      {shareDialogBoard && (
        <ShareDialog
          boardRef={shareDialogBoard}
          onClose={() => setShareDialogBoard(null)}
        />
      )}
    </div>
  );
}

const exports: PluginClientExports = {
  components: { BoardPanel },
};

export default exports;
