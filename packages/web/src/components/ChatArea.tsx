import { useEffect, useRef } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import MessageBubble from "./MessageBubble";
import ChatInput from "./ChatInput";

/**
 * Main column: top bar + scrolling messages + composer.
 * Layout mirrors the closed-source repo's ChatArea so the look is
 * familiar; right-side panels (files / browser / board / …) ship later.
 */
export default function ChatArea() {
  const messages = useChatStore((s) => s.messages);
  const me = useChatStore((s) => s.me);
  const sidebarOpen = useChatStore((s) => s.sidebarOpen);
  const toggleSidebar = useChatStore((s) => s.toggleSidebar);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamError = useChatStore((s) => s.streamError);
  const clearStreamError = useChatStore((s) => s.clearStreamError);

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const brand = me?.config.branding;
  const brandName = brand?.name ?? "Tianshu";
  const modelName = me?.defaultModel?.name ?? "—";

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      {/* Top bar */}
      <header className="flex h-12 items-center justify-between border-b border-gray-800 bg-gray-900/50 px-4 backdrop-blur">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={toggleSidebar}
            className="btn-ghost p-1.5"
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          >
            {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
          <h1 className="text-sm font-medium text-gray-300">
            天枢 · {brandName}
          </h1>
          <span className="text-[11px] text-gray-500">
            tenant <span className="text-gray-300">{me?.tenantId ?? "…"}</span> · user{" "}
            <span className="text-gray-300">{me?.userId ?? "…"}</span>
          </span>
        </div>
        <div className="text-[11px] text-gray-500">
          model <span className="text-gray-300">{modelName}</span>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          {messages.length === 0 && (
            <EmptyState
              brandName={brandName}
              tenantId={me?.tenantId ?? "default"}
            />
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} m={m} />
          ))}
          {isStreaming && (
            <div className="text-[11px] text-gray-500">streaming…</div>
          )}
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
          <div ref={bottomRef} />
        </div>
      </div>

      <ChatInput />
    </main>
  );
}

function EmptyState({
  brandName,
  tenantId,
}: {
  brandName: string;
  tenantId: string;
}) {
  return (
    <div className="mx-auto mt-12 max-w-xl rounded-lg border border-gray-800 bg-gray-900/40 p-5 text-sm text-gray-400">
      <h2 className="mb-2 text-base font-semibold text-gray-100">
        Day 0 chat — say something to {brandName}.
      </h2>
      <p className="leading-relaxed">
        This conversation is your single endless thread. Messages persist
        per-tenant in <code className="mx-0.5 rounded bg-gray-800 px-1 py-0.5 text-xs text-gray-300">~/.tianshu/tenants/{tenantId}/db.sqlite</code>.
        Tools, files, the right-hand panels, and worker dispatch arrive
        in later PRs.
      </p>
    </div>
  );
}
