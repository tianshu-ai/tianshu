import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, User } from "lucide-react";
import type { WireMessage } from "../types/chat";

/**
 * Single message bubble. Visually echoes the closed-source predecessor:
 *   - small role badge ABOVE the bubble (icon + label)
 *   - markdown body inside, GFM tables / code
 *   - assistant: neutral dark; user: brand-tinted, right-aligned
 *   - streaming bubble shows a soft caret while content is empty
 */
export default function MessageBubble({ m }: { m: WireMessage }) {
  const isUser = m.role === "user";

  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div className={`flex max-w-[85%] flex-col ${isUser ? "items-end" : "items-start"}`}>
        <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-gray-500">
          {isUser ? <User size={11} /> : <Bot size={11} className="text-blue-400" />}
          <span>{isUser ? "you" : "tianshu"}</span>
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
            <span className="inline-block h-4 w-1 animate-pulse bg-gray-500 align-middle" />
          )}
        </div>
      </div>
    </div>
  );
}
