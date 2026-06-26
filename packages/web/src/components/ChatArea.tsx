import { useEffect, useRef, useState } from "react";
import { PanelLeftClose, PanelLeftOpen, Puzzle } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import MessageBubble from "./MessageBubble";
import { mergeToolTurns } from "../lib/merge-tool-turns";
import ChatInput from "./ChatInput";
import PluginManager from "./PluginManager";
import PluginTopBarButtons from "./PluginTopBarButtons";

/**
 * Main column.
 *
 *   - h-12 top bar with sidebar toggle on the left, identity strip in
 *     the middle
 *   - scrolling message list (max-w-3xl)
 *   - composer at the bottom
 *
 * The top bar's right side is **manifest-driven**: each active
 * plugin's `contributes.topBarButtons` becomes a button here, and
 * clicking one toggles the matching `rightPanels` entry in the
 * column rendered by ChatLayout. The Plugin Manager itself is part
 * of the bundled chat shell (per ADR-0003) and stays put.
 */
export default function ChatArea() {
  const messages = useChatStore((s) => s.messages);
  const me = useChatStore((s) => s.me);
  const sidebarOpen = useChatStore((s) => s.sidebarOpen);
  const toggleSidebar = useChatStore((s) => s.toggleSidebar);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamError = useChatStore((s) => s.streamError);
  const clearStreamError = useChatStore((s) => s.clearStreamError);
  const compactNotice = useChatStore((s) => s.compactNotice);
  const clearCompactNotice = useChatStore((s) => s.clearCompactNotice);
  const hasMoreHistory = useChatStore((s) => s.hasMoreHistory);
  const loadingMore = useChatStore((s) => s.loadingMore);
  const loadEarlier = useChatStore((s) => s.loadEarlier);

  const bottomRef = useRef<HTMLDivElement>(null);
  // Track the previous last-message id so we can tell "new tail
  // arrived" (auto-scroll) apart from "older page prepended"
  // (do nothing — the user just clicked Load earlier and would
  // be confused if we yanked them back to the bottom).
  const prevLastIdRef = useRef<string | null>(null);
  useEffect(() => {
    const lastId = messages.length > 0 ? messages[messages.length - 1].id : null;
    if (lastId && lastId !== prevLastIdRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevLastIdRef.current = lastId;
  }, [messages]);

  const [pluginManagerOpen, setPluginManagerOpen] = useState(false);

  const brand = me?.config.branding;
  const brandName = brand?.name ?? "Tianshu";
  const brandEmoji = brand?.emoji ?? "⭐";
  const empty = messages.length === 0;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      {/* Top bar */}
      <header className="flex h-12 items-center justify-between border-b border-border-subtle bg-gray-900/50 px-4 backdrop-blur">
        <div className="flex items-center">
          <button
            type="button"
            onClick={toggleSidebar}
            className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg-default"
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          >
            {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
          <h1 className="ml-3 text-sm font-medium text-fg-muted">main</h1>
          <span className="ml-3 text-[11px] text-fg-faint">
            tenant <span className="text-fg-muted">{me?.tenantId ?? "…"}</span> · user{" "}
            <span className="text-fg-muted">{me?.userId ?? "…"}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <PluginTopBarButtons />
          <button
            type="button"
            onClick={() => setPluginManagerOpen(true)}
            className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg-default"
            title="Plugin Manager"
            aria-label="Open Plugin Manager"
          >
            <Puzzle size={16} />
          </button>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        {empty ? (
          <EmptyState
            brandName={brandName}
            brandEmoji={brandEmoji}
            tenantId={me?.tenantId ?? "default"}
          />
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
            {hasMoreHistory && (
              // "Load earlier" button at the top of the transcript.
              // Server-paginated: clicking sends `history_more` with
              // the oldest current message id as cursor; the
              // returned page is prepended in chat-store.
              <button
                type="button"
                onClick={loadEarlier}
                disabled={loadingMore}
                className="w-full rounded-lg bg-gray-800/50 py-2 text-xs text-fg-faint hover:text-fg-muted disabled:cursor-default disabled:opacity-60"
              >
                {loadingMore ? "Loading…" : "Load earlier messages"}
              </button>
            )}
            {mergeToolTurns(messages).map((m, i) => (
              <div key={m.id} className={i === 0 ? "" : "mt-4"}>
                <MessageBubble m={m} />
              </div>
            ))}
            {/* No "streaming…" label here — the streaming bubble
             *  itself shows incoming text or a typing indicator,
             *  which is visual enough. */}
            {streamError && (
              <div className="flex items-center justify-between rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-sm text-rose-300">
                <span className="truncate">{streamError}</span>
                <button
                  type="button"
                  onClick={clearStreamError}
                  className="ml-3 text-[11px] uppercase tracking-wider text-rose-300/80 hover:text-white"
                >
                  dismiss
                </button>
              </div>
            )}
            {compactNotice && (
              <div className="flex items-center justify-between rounded-md border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
                <span className="truncate">
                  📌 Conversation history compacted (
                  {compactNotice.reason === "auto" ? "auto" : "manual"}):{" "}
                  {compactNotice.summarisedCount} earlier messages summarised,{" "}
                  {compactNotice.keptCount} kept verbatim.
                </span>
                <button
                  type="button"
                  onClick={clearCompactNotice}
                  className="ml-3 text-[11px] uppercase tracking-wider text-amber-300/80 hover:text-white"
                >
                  dismiss
                </button>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <ChatInput />

      <PluginManager
        open={pluginManagerOpen}
        onClose={() => setPluginManagerOpen(false)}
      />
    </main>
  );
}

function EmptyState({
  brandName,
  brandEmoji,
  tenantId,
}: {
  brandName: string;
  brandEmoji: string;
  tenantId: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-600/20">
        <span className="text-2xl">{brandEmoji}</span>
      </div>
      <h2 className="mb-2 text-xl font-semibold text-fg-default">
        Welcome to {brandName}
      </h2>
      <p className="max-w-md text-sm text-fg-faint">
        An open AI agent platform with a sidecar browser. Day 0: messages
        persist per-tenant in{" "}
        <code className="mx-0.5 rounded bg-bg-raised px-1 py-0.5 text-xs text-fg-muted">
          ~/.tianshu/tenants/{tenantId}/db.sqlite
        </code>
        . Tools, workspace files, browser, and worker dispatch arrive in
        later PRs.
      </p>
    </div>
  );
}
