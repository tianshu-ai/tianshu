import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, User } from "lucide-react";
import type { WireMessage } from "../types/chat";

/**
 * Renders a single chat message. Visually echoes the closed-source repo:
 * - role badge (icon + label) above the bubble
 * - markdown body inside, with GFM tables / code
 * - assistant bubble = neutral dark; user bubble = brand-tinted right-aligned
 */
export default function MessageBubble({ m }: { m: WireMessage }) {
  const isUser = m.role === "user";
  const isAssistant = m.role === "assistant";

  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div className={`flex max-w-[85%] flex-col ${isUser ? "items-end" : "items-start"}`}>
        <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-gray-500">
          {isUser ? <User size={11} /> : <Bot size={11} />}
          <span>{isUser ? "you" : isAssistant ? "tianshu" : m.role}</span>
        </div>
        <div
          className={
            "prose prose-invert prose-sm max-w-none rounded-lg border px-3.5 py-2.5 text-[14px] leading-relaxed " +
            (isUser
              ? "border-brand-400/30 bg-brand-500/10 text-gray-100"
              : "border-gray-800 bg-gray-900/60 text-gray-100")
          }
        >
          {m.content ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
          ) : (
            <span className="text-gray-500">…</span>
          )}
        </div>
      </div>
    </div>
  );
}
