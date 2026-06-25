// Single message bubble.
//
// Visual model lifted from the closed-source predecessor:
//
//   - role=user      → right-aligned brand-tinted card, no chrome below
//   - role=assistant → left-aligned dark card; below it, one collapsible
//                      row PER tool call, default-collapsed, click to
//                      expand the tool result
//   - role=tool      → never reaches this component (mergeToolTurns
//                      attaches the result to its owning assistant turn)
//
// The collapsible row mirrors the closed-source `ToolCallBubble`:
// status icon (running / ok / error) → tool name → arg summary →
// chevron. Expanded body shows the tool's result text inside a
// monospace pre block.

import { useState } from "react";
import { useUiPrimitives } from "@tianshu-ai/plugin-sdk/client";
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  User,
  XCircle,
} from "lucide-react";
import type {
  MergedAssistantBlock,
  MergedMessage,
  MergedToolCall,
} from "../lib/merge-tool-turns";
import MessageAttachments from "./MessageAttachments";



export default function MessageBubble({ m }: { m: MergedMessage }) {
  const isUser = m.role === "user";
  // MarkdownBlock comes through the plugin-sdk UiPrimitives slot so
  // the chat bubble + the files preview + every other surface
  // render markdown identically.
  const { MarkdownBlock } = useUiPrimitives();

  // Prefer ordered `resolvedBlocks` (new wire shape, see
  // ws-protocol.ts). Fall back to flattened `text + resolvedToolCalls`
  // for tool/user/system rows and for legacy assistant rows that
  // don't carry blocks.
  const blocks = !isUser && m.resolvedBlocks && m.resolvedBlocks.length > 0
    ? m.resolvedBlocks
    : null;

  const hasText = m.text.length > 0;
  const calls = m.resolvedToolCalls ?? [];
  const showStreamingPlaceholder = !isUser && !hasText && calls.length === 0 && !blocks;

  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div className={`flex max-w-[85%] flex-col ${isUser ? "items-end" : "items-start"}`}>
        <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-gray-500">
          {isUser ? <User size={11} /> : <Bot size={11} className="text-blue-400" />}
          <span>{isUser ? "you" : "tianshu"}</span>
        </div>

        {blocks ? (
          <div className={`flex flex-col gap-1.5 ${isUser ? "items-end" : "items-start"}`}>
            {blocks.map((b, i) => renderAssistantBlock(b, i, isUser, MarkdownBlock))}
          </div>
        ) : (
          <>
            {hasText ? (
              <div
                className={
                  "prose prose-invert prose-sm max-w-none rounded-lg border px-3.5 py-2.5 text-[14px] leading-relaxed " +
                  (isUser
                    ? "border-brand-400/30 bg-brand-500/10 text-gray-100"
                    : "border-gray-800 bg-gray-900/60 text-gray-100")
                }
              >
                <MarkdownBlock noProse>{m.text}</MarkdownBlock>
              </div>
            ) : showStreamingPlaceholder ? (
              <div className="rounded-lg border border-gray-800 bg-gray-900/60 px-3.5 py-2.5">
                <TypingDots />
              </div>
            ) : null}

            {calls.length > 0 && (
              <div className={`mt-1.5 flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
                {calls.map((c) => (
                  <ToolCallRow key={c.id} call={c} />
                ))}
              </div>
            )}
          </>
        )}

        {isUser && m.attachments && m.attachments.length > 0 && (
          <MessageAttachments attachments={m.attachments} align="end" />
        )}

        {!isUser && (m.meta || m.createdAt) && (
          <MessageMeta
            meta={m.meta}
            createdAt={m.createdAt}
            align="start"
          />
        )}
      </div>
    </div>
  );
}

function renderAssistantBlock(
  block: MergedAssistantBlock,
  i: number,
  isUser: boolean,
  MarkdownBlock: React.ComponentType<{ children: string; noProse?: boolean }>,
): React.ReactNode {
  if (block.kind === "text") {
    if (block.text.length === 0) return null;
    return (
      <div
        key={`t${i}`}
        className={
          "prose prose-invert prose-sm max-w-none rounded-lg border px-3.5 py-2.5 text-[14px] leading-relaxed " +
          (isUser
            ? "border-brand-400/30 bg-brand-500/10 text-gray-100"
            : "border-gray-800 bg-gray-900/60 text-gray-100")
        }
      >
        <MarkdownBlock noProse>{block.text}</MarkdownBlock>
      </div>
    );
  }
  // toolCall block: reuse the same chip the legacy path renders.
  return <ToolCallRow key={`c${i}-${block.id}`} call={block} />;
}

function MessageMeta({
  meta,
  createdAt,
  align,
}: {
  meta?: MergedMessage["meta"];
  createdAt: number;
  align: "start" | "end";
}) {
  const parts: React.ReactNode[] = [];

  if (createdAt) parts.push(formatTime(createdAt));
  if (meta?.model) parts.push(meta.model);
  if (meta?.usage) {
    const { input, output, totalTokens } = meta.usage;
    parts.push(`↓${formatTokens(input)} ↑${formatTokens(output)}`);
    if (meta.contextWindow && meta.contextWindow > 0) {
      const pct = Math.round((totalTokens / meta.contextWindow) * 100);
      parts.push(`${pct}% ctx`);
    }
  }
  if (parts.length === 0) return null;

  const justify = align === "end" ? "justify-end" : "justify-start";
  return (
    <div
      className={`mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-gray-600 ${justify}`}
    >
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-gray-700">·</span>}
          {p}
        </span>
      ))}
    </div>
  );
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "m";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function ToolCallRow({ call }: { call: MergedToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const running = !call.result;
  const isError = !!call.result && !call.result.ok;
  const result = call.result;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => !running && setExpanded((v) => !v)}
        className={
          "flex select-none items-center gap-1.5 py-0.5 text-xs transition-colors " +
          (running ? "cursor-default text-gray-500" : "cursor-pointer text-gray-500 hover:text-gray-300")
        }
      >
        {running ? (
          <Loader2 size={11} className="animate-spin text-amber-400" />
        ) : isError ? (
          <XCircle size={11} className="text-rose-400/70" />
        ) : (
          <CheckCircle2 size={11} className="text-emerald-500/60" />
        )}
        <code className="font-mono text-[12px] text-blue-300">{call.name}</code>
        <span className="font-mono text-[11px] text-gray-600">{summariseArgs(call.arguments)}</span>
        {running ? (
          <span className="text-[11px] text-gray-600">running…</span>
        ) : expanded ? (
          <ChevronDown size={11} className="text-gray-600" />
        ) : (
          <ChevronRight size={11} className="text-gray-600" />
        )}
      </button>

      {expanded && result && (
        <pre
          className={
            "mt-1 max-h-64 max-w-2xl overflow-auto whitespace-pre-wrap break-all rounded-md border px-3 py-2 text-[11px] " +
            (isError
              ? "border-rose-700/40 bg-rose-950/30 text-rose-200"
              : "border-gray-800/60 bg-gray-900/60 text-gray-300")
          }
        >
          {truncate(result.text, 4000)}
        </pre>
      )}
    </div>
  );
}

function summariseArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "()";
  return keys
    .slice(0, 3)
    .map((k) => `${k}=${shortValue(args[k])}`)
    .join(" ");
}

function shortValue(v: unknown): string {
  if (typeof v === "string") return v.length > 40 ? `"${v.slice(0, 37)}…"` : `"${v}"`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v == null) return String(v);
  return JSON.stringify(v).slice(0, 40);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\n…(truncated)";
}

/** Three-dot typing indicator. Each dot phases the same animation
 *  by 150ms so it reads as "wave" rather than "blink". CSS sits
 *  inline so we don't need to touch tailwind.config or pull in a
 *  one-off keyframe just for this. */
function TypingDots() {
  return (
    <span
      className="inline-flex items-center gap-1"
      aria-label="assistant is typing"
    >
      <Dot delay="0ms" />
      <Dot delay="150ms" />
      <Dot delay="300ms" />
    </span>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full bg-gray-500"
      style={{
        animation: "tianshuTypingDot 1.2s ease-in-out infinite",
        animationDelay: delay,
      }}
    />
  );
}
