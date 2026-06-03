import { useEffect, useRef } from "react";
import {
  PanelLeftClose,
  PanelLeftOpen,
  SquarePen,
  FolderOpen,
  Monitor,
  LayoutDashboard,
  Calendar,
  BarChart3,
} from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import MessageBubble from "./MessageBubble";
import ChatInput from "./ChatInput";

/**
 * Main column. Layout mirrors the closed-source predecessor's ChatArea:
 *   - h-12 top bar with sidebar toggle on the left and a row of panel
 *     toggles + "new session" on the right (placeholders for now)
 *   - centered welcome state with brand-tinted icon
 *   - scrolling message list constrained to max-w-3xl mx-auto
 *   - composer at the bottom
 *
 * Right-side panels (files / browser / task board / calendar / usage)
 * arrive in later PRs; here they render as disabled icon buttons so the
 * chrome looks complete without being misleading.
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
  const brandEmoji = brand?.emoji ?? "⭐";
  const modelName = me?.defaultModel?.name ?? "—";
  const empty = messages.length === 0;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      {/* Top bar */}
      <header className="flex h-12 items-center justify-between border-b border-gray-800 bg-gray-900/50 px-4 backdrop-blur">
        <div className="flex items-center">
          <button
            type="button"
            onClick={toggleSidebar}
            className="btn-ghost p-1.5"
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          >
            {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
          <h1 className="ml-3 text-sm font-medium text-gray-300">main</h1>
          <span className="ml-3 text-[11px] text-gray-500">
            tenant <span className="text-gray-300">{me?.tenantId ?? "…"}</span> · user{" "}
            <span className="text-gray-300">{me?.userId ?? "…"}</span>
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-2 text-[11px] text-gray-500">
            model <span className="text-gray-300">{modelName}</span>
          </span>
          <PanelToggle title="New session (later PR)" disabled>
            <SquarePen size={16} />
          </PanelToggle>
          <PanelToggle title="Browser view (later PR)" disabled>
            <Monitor size={16} />
          </PanelToggle>
          <PanelToggle title="Workspace files (later PR)" disabled>
            <FolderOpen size={16} />
          </PanelToggle>
          <PanelToggle title="Task board (later PR)" disabled>
            <LayoutDashboard size={16} />
          </PanelToggle>
          <PanelToggle title="Scheduled jobs (later PR)" disabled>
            <Calendar size={16} />
          </PanelToggle>
          <PanelToggle title="Usage (later PR)" disabled>
            <BarChart3 size={16} />
          </PanelToggle>
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
            {messages.map((m, i) => (
              <div key={m.id} className={i === 0 ? "" : "mt-4"}>
                <MessageBubble m={m} />
              </div>
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
        )}
      </div>

      <ChatInput />
    </main>
  );
}

function PanelToggle({
  children,
  title,
  disabled,
  active,
}: {
  children: React.ReactNode;
  title: string;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      className={
        "rounded-lg p-1.5 transition-colors " +
        (active
          ? "bg-gray-700 text-white"
          : "text-gray-400 hover:bg-gray-800 hover:text-gray-200 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400")
      }
    >
      {children}
    </button>
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
      <h2 className="mb-2 text-xl font-semibold text-gray-200">
        Welcome to {brandName}
      </h2>
      <p className="max-w-md text-sm text-gray-500">
        An open AI agent platform with a sidecar browser. Day 0: messages
        persist per-tenant in{" "}
        <code className="mx-0.5 rounded bg-gray-800 px-1 py-0.5 text-xs text-gray-400">
          ~/.tianshu/tenants/{tenantId}/db.sqlite
        </code>
        . Tools, workspace files, browser, and worker dispatch arrive in
        later PRs.
      </p>
    </div>
  );
}
