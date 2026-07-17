// Board plugin — side panel.
//
// Lists the user's boards (board/<name>/index.html) and renders the
// selected one in a sandboxed iframe served by the plugin route
// GET /api/p/board/boards/<name>/index.html.
//
// This is the browse-anytime surface; the agent can also drop a board
// into the chat via the show_board tool (rendered by the shared MCP-UI
// iframe path). Refreshes its list on workspace changes.

import { useCallback, useEffect, useRef, useState } from "react";
import { Globe, ChevronDown, RefreshCw } from "lucide-react";
import type { PanelProps, PluginClientExports } from "@tianshu-ai/plugin-sdk/client";
import { subscribeToWsEvent, sendWsMessage } from "@tianshu-ai/plugin-sdk/client";

const API_BASE = "/api/p/board";

function BoardPanel(_props: PanelProps) {
  const [boards, setBoards] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const fetchBoards = useCallback(() => {
    fetch(`${API_BASE}/boards`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((res: { boards: string[] }) => {
        const list = res.boards ?? [];
        // Auto-switch to a newly-created board: compare against the
        // previous list and, if exactly-new names appeared, select the
        // (last) new one. Otherwise keep the current selection if it
        // still exists, else fall back to the first board.
        setBoards((prev) => {
          const added = list.filter((b) => !prev.includes(b));
          setSelected((cur) => {
            if (added.length > 0) return added[added.length - 1];
            if (cur && list.includes(cur)) return cur;
            return list[0] ?? null;
          });
          return list;
        });
      })
      .catch(() => setBoards([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchBoards();
    // A `files`-plugin workspace change (new/edited board files) or a
    // host-side board broadcast should refresh the list. We listen for
    // the generic plugin_event and re-fetch on anything board-ish.
    return subscribeToWsEvent<{ type: string; event?: string }>(
      "plugin_event",
      (ev) => {
        if (ev.event && /board|workspace/i.test(ev.event)) {
          // Refresh the list AND reload the iframe: a board's own
          // index.html may have changed, so bump the key to re-fetch
          // the rendered content, not just the board names.
          fetchBoards();
          setIframeKey((k) => k + 1);
        }
      },
    );
  }, [fetchBoards]);

  // board_act bridge (browser side).
  //   server broadcasts `board:board_act_request` { reqId, op }
  //     -> postMessage the op into the board iframe
  //   iframe runtime replies `tianshu:board_act_response` { reqId, ok, data?, error? }
  //     -> send it back up to the host as ws `board_act_response`
  useEffect(() => {
    const offReq = subscribeToWsEvent<{
      type: string;
      event?: string;
      payload?: { reqId?: string; op?: unknown };
    }>("plugin_event", (ev) => {
      if (ev.event !== "board:board_act_request") return;
      const reqId = ev.payload?.reqId;
      const op = ev.payload?.op;
      const win = iframeRef.current?.contentWindow;
      if (!reqId) return;
      if (!win) {
        sendWsMessage({
          type: "board_act_response",
          reqId,
          ok: false,
          error: "No board is open in the Boards panel.",
        });
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
    ? `${API_BASE}/boards/${encodeURIComponent(selected)}/index.html`
    : "";

  return (
    <div className="flex h-full flex-col overflow-hidden text-fg-default">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-1.5">
        {boards.length > 0 ? (
          <div className="relative">
            <select
              value={selected ?? ""}
              onChange={(e) => {
                setSelected(e.target.value);
                setIframeKey((k) => k + 1);
              }}
              className="appearance-none rounded-md bg-bg-raised pl-2.5 pr-6 py-1 text-xs font-medium text-fg-muted hover:bg-bg-hover focus:outline-none cursor-pointer transition-colors"
            >
              {boards.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <ChevronDown
              size={12}
              className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-faint"
            />
          </div>
        ) : (
          <span className="text-xs text-fg-faint">No boards</span>
        )}
        <button
          onClick={reload}
          title="Refresh"
          className="ml-auto rounded p-1 text-fg-faint hover:text-fg-default hover:bg-bg-hover transition-colors"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {selected ? (
        <iframe
          key={iframeKey}
          ref={iframeRef}
          src={src}
          title={selected}
          sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
          className="w-full flex-1 border-0 bg-white"
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center text-fg-fainter">
          <Globe size={28} className="mb-2 opacity-30" />
          <span className="text-xs">
            {loading ? "Loading…" : "No boards"}
          </span>
          <span className="mt-1 text-[10px] text-fg-fainter">
            Add one at board/&lt;name&gt;/index.html
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
