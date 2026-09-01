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
  Bell,
  Bot,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Repeat,
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
import { useT } from "../hooks/useT";



// Memoised: with ChatArea's `useMemo(mergeToolTurns)` the merged
// message objects keep a stable identity across renders unless their
// underlying row actually changed. So during streaming only the ONE
// message whose text is growing re-renders; the other N-1 completed
// bubbles (each of which re-parses markdown + may highlight code) are
// skipped. Default shallow prop compare on `{ m }` is exactly right
// here because `m` is the only prop and its identity is meaningful.
/** Derive event card type from structured inbox event data. */
interface SystemEvent {
  type: "cron" | "recovery" | "system_upgrade" | "system_note";
  title: string;
  body: string;
  firedAt?: string;
  scheduleType?: string;
}

function deriveEventType(e: { kind: string; source?: string }): SystemEvent["type"] {
  if (e.source === "cron") return "cron";
  if (e.kind === "inbox_recovery_note") return "recovery";
  return "system_note";
}

function MessageBubbleImpl({ m }: { m: MergedMessage }) {
  const isUser = m.role === "user";
  const { MarkdownBlock } = useUiPrimitives();
  const isDark = useThemeStore((s) => s.resolved === "dark");  // classical resolves as light-family
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

  // Detect structured inbox events (backend-tagged)
  const inboxEvents = (m as unknown as Record<string, unknown>).inboxEvents as
    | Array<{ kind: string; source?: string; title?: string; firedAt?: string; scheduleType?: string; text: string }>
    | undefined;
  const hasEvents = inboxEvents && inboxEvents.length > 0;
  // Also detect [system note] prefix for upgrade messages (no inbox events)
  const isSystemUpgrade = isUser && m.text.startsWith("[system note]");

  // Event messages render centered with event icon, not as "YOU"
  const isEvent = hasEvents || isSystemUpgrade;

  return (
    <div className={isEvent ? "flex justify-end" : isUser ? "flex justify-end" : "flex justify-start"}>
      <div className={`flex max-w-[85%] min-w-0 flex-col ${isEvent ? "items-end" : isUser ? "items-end" : "items-start"}`}>
        {!isEvent && (
          <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-fg-faint">
            {isUser ? <User size={11} /> : <img src="/classical/tianshu-avatar.png" alt="" className="h-5 w-5 rounded-full object-cover" />}
            <span>{isUser ? "you" : "tianshu"}</span>
          </div>
        )}

        {hasEvents ? (
          <div className="flex flex-col gap-1.5">
            {inboxEvents!.map((e, i) => (
              <EventCard
                key={i}
                event={{
                  type: deriveEventType(e),
                  title: e.title || (e.source === "cron" ? "Scheduled Event" : "Notification"),
                  body: stripSystemPrefix(e.text),
                  firedAt: e.firedAt,
                  scheduleType: e.scheduleType,
                }}
              />
            ))}
          </div>
        ) : isSystemUpgrade ? (
          <EventCard
            event={{
              type: "system_upgrade",
              title: "System Update",
              body: m.text.replace(/^\[system note\]\s*/, ""),
            }}
          />
        ) : blocks ? (
          blocks.some(
            (b) => b.kind === "toolCall" && (b.result?.ui?.length ?? 0) > 0,
          ) ? (
            // Unified card: when the turn contains an interactive UI,
            // wrap ALL of its blocks (the UI, the narration text, the
            // tool detail) in ONE bordered container with hairline
            // separators, so the iframe and the agent's message read as
            // a single block instead of stacked, separately-bordered
            // bubbles.
            <div className="w-full max-w-2xl overflow-hidden rounded-lg border border-border-subtle bg-bg-elevated/60 divide-y divide-border-subtle/60 ai-bubble">
              {blocks.map((b, i) =>
                renderAssistantBlock(b, i, isUser, MarkdownBlock, proseInvert, true),
              )}
            </div>
          ) : (
            <div className={`flex w-full min-w-0 flex-col gap-1.5 ${isUser ? "items-end" : "items-start"}`}>
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
                  `prose${proseInvert} prose-sm w-full overflow-x-auto rounded-lg border px-3.5 py-2.5 text-[14px] leading-relaxed ` +
                  (isUser
                    ? "border-brand-400/30 bg-brand-500/10 text-fg-default"
                    : "border-border-subtle bg-bg-elevated/60 text-fg-default ai-bubble")
                }
              >
                <MarkdownBlock noProse>{m.text}</MarkdownBlock>
              </div>
            ) : showStreamingPlaceholder ? (
              <div className="rounded-lg border border-border-subtle bg-bg-elevated/60 px-3.5 py-2.5 ai-bubble">
                <TypingDots />
              </div>
            ) : null}

            {calls.length > 0 && (
              <div className={`mt-1.5 flex w-full min-w-0 flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
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
          className={`prose${proseInvert} prose-sm w-full overflow-x-auto px-3.5 py-2.5 text-[14px] leading-relaxed text-fg-default`}
        >
          <MarkdownBlock noProse>{block.text}</MarkdownBlock>
        </div>
      );
    }
    return (
      <div
        key={`t${i}`}
        className={
          `prose${proseInvert} prose-sm w-full overflow-x-auto rounded-lg border px-3.5 py-2.5 text-[14px] leading-relaxed ` +
          (isUser
            ? "border-brand-400/30 bg-brand-500/10 text-fg-default"
            : "border-border-subtle bg-bg-elevated/60 text-fg-default ai-bubble")
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
  const screenshots = (result?.text ?? "").match(SCREENSHOT_RE) ?? [];
  const hasScreenshots = screenshots.length > 0;

  // Screenshots render like MCP-UI: auto-visible, thin header + images.
  if (hasScreenshots && !hasUi) {
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
        <div className="px-3 pb-2 flex flex-wrap gap-2">
          {screenshots.map((p, i) => (
            <a
              key={i}
              href={`/api/p/reverse-mcp/screenshot?path=${encodeURIComponent(p)}`}
              target="_blank"
              rel="noopener"
            >
              <img
                src={`/api/p/reverse-mcp/screenshot?path=${encodeURIComponent(p)}`}
                alt={p}
                className="max-h-64 max-w-md rounded-md border border-border-subtle shadow-sm hover:shadow-md transition-shadow"
              />
            </a>
          ))}
        </div>
        {expanded && result && (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-[11px] text-fg-muted">
            {truncate(result.text, 4000)}
          </pre>
        )}
      </>
    );
    if (inCard) {
      return <div className="flex flex-col divide-y divide-border-subtle/60">{body}</div>;
    }
    return (
      <div className="flex flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-elevated/60 max-w-2xl divide-y divide-border-subtle/60 ai-bubble">
        {body}
      </div>
    );
  }

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
      <div className="flex flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-elevated/60 max-w-2xl divide-y divide-border-subtle/60 ai-bubble">
        {body}
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full min-w-0">
      <button
        type="button"
        onClick={() => !running && setExpanded((v) => !v)}
        className={
          "flex w-full min-w-0 select-none items-center gap-1.5 py-0.5 text-xs transition-colors overflow-hidden " +
          // Align with the card's other rows (text px-3.5, MCP-UI px-3)
          // when rendered inside a unified turn card; bare otherwise.
          (inCard ? "px-3 " : "") +
          (running ? "cursor-default text-fg-faint" : "cursor-pointer text-fg-faint hover:text-fg-muted")
        }
      >
        {running ? (
          <Loader2 size={11} className="shrink-0 animate-spin text-warning" />
        ) : isError ? (
          <XCircle size={11} className="shrink-0 text-rose-400/70" />
        ) : (
          <CheckCircle2 size={11} className="shrink-0 text-emerald-500/60" />
        )}
        <code className="shrink-0 font-mono text-[12px] text-link">{call.name}</code>
        <span className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-fg-fainter">
          {summariseArgs(call.arguments)}
        </span>
        {running ? (
          <span className="shrink-0 text-[11px] text-fg-fainter">running…</span>
        ) : expanded ? (
          <ChevronDown size={11} className="shrink-0 text-fg-fainter" />
        ) : (
          <ChevronRight size={11} className="shrink-0 text-fg-fainter" />
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

/** Regex matching bridge-screenshots paths in tool result text. */
const SCREENSHOT_RE = /bridge-screenshots\/[\w.-]+\.(?:png|jpg|jpeg|webp|gif)/g;

/** Strip the [System] Triggered at: ... prefix from cron text, keep only user message. */
function stripSystemPrefix(text: string): string {
  // Format: [System] Triggered at: <ts> | Job: "<title>" (<type>)\n\n<body>
  const m = text.match(/^\[System\] Triggered at:[^\n]*\n\n(.*)$/s);
  return m ? m[1].trim() : text;
}

/** Format UTC timestamp to friendly relative/absolute time. */
function formatEventTime(firedAt: string): string {
  try {
    const d = new Date(firedAt.replace(" ", "T").replace(" (UTC)", "Z"));
    if (isNaN(d.getTime())) return firedAt;
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60_000) return "Just now";
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return firedAt;
  }
}

/** Event card for system events (cron fires, recovery, upgrades, etc.) */
function EventCard({ event }: { event: SystemEvent }) {
  const styles = {
    cron: {
      border: "border-amber-500/30",
      bg: "bg-amber-500/5",
      headerBg: "bg-amber-500/10",
      headerBorder: "border-amber-500/20",
      iconBg: "bg-amber-500/20",
      iconColor: "text-amber-500",
      titleColor: "text-amber-600 dark:text-amber-400",
      badgeBg: "bg-amber-500/15",
      badgeColor: "text-amber-600 dark:text-amber-400",
    },
    recovery: {
      border: "border-rose-500/30",
      bg: "bg-rose-500/5",
      headerBg: "bg-rose-500/10",
      headerBorder: "border-rose-500/20",
      iconBg: "bg-rose-500/20",
      iconColor: "text-rose-500",
      titleColor: "text-rose-600 dark:text-rose-400",
      badgeBg: "bg-rose-500/15",
      badgeColor: "text-rose-600 dark:text-rose-400",
    },
    system_upgrade: {
      border: "border-sky-500/30",
      bg: "bg-sky-500/5",
      headerBg: "bg-sky-500/10",
      headerBorder: "border-sky-500/20",
      iconBg: "bg-sky-500/20",
      iconColor: "text-sky-500",
      titleColor: "text-sky-600 dark:text-sky-400",
      badgeBg: "bg-sky-500/15",
      badgeColor: "text-sky-600 dark:text-sky-400",
    },
    system_note: {
      border: "border-violet-500/30",
      bg: "bg-violet-500/5",
      headerBg: "bg-violet-500/10",
      headerBorder: "border-violet-500/20",
      iconBg: "bg-violet-500/20",
      iconColor: "text-violet-500",
      titleColor: "text-violet-600 dark:text-violet-400",
      badgeBg: "bg-violet-500/15",
      badgeColor: "text-violet-600 dark:text-violet-400",
    },
  };
  const s = styles[event.type];
  const isCron = event.type === "cron";

  const Icon = {
    cron: event.scheduleType?.startsWith("cron") ? Repeat : Bell,
    recovery: XCircle,
    system_upgrade: Bot,
    system_note: Bell,
  }[event.type];

  const badge = {
    cron: event.scheduleType?.startsWith("cron") ? "recurring" : "one-time",
    recovery: "recovery",
    system_upgrade: "upgrade",
    system_note: "notification",
  }[event.type];

  return (
    <div className={`max-w-lg overflow-hidden rounded-lg border ${s.border} ${s.bg}`}>
      <div className={`flex items-center gap-2 border-b ${s.headerBorder} ${s.headerBg} px-3.5 py-2`}>
        <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${s.iconBg}`}>
          <Icon size={13} className={s.iconColor} />
        </div>
        <span className={`text-[13px] font-semibold ${s.titleColor} truncate`}>
          {event.title}
        </span>
        <span className={`ml-auto shrink-0 rounded-full ${s.badgeBg} px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${s.badgeColor}`}>
          {badge}
        </span>
      </div>
      <div className="px-3.5 py-2.5">
        {event.body && (
          <p className="mb-2 text-[13px] leading-relaxed text-fg-default">
            {event.body}
          </p>
        )}
        {event.firedAt && (
          <div className="flex items-center gap-1.5 text-[11px] text-fg-faint">
            <Calendar size={11} />
            <span>{formatEventTime(event.firedAt)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Three-dot typing indicator. Each dot phases the same animation
 *  by 150ms so it reads as "wave" rather than "blink". CSS sits
 *  inline so we don't need to touch tailwind.config or pull in a
 *  one-off keyframe just for this. */
function TypingDots() {
  const t = useT();
  return (
    <span
      className="inline-flex items-center gap-1"
      aria-label={t("chat.assistantTyping")}
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
