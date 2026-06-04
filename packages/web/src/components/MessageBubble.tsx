import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, CheckCircle2, User, Wrench, XCircle } from "lucide-react";
import type { WireMessage, WireToolCall, WireToolResult } from "../types/chat";

/**
 * Single message bubble.
 *
 * Three flavours:
 *  - role=user        → right-aligned brand-tinted card
 *  - role=tool        → narrow tool-result chip with status icon
 *  - role=assistant   → markdown body + (if tool calls) chips below
 */
export default function MessageBubble({ m }: { m: WireMessage }) {
  if (m.role === "tool") {
    return <ToolResultRow result={m.toolResult} />;
  }

  const isUser = m.role === "user";
  const hasText = m.text.length > 0;
  const hasCalls = (m.toolCalls?.length ?? 0) > 0;

  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div className={`flex max-w-[85%] flex-col ${isUser ? "items-end" : "items-start"}`}>
        <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-gray-500">
          {isUser ? <User size={11} /> : <Bot size={11} className="text-blue-400" />}
          <span>{isUser ? "you" : "tianshu"}</span>
        </div>

        {/* Text body — only render if there's something to show. A tool-
            only assistant turn (text === "" + toolCalls) skips the bubble
            and shows just the chips below. */}
        {hasText && (
          <div
            className={
              "prose prose-invert prose-sm max-w-none rounded-lg border px-3.5 py-2.5 text-[14px] leading-relaxed " +
              (isUser
                ? "border-brand-400/30 bg-brand-500/10 text-gray-100"
                : "border-gray-800 bg-gray-900/60 text-gray-100")
            }
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
          </div>
        )}

        {!hasText && !isUser && !hasCalls && (
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 px-3.5 py-2.5">
            <span className="inline-block h-4 w-1 animate-pulse bg-gray-500 align-middle" />
          </div>
        )}

        {hasCalls && (
          <div className={`mt-1.5 flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
            {m.toolCalls!.map((c) => (
              <ToolCallChip key={c.id} call={c} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCallChip({ call }: { call: WireToolCall }) {
  return (
    <div className="inline-flex max-w-full items-start gap-1.5 rounded-md border border-gray-800 bg-gray-900/40 px-2 py-1 text-[11px] text-gray-400">
      <Wrench size={11} className="mt-0.5 flex-shrink-0 text-blue-400" />
      <code className="text-blue-300">{call.name}</code>
      <span className="truncate text-gray-500">{summariseArgs(call.arguments)}</span>
    </div>
  );
}

function ToolResultRow({ result }: { result: WireToolResult | undefined }) {
  if (!result) return null;
  return (
    <div className="flex justify-start">
      <div className="ml-5 flex max-w-[85%] items-start gap-1.5 rounded-md border border-gray-800 bg-gray-900/40 px-2 py-1 text-[11px]">
        {result.ok ? (
          <CheckCircle2 size={11} className="mt-0.5 flex-shrink-0 text-emerald-400" />
        ) : (
          <XCircle size={11} className="mt-0.5 flex-shrink-0 text-rose-400" />
        )}
        <code className="text-blue-300">{result.name}</code>
        <span
          className={
            "whitespace-pre-wrap break-all text-gray-400 " +
            (result.ok ? "" : "text-rose-300")
          }
        >
          {truncate(result.text, 240)}
        </span>
      </div>
    </div>
  );
}

function summariseArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "()";
  // Tiny inline summary: key1=value1, key2=value2
  return keys
    .slice(0, 3)
    .map((k) => `${k}=${shortValue(args[k])}`)
    .join(", ");
}

function shortValue(v: unknown): string {
  if (typeof v === "string") return v.length > 40 ? `"${v.slice(0, 37)}…"` : `"${v}"`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v == null) return String(v);
  return JSON.stringify(v).slice(0, 40);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
