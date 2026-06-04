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
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  MergedMessage,
  MergedToolCall,
} from "../lib/merge-tool-turns";

export default function MessageBubble({ m }: { m: MergedMessage }) {
  const isUser = m.role === "user";
  const hasText = m.text.length > 0;
  const calls = m.resolvedToolCalls ?? [];

  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div className={`flex max-w-[85%] flex-col ${isUser ? "items-end" : "items-start"}`}>
        <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-gray-500">
          {isUser ? <User size={11} /> : <Bot size={11} className="text-blue-400" />}
          <span>{isUser ? "you" : "tianshu"}</span>
        </div>

        {/* Text body. Skip the bubble entirely for tool-only assistant
            turns (text is empty + only tool calls); the placeholder
            blink stays for the `streaming…` case (text empty AND no
            tool calls yet). */}
        {hasText ? (
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
        ) : !isUser && calls.length === 0 ? (
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 px-3.5 py-2.5">
            <span className="inline-block h-4 w-1 animate-pulse bg-gray-500 align-middle" />
          </div>
        ) : null}

        {calls.length > 0 && (
          <div className={`mt-1.5 flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
            {calls.map((c) => (
              <ToolCallRow key={c.id} call={c} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
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
