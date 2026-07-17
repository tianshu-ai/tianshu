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

import { memo, useState } from "react";
import { useUiPrimitives } from "@tianshu-ai/plugin-sdk/client";
import { useThemeStore } from "../stores/theme-store";
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
import McpUiFrame from "./McpUiFrame";



// Memoised: with ChatArea's `useMemo(mergeToolTurns)` the merged
// message objects keep a stable identity across renders unless their
// underlying row actually changed. So during streaming only the ONE
// message whose text is growing re-renders; the other N-1 completed
// bubbles (each of which re-parses markdown + may highlight code) are
// skipped. Default shallow prop compare on `{ m }` is exactly right
// here because `m` is the only prop and its identity is meaningful.
function MessageBubbleImpl({ m }: { m: MergedMessage }) {
  const isUser = m.role === "user";
  // MarkdownBlock comes through the plugin-sdk UiPrimitives slot so
  // the chat bubble + the files preview + every other surface
  // render markdown identically.
  const { MarkdownBlock } = useUiPrimitives();
  // `prose-invert` flips Typography colors for dark backgrounds.
  // On light theme we DON'T want it: bubbles are white, text
  // needs to read dark. Switch class on theme.
  const isDark = useThemeStore((s) => s.resolved === "dark");
  const proseInvert = isDark ? " prose-invert" : "";

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
        <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-fg-faint">
          {isUser ? <User size={11} /> : <Bot size={11} className="text-link" />}
          <span>{isUser ? "you" : "tianshu"}</span>
        </div>

        {blocks ? (
          blocks.some(
            (b) => b.kind === "toolCall" && (b.result?.ui?.length ?? 0) > 0,
          ) ? (
            // Unified card: when the turn contains an interactive UI,
            // wrap ALL of its blocks (the UI, the narration text, the
            // tool detail) in ONE bordered container with hairline
            // separators, so the iframe and the agent's message read as
            // a single block instead of stacked, separately-bordered
            // bubbles.
            // Give the card an explicit target width (min of the
            // column and 42rem) instead of `w-full`: the ancestor
            // column is `items-start`, which shrink-wraps to content,
            // so a short narration like “已显示。” would otherwise squeeze
            // the card — and the iframe with it — into a narrow strip.
            <div className="w-[42rem] max-w-full overflow-hidden rounded-lg border border-border-subtle bg-bg-elevated/60 divide-y divide-border-subtle/60">
              {blocks.map((b, i) =>
                renderAssistantBlock(b, i, isUser, MarkdownBlock, proseInvert, true),
              )}
            </div>
          ) : (
            <div className={`flex flex-col gap-1.5 ${isUser ? "items-end" : "items-start"}`}>
              {blocks.map((b, i) =>
                renderAssistantBlock(b, i, isUser, MarkdownBlock, proseInvert),
              )}
            </div>
          )
        ) : (
          <>
            {hasText ? (
              <div
                className={
                  `prose${proseInvert} prose-sm max-w-none rounded-lg border px-3.5 py-2.5 text-[14px] leading-relaxed ` +
                  (isUser
                    ? "border-brand-400/30 bg-brand-500/10 text-fg-default"
                    : "border-border-subtle bg-bg-elevated/60 text-fg-default")
                }
              >
                <MarkdownBlock noProse>{m.text}</MarkdownBlock>
              </div>
            ) : showStreamingPlaceholder ? (
              <div className="rounded-lg border border-border-subtle bg-bg-elevated/60 px-3.5 py-2.5">
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

const MessageBubble = memo(MessageBubbleImpl);
export default MessageBubble;

function renderAssistantBlock(
  block: MergedAssistantBlock,
  i: number,
  isUser: boolean,
  MarkdownBlock: React.ComponentType<{ children: string; noProse?: boolean }>,
  proseInvert: string,
  inCard = false,
): React.ReactNode {
  if (block.kind === "text") {
    if (block.text.length === 0) return null;
    // inCard: the surrounding unified card provides the border/bg, so
    // this text block is just a padded prose segment (no own frame).
    if (inCard) {
      return (
        <div
          key={`t${i}`}
          className={`prose${proseInvert} prose-sm max-w-none px-3.5 py-2.5 text-[14px] leading-relaxed text-fg-default`}
        >
          <MarkdownBlock noProse>{block.text}</MarkdownBlock>
        </div>
      );
    }
    return (
      <div
        key={`t${i}`}
        className={
          `prose${proseInvert} prose-sm max-w-none rounded-lg border px-3.5 py-2.5 text-[14px] leading-relaxed ` +
          (isUser
            ? "border-brand-400/30 bg-brand-500/10 text-fg-default"
            : "border-border-subtle bg-bg-elevated/60 text-fg-default")
        }
      >
        <MarkdownBlock noProse>{block.text}</MarkdownBlock>
      </div>
    );
  }
  // toolCall block: reuse the same chip the legacy path renders.
  return <ToolCallRow key={`c${i}-${block.id}`} call={block} inCard={inCard} />;
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
      className={`mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-fg-fainter ${justify}`}
    >
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-fg-fainter">·</span>}
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

function ToolCallRow({ call, inCard = false }: { call: MergedToolCall; inCard?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const running = !call.result;
  const isError = !!call.result && !call.result.ok;
  const result = call.result;
  const uiResources = result?.ui ?? [];
  const hasUi = uiResources.length > 0;

  // A tool that returned MCP-UI renders as a self-contained card: a
  // thin header row (status + tool name, click to reveal the raw text
  // result) with the interactive iframe(s) directly below, all inside
  // one bordered container. This reads as a single unit and sits
  // naturally next to the agent's narration block in the same turn,
  // instead of a bare chip detached from a separate iframe.
  if (hasUi) {
    // Header + optional raw-text detail + iframe(s). When inCard, the
    // surrounding unified turn card provides the outer border/bg + the
    // hairline separators (divide-y), so we render as bare sections.
    const body = (
      <>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full select-none items-center gap-1.5 px-3 py-1.5 text-xs text-fg-faint hover:text-fg-muted transition-colors"
        >
          {isError ? (
            <XCircle size={11} className="text-rose-400/70" />
          ) : (
            <CheckCircle2 size={11} className="text-emerald-500/60" />
          )}
          <code className="font-mono text-[12px] text-link">{call.name}</code>
          <span className="ml-auto text-[10px] text-fg-fainter">
            {expanded ? "hide details" : "details"}
          </span>
        </button>
        {expanded && result && (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-[11px] text-fg-muted">
            {truncate(result.text, 4000)}
          </pre>
        )}
        {uiResources.map((u, i) => (
          <McpUiFrame key={`${call.id}-ui-${i}`} ui={u} />
        ))}
      </>
    );
    if (inCard) {
      // Bare: outer card + divide-y draw the frame/separators.
      return <div className="flex flex-col divide-y divide-border-subtle/60">{body}</div>;
    }
    return (
      <div className="flex w-[42rem] max-w-full flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-elevated/60 divide-y divide-border-subtle/60">
        {body}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => !running && setExpanded((v) => !v)}
        className={
          "flex select-none items-center gap-1.5 py-0.5 text-xs transition-colors " +
          (running ? "cursor-default text-fg-faint" : "cursor-pointer text-fg-faint hover:text-fg-muted")
        }
      >
        {running ? (
          <Loader2 size={11} className="animate-spin text-warning" />
        ) : isError ? (
          <XCircle size={11} className="text-rose-400/70" />
        ) : (
          <CheckCircle2 size={11} className="text-emerald-500/60" />
        )}
        <code className="font-mono text-[12px] text-link">{call.name}</code>
        <span className="font-mono text-[11px] text-fg-fainter">{summariseArgs(call.arguments)}</span>
        {running ? (
          <span className="text-[11px] text-fg-fainter">running…</span>
        ) : expanded ? (
          <ChevronDown size={11} className="text-fg-fainter" />
        ) : (
          <ChevronRight size={11} className="text-fg-fainter" />
        )}
      </button>

      {expanded && result && (
        <pre
          className={
            "mt-1 max-h-64 max-w-2xl overflow-auto whitespace-pre-wrap break-all rounded-md border px-3 py-2 text-[11px] " +
            (isError
              ? "border-rose-700/40 bg-rose-950/30 text-danger"
              : "border-border-subtle/60 bg-bg-elevated/60 text-fg-muted")
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
      className="inline-block h-1.5 w-1.5 rounded-full bg-fg-fainter"
      style={{
        animation: "tianshuTypingDot 1.2s ease-in-out infinite",
        animationDelay: delay,
      }}
    />
  );
}
