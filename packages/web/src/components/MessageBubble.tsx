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

import { memo, useCallback, useMemo, useState } from "react";
import { useUiPrimitives, useDateLocale } from "@tianshu-ai/plugin-sdk/client";
import { useThemeStore } from "../stores/theme-store";
import {
  Bell,
  Bot,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Loader2,
  Pause,
  Play,
  Repeat,
  User,
  Wrench,
  XCircle,
} from "lucide-react";
import { useVoiceStore } from "../stores/voice-store";
import { spokenTextFor } from "../hooks/useAutoSpeakReplies";
import { ClickableImage } from "./ui/ImageLightbox";
import type {
  MergedAssistantBlock,
  MergedMessage,
  MergedToolCall,
} from "../lib/merge-tool-turns";
import MessageAttachments from "./MessageAttachments";
import McpUiFrame from "./McpUiFrame";
import { humanizeArgs, humanizeToolCall, humanizeToolGroup, inferRender, normalizeBridgeName, shortToolName, extractFileContent, extractFileResultContent, extToLang, type T } from "../lib/humanize-tool";
import { translate, type TranslationKey } from "../lib/i18n";
import { getToolDisplay, type ResolvedToolDisplay } from "../lib/tool-display";
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
          <div className="mb-1 flex items-center gap-1.5 text-xs uppercase tracking-wider text-fg-faint">
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
            <div className="w-full max-w-2xl overflow-visible rounded-xl bg-bg-elevated/40 divide-y divide-border-subtle/40 ai-bubble">
              {blocks.map((b, i) =>
                renderAssistantBlock(b, i, isUser, MarkdownBlock, proseInvert, true),
              )}
            </div>
          ) : (
            <GroupedBlocks
              blocks={blocks}
              isUser={isUser}
              MarkdownBlock={MarkdownBlock}
              proseInvert={proseInvert}
            />
          )
        ) : (
          <>
            {hasText ? (
              <div className={`relative ${isUser ? 'user-bubble' : 'ai-bubble'}`}>
                <div
                  className={
                    `prose${proseInvert} prose-sm w-full overflow-x-auto rounded-xl px-4 py-3 text-[14px] leading-relaxed ` +
                    (isUser
                      ? "bg-brand-500/10 text-fg-default"
                      : "bg-bg-elevated/40 text-fg-default")
                  }
                >
                  <MarkdownBlock noProse>{m.text}</MarkdownBlock>
                </div>
              </div>
            ) : showStreamingPlaceholder ? (
              <div className="rounded-xl bg-bg-elevated/40 px-4 py-3 ai-bubble">
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

        {(() => {
          if (isUser) return null;
          // speechSource comes from mergeToolTurns and preserves the
          // ORIGINAL text INCLUDING any <voice_summary> tag — the
          // visible fields (m.text, blocks[].text) have the tag
          // stripped for clean rendering, but the audio pipeline
          // needs the tag to extract the spoken-friendly summary.
          // Falls back to m.text for legacy rows without speechSource
          // set (e.g. history that predates the speechSource field).
          const speechText = m.speechSource ?? m.text ?? "";
          const hasFooterContent = m.meta || m.createdAt || speechText;
          if (!hasFooterContent) return null;
          return (
            <div className="mt-1 flex items-center gap-2">
              {speechText && (
                <SpeakButton messageId={m.id} text={speechText} />
              )}
              <CopyMessageButton text={m.text} />
              {(m.meta || m.createdAt) && (
                <MessageMeta
                  meta={m.meta}
                  createdAt={m.createdAt}
                  align="start"
                />
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

/**
 * Per-message speak/pause control for assistant bubbles.
 *
 * Yu, 2026-09-19 21:40: "在每个 tianshu 消息里放个播放按钮，可以
 * 主动播放，但是同时只能播一个". Global voice store
 * enforces the single-active rule — pressing play on message B
 * while A is playing simply supersedes A. UI reflects that by
 * showing Pause on the message currently playing (playingId ===
 * m.id) and Play on all others.
 *
 * Text-to-speech pipeline: spokenTextFor() from useAutoSpeakReplies
 * prefers the <voice_summary>...</voice_summary> content when tianshu
 * generated one under voice mode, falling back to markdown-stripped
 * whole reply otherwise. Shared with the auto-speak hook so manual
 * and auto playback read the same slice of the message.
 */
function SpeakButton({ messageId, text }: { messageId: string; text: string }) {
  const playing = useVoiceStore((s) => s.playingId === messageId);
  const play = useVoiceStore((s) => s.play);
  const stop = useVoiceStore((s) => s.stop);

  const handleClick = () => {
    if (playing) {
      stop();
      return;
    }
    const spoken = spokenTextFor(text);
    if (!spoken) return;
    // play() reads TTS provider/voice from the voice store's
    // cached preferences — no need to pass them here.
    play({ id: messageId, text: spoken }).catch(() => {});
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={
        "inline-flex h-6 w-6 items-center justify-center rounded-full transition-colors " +
        (playing
          ? "bg-accent-fill text-accent-fg"
          : "text-fg-faint hover:bg-bg-raised hover:text-fg-muted")
      }
      title={playing ? "停止播放" : "播放语音"}
      aria-label={playing ? "Stop playback" : "Play voice"}
      aria-pressed={playing}
    >
      {playing ? <Pause size={12} /> : <Play size={12} />}
    </button>
  );
}

/** Copy entire assistant message text to clipboard. */
function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => {});
      }}
      className={
        "inline-flex h-6 w-6 items-center justify-center rounded-full transition-colors " +
        (copied
          ? "text-green-500"
          : "text-fg-faint hover:bg-bg-raised hover:text-fg-muted")
      }
      title={copied ? "已复制" : "复制消息"}
      aria-label={copied ? "Copied" : "Copy message"}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
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
      <div key={`t${i}`} className={`relative ${isUser ? 'user-bubble' : 'ai-bubble'}`}>
        <div
          className={
            `prose${proseInvert} prose-sm w-full overflow-x-auto rounded-xl px-4 py-3 text-[14px] leading-relaxed ` +
            (isUser
              ? "bg-brand-500/10 text-fg-default"
              : "bg-bg-elevated/40 text-fg-default")
          }
        >
          <MarkdownBlock noProse>{block.text}</MarkdownBlock>
        </div>
      </div>
    );
  }
  // turnBoundary: invisible marker, skip rendering
  if (block.kind === "turnBoundary") return null;
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
      className={`mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-fainter ${justify}`}
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
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const running = !call.result;
  const isError = !!call.result && !call.result.ok;
  const result = call.result;
  const uiResources = result?.ui ?? [];
  const hasUi = uiResources.length > 0;
  // Screenshot paths in result — only render for tools that actually produce screenshots.
  // Many tools (solution, sync_up, tenant_config_read, etc.) mention screenshot paths
  // as data references in their JSON output, not as actual displayable images.
  const normalized = normalizeBridgeName(call.name);
  const isScreenshotProducer = /exec$|shell_exec|browser_screenshot|browser_health_check|bridge_view_image/i.test(normalized);
  const screenshots = isScreenshotProducer ? ((result?.text ?? "").match(SCREENSHOT_RE) ?? []) : [];
  const hasScreenshots = screenshots.length > 0;
  // Extract only the filename group so URL construction stays simple.
  const generatedImageFilenames: string[] = [];
  {
    const txt = result?.text ?? "";
    let m: RegExpExecArray | null;
    const re = new RegExp(GENERATED_IMAGE_RE.source, "g");
    while ((m = re.exec(txt)) !== null) {
      if (m[1]) generatedImageFilenames.push(m[1]);
    }
  }
  const hasGeneratedImages = generatedImageFilenames.length > 0;

  // Generated images render like screenshots: auto-visible, thin header + images.
  if (hasGeneratedImages && !hasUi) {
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
          <code className="font-mono text-xs text-link">{call.name}</code>
          <span className="ml-auto text-xs text-fg-fainter">
            {expanded ? "hide details" : "details"}
          </span>
        </button>
        <div className="px-3 pb-2 flex flex-wrap gap-2">
          {generatedImageFilenames.map((fname, i) => (
            <ClickableImage
              key={i}
              src={`/api/generated-images/${encodeURIComponent(fname)}`}
              alt={fname}
              imgClassName="max-h-96 max-w-md rounded-md border border-border-subtle shadow-sm hover:shadow-md transition-shadow"
            />
          ))}
        </div>
        {expanded && result && (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-xs text-fg-muted">
            {formatResultText(result.text, undefined, t)}
          </pre>
        )}
      </>
    );
    if (inCard) {
      return <div className="flex flex-col divide-y divide-border-subtle/60">{body}</div>;
    }
    return (
      <div className="flex flex-col overflow-visible rounded-xl bg-bg-elevated/40 max-w-2xl divide-y divide-border-subtle/40 ai-bubble">
        {body}
      </div>
    );
  }

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
          <code className="font-mono text-xs text-link">{call.name}</code>
          <span className="ml-auto text-xs text-fg-fainter">
            {expanded ? "hide details" : "details"}
          </span>
        </button>
        <div className="px-3 pb-2 flex flex-wrap gap-2">
          {screenshots.map((p, i) => (
            <ClickableImage
              key={i}
              src={`/api/p/reverse-mcp/screenshot?path=${encodeURIComponent(p)}`}
              alt={p}
            />
          ))}
        </div>
        {expanded && result && (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-xs text-fg-muted">
            {formatResultText(result.text, undefined, t)}
          </pre>
        )}
      </>
    );
    if (inCard) {
      return <div className="flex flex-col divide-y divide-border-subtle/60">{body}</div>;
    }
    return (
      <div className="flex flex-col overflow-visible rounded-xl bg-bg-elevated/40 max-w-2xl divide-y divide-border-subtle/40 ai-bubble">
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
          <code className="font-mono text-xs text-link">{call.name}</code>
          <span className="ml-auto text-xs text-fg-fainter">
            {expanded ? "hide details" : "details"}
          </span>
        </button>
        {expanded && result && (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-xs text-fg-muted">
            {formatResultText(result.text, undefined, t)}
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
      <div className="flex flex-col overflow-visible rounded-xl bg-bg-elevated/40 max-w-2xl divide-y divide-border-subtle/40 ai-bubble">
        {body}
      </div>
    );
  }

  // ── Default tool call: card style ──
  const statusIcon = running ? (
    <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
  ) : isError ? (
    <XCircle size={13} className="shrink-0 text-rose-400" />
  ) : (
    <CheckCircle2 size={13} className="shrink-0 text-emerald-500/80" />
  );

  const statusLabel = running
    ? "running…"
    : isError
      ? "failed"
      : undefined;

  return (
    <div className={`flex flex-col w-full min-w-0 ${
      inCard ? "" : "my-0.5"
    }`}>
      <button
        type="button"
        onClick={() => !running && setExpanded((v) => !v)}
        className={
          "group flex w-full min-w-0 select-none items-center gap-2 rounded-xl px-3 py-2 text-xs transition-all " +
          (running
            ? "cursor-default bg-bg-surface"
            : isError
              ? "cursor-pointer bg-rose-950/60 hover:bg-rose-950/80"
              : "cursor-pointer bg-bg-surface hover:bg-bg-hover")
        }
      >
        {statusIcon}
        <span className="shrink-0 text-xs font-medium text-fg-default">
          {humanizeToolCall(call.name, call.arguments, t) || call.name}
        </span>
        <span className="min-w-0 flex-1 truncate text-left font-mono text-[10px] text-fg-fainter" title={call.name}>
          {call.name}
        </span>
        {statusLabel && (
          <span className={`shrink-0 text-xs ${
            isError ? "text-rose-400" : "text-accent"
          }`}>{statusLabel}</span>
        )}
        {!running && (
          expanded ? (
            <ChevronDown size={12} className="shrink-0 text-fg-fainter group-hover:text-fg-muted transition-colors" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-fg-fainter group-hover:text-fg-muted transition-colors" />
          )
        )}
      </button>

      {expanded && result && (
        <ToolCallDetail call={call} failed={isError} />
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

/**
 * Format tool call arguments for display. Extracts the meaningful
 * fields and skips internal metadata like _title.
 */
/** Format a single argument value — arrays expanded as bulleted lists of objects. */
function formatArgValue(key: string, v: unknown): string {
  if (typeof v === "string") {
    return v.length > 400 ? `${key}: ${v.slice(0, 397)}…` : `${key}: ${v}`;
  }
  // Array of objects — expand each as a sub-block
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null) {
    const header = `${key}: (${v.length} ×)`;
    const blocks = v.map((item, i) => {
      const obj = item as Record<string, unknown>;
      const fields = Object.entries(obj)
        .filter(([k]) => !k.startsWith("_"))
        .map(([k, val]) => {
          if (typeof val === "string") {
            return val.length > 300 ? `    ${k}: ${val.slice(0, 297)}…` : `    ${k}: ${val}`;
          }
          if (val === null || val === undefined) return `    ${k}: —`;
          const s = JSON.stringify(val);
          return s.length > 200 ? `    ${k}: ${s.slice(0, 197)}…` : `    ${k}: ${s}`;
        })
        .join("\n");
      return `  [${i + 1}]\n${fields}`;
    });
    return [header, ...blocks].join("\n");
  }
  // Array of primitives
  if (Array.isArray(v)) {
    if (v.length <= 5) return `${key}: ${JSON.stringify(v)}`;
    return `${key}: (${v.length} items)\n` + v.slice(0, 5).map((x) => `  • ${JSON.stringify(x)}`).join("\n") + `\n  …`;
  }
  const s = JSON.stringify(v);
  return s.length > 400 ? `${key}: ${s.slice(0, 397)}…` : `${key}: ${s}`;
}

function formatArgsText(args: Record<string, unknown>, toolName?: string, t: T = translate, options?: { skipHumanize?: boolean }): string {
  // Try semantic humanization first — unless caller wants full expansion
  if (toolName && !options?.skipHumanize) {
    const h = humanizeArgs(toolName, args, t);
    if (h) return h;
  }
  const filtered = Object.entries(args).filter(([k]) => !k.startsWith("_"));
  if (filtered.length === 0) return "(no arguments)";
  // Single string arg (command, query, path, etc.) — show directly
  if (filtered.length === 1 && typeof filtered[0][1] === "string") {
    return `${filtered[0][0]}: ${filtered[0][1]}`;
  }
  return filtered.map(([k, v]) => formatArgValue(k, v)).join("\n");
}

/**
 * Format tool result text for display. Parses structured JSON results
 * (exec/bridge_exec) and extracts the meaningful content (stdout/stderr)
 * instead of showing raw JSON with ok/exit_code/truncated/etc metadata.
 */
function formatResultText(text: string, maxLen = 20000, t: T = translate): string {
  const trimmed = text.trim();
  // Strip common "ok:true, message:" / "ok:false, message:" prefix
  const msgMatch = trimmed.match(/^ok:\s*(?:true|false)\s*,\s*message:\s*"?(.*?)"?\s*$/s);
  if (msgMatch) return truncate(msgMatch[1], maxLen);
  if (!trimmed.startsWith("{")) return formatToon(text, maxLen, t);
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return truncate(text, maxLen);
    // Exec-style result: { ok, exit_code, stdout, stderr, ... }
    if ("stdout" in parsed || "stderr" in parsed) {
      const parts: string[] = [];
      const stdout = typeof parsed.stdout === "string" ? parsed.stdout.trim() : "";
      const stderr = typeof parsed.stderr === "string" ? parsed.stderr.trim() : "";
      if (stdout) parts.push(stdout);
      if (stderr) parts.push("stderr:\n" + stderr);
      if (parsed.exit_code !== undefined && parsed.exit_code !== 0) {
        parts.push(`exit code: ${parsed.exit_code}`);
      }
      if (parts.length > 0) return truncate(parts.join("\n\n"), maxLen);
      // All empty — show exit code only
      return `exit code: ${parsed.exit_code ?? 0}`;
    }
    // File operation result: { ok, path, bytes, base64? }
    if ("path" in parsed && "bytes" in parsed) {
      const p = typeof parsed.path === "string" ? parsed.path : "";
      const b = typeof parsed.bytes === "number" ? parsed.bytes : 0;
      const fname = p.split("/").pop() || p;
      // Try to decode base64 text content for display
      if (typeof parsed.base64 === "string" && parsed.base64.length > 0 && b < 50000) {
        try {
          const raw = atob(parsed.base64);
          const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
          // Check if it looks like text (no control chars except newline/tab/cr)
          const hasBinary = bytes.some((b) => b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b));
          if (!hasBinary) {
            const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            return truncate(`${fname} (${b} bytes)\n\n${decoded}`, maxLen);
          }
        } catch { /* not valid base64 or not valid utf-8 */ }
      }
      // No decodable content — just show path + size
      return parsed.ok === false
        ? `Failed: ${fname}`
        : `${fname} (${b} bytes)`;
    }
    // Generic { ok, text } or { ok, message } result
    if ("text" in parsed && typeof parsed.text === "string") {
      return formatToon(parsed.text, maxLen, t);
    }
    if ("message" in parsed && typeof parsed.message === "string") {
      return formatToon(parsed.message, maxLen, t);
    }
    // { ok, data } — stringify data
    if ("data" in parsed && parsed.data != null) {
      const d = typeof parsed.data === "string" ? parsed.data : JSON.stringify(parsed.data, null, 2);
      return truncate(d, maxLen);
    }
    // Fallback: raw JSON
    return truncate(text, maxLen);
  } catch {
    // Not JSON — try TOON format: "key:value, key:value, ..." or multi-line TOON
    return formatToon(text, maxLen, t);
  }
}

/**
 * Format TOON (Token-Optimised Object Notation) text into readable key-value lines.
 * TOON: "key:value, key:value" or multi-line "key:value, key:value\nkey:value, ..."
 * Splits on ", " that look like field separators (not inside quoted strings).
 */
// Keys to hide from toon output — purely technical identifiers.
// Matches both exact names and any key ending with ".<name>" (nested paths).
const TOON_HIDDEN_KEYS = new Set([
  "slug", "id", "isCurrent", "kind", "type", "_id", "userId", "tenantId",
  "sessionId", "parentId", "leafId", "projectSlug",
  "schema", "tianshuVersion", "extractedAt", "extractedFrom",
  // Duplicate / low-value fields
  "origin", "editable",
]);

/** True if this toon path should be hidden (exact match or any segment is hidden). */
function isHiddenToonPath(key: string): boolean {
  const segments = key.split(".");
  // Hidden if last segment or any middle segment is hidden
  for (const seg of segments) {
    if (TOON_HIDDEN_KEYS.has(seg)) return true;
  }
  return false;
}

// Keys that have i18n labels (toonKey.* keys in i18n.ts)
const TOON_HUMANIZED_KEYS = new Set([
  "name", "description", "workerCount", "pluginCount",
  "isActive", "enabled", "status",
  "updatedAt", "createdAt", "endedAt",
  "title", "priority", "assignee", "column",
  "modelId", "source", "path", "bytes",
  "ok", "error", "message", "count",
]);

/** Humanize a toon key path. Takes the leaf name, humanizes if known. */
function humanizeToonKey(key: string, t: T): string {
  const leaf = key.split(".").pop() || key;
  if (TOON_HUMANIZED_KEYS.has(leaf)) return t((`toonKey.${leaf}`) as TranslationKey);
  return leaf;
}

/** Format a toon value for display. */
function humanizeToonValue(key: string, val: string, t: T): string {
  // Boolean
  if (val === "true") return t("toonVal.yes");
  if (val === "false") return t("toonVal.no");
  // Timestamps (unix ms > 1600000000000)
  if (/^\d{13}$/.test(val)) {
    try { return new Date(Number(val)).toLocaleString(); } catch { /* */ }
  }
  // Byte sizes
  if (key.toLowerCase().includes("byte") && /^\d+$/.test(val)) {
    const n = Number(val);
    if (n > 1048576) return `${(n / 1048576).toFixed(1)} MB`;
    if (n > 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
  }
  return val;
}

/** Format a comma-list value. If it has 3+ items, render as bulleted list. */
function formatToonList(key: string, val: string, t: T): string {
  const parts = val.split(/,\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 3) return humanizeToonValue(key, val, t);
  return "\n  • " + parts.join("\n  • ");
}

// Structured toon rendering types
type ToonNode =
  | { kind: "group"; label: string }
  | { kind: "field"; label: string; value: string; longText: boolean; indent: boolean }
  | { kind: "list"; label: string; items: string[]; indent: boolean }
  | { kind: "spacer" };

/** Parse toon text into structured nodes for React rendering. */
function parseToon(text: string, t: T): ToonNode[] | null {
  const trimmed = text.trim();
  const toonFieldCount = (trimmed.match(/(?:^|, )\w[\w.]*:/g) || []).length;
  if (toonFieldCount < 2) return null;

  const nodes: ToonNode[] = [];
  const lines = trimmed.split("\n").filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fields = line.split(/,\s+(?=\w[\w.]*:)/);
    let lastGroup = "";
    for (const f of fields) {
      const colonIdx = f.indexOf(":");
      if (colonIdx <= 0) continue;
      const key = f.slice(0, colonIdx).trim();
      const val = f.slice(colonIdx + 1).trim();
      if (isHiddenToonPath(key)) continue;
      const segments = key.split(".");
      const effective = segments[0] === "spec" ? segments.slice(1) : segments;
      if (effective.length === 0) continue;
      const label = humanizeToonKey(effective.join("."), t);
      const groupKey = effective.length > 1 ? effective[0] : "";
      if (groupKey && groupKey !== lastGroup) {
        if (lastGroup || nodes.length > 0) nodes.push({ kind: "spacer" });
        nodes.push({ kind: "group", label: humanizeToonKey(groupKey, t) });
        lastGroup = groupKey;
      } else if (!groupKey && lastGroup) {
        nodes.push({ kind: "spacer" });
        lastGroup = "";
      }
      // List value
      if (val.includes(",")) {
        const parts = val.split(/,\s+/).map((s) => s.trim()).filter(Boolean);
        if (parts.length >= 3) {
          nodes.push({ kind: "list", label, items: parts, indent: !!groupKey });
          continue;
        }
      }
      const humanVal = humanizeToonValue(key, val, t);
      // Long text if > 100 chars — will use ExpandableSnippet
      const longText = humanVal.length > 100;
      nodes.push({ kind: "field", label, value: humanVal, longText, indent: !!groupKey });
    }
    if (i < lines.length - 1) nodes.push({ kind: "spacer" });
  }
  return nodes;
}

/** React component to render structured toon nodes with ExpandableSnippet for long text. */
function ToonView({ nodes }: { nodes: ToonNode[] }) {
  return (
    <div className="text-[11px] font-mono text-fg-muted leading-relaxed">
      {nodes.map((n, i) => {
        if (n.kind === "spacer") return <div key={i} className="h-2" />;
        if (n.kind === "group") return <div key={i} className="text-fg-strong font-semibold mt-0.5">[{n.label}]</div>;
        if (n.kind === "field") {
          return (
            <div key={i} className={n.indent ? "pl-4" : ""}>
              <span className="text-fg-fainter">{n.label}: </span>
              {n.longText ? <ExpandableSnippet text={n.value} /> : <span className="whitespace-pre-wrap break-words">{n.value}</span>}
            </div>
          );
        }
        // list
        return (
          <div key={i} className={n.indent ? "pl-4" : ""}>
            <span className="text-fg-fainter">{n.label}:</span>
            <ExpandableList items={n.items} />
          </div>
        );
      })}
    </div>
  );
}

// ── File list rendering (list_dir, sync_up, sync_down) ─────────────────

type FileEntry = { name: string; bytes?: number; isDir?: boolean };

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

/** File type icon by extension. */
function fileIcon(name: string, isDir?: boolean): string {
  if (isDir || name.endsWith("/")) return "📁";
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const iconMap: Record<string, string> = {
    js: "📜", jsx: "⚛️", ts: "📜", tsx: "⚛️",
    py: "🐍", rb: "💎", rs: "🦀", go: "🐹",
    json: "📄", yaml: "📄", yml: "📄", toml: "📄",
    md: "📝", txt: "📃", csv: "📊", tsv: "📊",
    html: "🌐", xml: "📄", css: "🎨", scss: "🎨",
    png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", webp: "🖼️", svg: "🖼️",
    mp4: "🎬", mp3: "🎵", wav: "🎵",
    pdf: "📕", zip: "📦", tar: "📦", gz: "📦",
    sh: "⚡", bash: "⚡", zsh: "⚡",
  };
  return iconMap[ext] || "📄";
}

/** Clean a file path for display: strip workspace:/// prefix, keep readable name. */
function cleanFilePath(p: string): string {
  return p
    .replace(/^workspace:\/+/, "")
    .replace(/^file:\/+/, "")
    .replace(/^[/\\]+/, "");
}

/** Parse file list text (list_dir format or sync_up JSON). */
function parseFiles(text: string): FileEntry[] | null {
  const trimmed = text.trim();

  // Try JSON first (sync_up / bridge result)
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && Array.isArray(parsed.files)) {
        return parsed.files.map((f: unknown): FileEntry => {
          const obj = f as Record<string, unknown>;
          return {
            name: cleanFilePath(String(obj.path ?? obj.name ?? "")),
            bytes: typeof obj.bytes === "number" ? obj.bytes : (typeof obj.size === "number" ? obj.size : undefined),
          };
        }).filter((f: FileEntry) => f.name);
      }
    } catch { /* fall through */ }
  }

  // Try line-oriented format: "workspace:///xxx.yaml  (247 bytes)" or "filename.ext  128 bytes"
  const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
  const entries: FileEntry[] = [];
  for (const line of lines) {
    // Pattern: <path> (<N> bytes)   or   <path>  <N> bytes
    const m = line.match(/^(.+?)\s+\(?(\d+)\s+bytes\)?$/i);
    if (m) {
      entries.push({ name: cleanFilePath(m[1].trim()), bytes: Number(m[2]) });
      continue;
    }
    // Pattern: directory marker like "<path>/"
    const dirMatch = line.match(/^(.+?)\/\s*$/);
    if (dirMatch) {
      entries.push({ name: cleanFilePath(dirMatch[1]), isDir: true });
      continue;
    }
    // Just a path?
    if (/^[\w./\\:-]+$/.test(line)) {
      entries.push({ name: cleanFilePath(line) });
    }
  }
  return entries.length > 0 ? entries : null;
}

function FilesView({ text }: { text: string }) {
  const entries = parseFiles(text);
  if (!entries || entries.length === 0) {
    return <pre className="whitespace-pre-wrap break-all text-[11px] text-fg-muted font-mono">{text}</pre>;
  }
  // Sort: directories first, then by name
  const sorted = [...entries].sort((a, b) => {
    if (!!a.isDir !== !!b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const totalBytes = sorted.reduce((s, f) => s + (f.bytes || 0), 0);
  return (
    <div className="text-[11px] font-mono">
      <div className="text-fg-fainter text-[10px] mb-1">
        {sorted.length} {sorted.length === 1 ? "item" : "items"}{totalBytes > 0 ? ` · ${fmtBytes(totalBytes)}` : ""}
      </div>
      <div className="divide-y divide-border-subtle/40">
        {sorted.map((f, i) => (
          <div key={i} className="flex items-baseline gap-2 py-0.5">
            <span className="text-[12px] leading-none">{fileIcon(f.name, f.isDir)}</span>
            <span className="flex-1 text-fg-muted break-all">{f.name}</span>
            {f.bytes !== undefined && (
              <span className="text-fg-fainter text-[10px] tabular-nums shrink-0">{fmtBytes(f.bytes)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Recall tool rendering ─────────────────────────────────────────

type RecallEntry =
  | { kind: "turn"; n: number; role: "USER" | "ASSISTANT" | "TOOL" }
  | { kind: "text"; content: string }
  | { kind: "toolCall"; name: string; id: string; params: string[] };

function parseRecall(text: string): RecallEntry[] {
  const entries: RecallEntry[] = [];
  const lines = text.split("\n");
  let bufText: string[] = [];
  const flushText = () => {
    if (bufText.length === 0) return;
    const content = bufText.join("\n").trim();
    bufText = [];
    if (content) entries.push({ kind: "text", content });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Turn marker: ─── turn N: ROLE ───
    const turnMatch = line.match(/^─{3}\s*turn\s+(\d+):\s*(USER|ASSISTANT|TOOL)\s*─{3}/i);
    if (turnMatch) {
      flushText();
      entries.push({
        kind: "turn",
        n: Number(turnMatch[1]),
        role: turnMatch[2].toUpperCase() as "USER" | "ASSISTANT" | "TOOL",
      });
      i++;
      continue;
    }
    // Tool call: [toolCall name(id=xxx)] possibly followed by param lines
    const callMatch = line.match(/^\[toolCall\s+(\w+)\(id=([^)]+)\)\]\s*(.*)$/);
    if (callMatch) {
      flushText();
      const name = callMatch[1];
      const id = callMatch[2];
      const params: string[] = [];
      // First param (on same line after ])
      const firstParam = callMatch[3].trim();
      if (firstParam) params.push(firstParam);
      // Continuation param lines (until next [toolCall], turn marker, or blank gap)
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (/^─{3}/.test(next) || /^\[toolCall\s/.test(next)) break;
        const trimmed = next.trim();
        if (trimmed && /^\w[\w-]*:/.test(trimmed)) {
          params.push(trimmed);
          i++;
        } else {
          break;
        }
      }
      entries.push({ kind: "toolCall", name, id, params });
      continue;
    }
    bufText.push(line);
    i++;
  }
  flushText();
  return entries;
}

const RECALL_ROLE_STYLES: Record<"USER" | "ASSISTANT" | "TOOL", { label: string; icon: string; cls: string }> = {
  USER: { label: "User", icon: "👤", cls: "text-info bg-info/5 border-l-info/60" },
  ASSISTANT: { label: "Assistant", icon: "⭐", cls: "text-accent bg-accent/5 border-l-accent/60" },
  TOOL: { label: "Tool", icon: "🔧", cls: "text-fg-muted bg-bg-surface/40 border-l-border-strong/60" },
};

function RecallView({ text }: { text: string }) {
  const entries = parseRecall(text);
  if (entries.length === 0) return <pre className="whitespace-pre-wrap text-[11px] text-fg-muted">{text}</pre>;

  // Group entries by turn
  const turns: Array<{ n: number; role: "USER" | "ASSISTANT" | "TOOL"; body: RecallEntry[] }> = [];
  let current: typeof turns[0] | null = null;
  for (const e of entries) {
    if (e.kind === "turn") {
      current = { n: e.n, role: e.role, body: [] };
      turns.push(current);
    } else if (current) {
      current.body.push(e);
    }
  }

  return (
    <div className="space-y-2 text-[11px]">
      {turns.map((turn, i) => {
        const style = RECALL_ROLE_STYLES[turn.role];
        return (
          <div key={i} className={`border-l-2 pl-3 py-1 rounded-r ${style.cls}`}>
            <div className="flex items-center gap-2 text-fg-fainter mb-1 text-[10px] uppercase tracking-wide">
              <span>{style.icon}</span>
              <span className="font-semibold">Turn {turn.n} · {style.label}</span>
            </div>
            {turn.body.map((e, j) => {
              if (e.kind === "text") {
                const isLong = e.content.length > 300;
                return isLong
                  ? <ExpandableSnippet key={j} text={e.content} />
                  : <div key={j} className="whitespace-pre-wrap break-words text-fg-muted font-mono">{e.content}</div>;
              }
              if (e.kind === "toolCall") {
                return (
                  <div key={j} className="my-1 rounded bg-bg-surface/60 px-2 py-1 border border-border-subtle/40">
                    <div className="text-fg-strong text-[10px] font-semibold">
                      ⧉ {e.name}
                    </div>
                    {e.params.length > 0 && (
                      <div className="text-fg-fainter font-mono text-[10px] pl-3 mt-0.5">
                        {e.params.map((p, k) => <div key={k}>{p}</div>)}
                      </div>
                    )}
                  </div>
                );
              }
              return null;
            })}
          </div>
        );
      })}
    </div>
  );
}

function formatToon(text: string, maxLen: number, t: T = translate): string {
  // Kept as string for backward compat with non-React callers.
  // React callers should use parseToon + ToonView.
  void maxLen;
  const nodes = parseToon(text, t);
  if (!nodes) return text;
  return nodes.map((n) => {
    if (n.kind === "spacer") return "";
    if (n.kind === "group") return `[${n.label}]`;
    if (n.kind === "field") return (n.indent ? "  " : "") + `${n.label}: ${n.value}`;
    return (n.indent ? "  " : "") + `${n.label}:\n` + n.items.map((it) => `  • ${it}`).join("\n");
  }).join("\n");
}

// ── Search result parser ────────────────────────────────────────

interface SearchResultItem {
  title: string;
  url: string;
  domain: string;
  date?: string;
  snippet?: string;
}

/**
 * Parse web_search structured text output:
 *   "N results from brave for \"query\":\n\n1. Title\n   url (date)\n   snippet"
 * Also tries JSON with data.results array.
 */
function parseSearchResults(text: string): SearchResultItem[] {
  const trimmed = text.trim();

  // Try JSON first — result may have { data: { results: [...] } }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed?.data?.results && Array.isArray(parsed.data.results)) {
      return parsed.data.results.map((r: Record<string, unknown>) => ({
        title: String(r.title ?? ""),
        url: String(r.url ?? ""),
        domain: extractDomain(String(r.url ?? "")),
        date: r.publishedDate ? String(r.publishedDate).split("T")[0] : undefined,
        snippet: r.content ? stripSnippetNoise(String(r.content)) : undefined,
      }));
    }
  } catch { /* not JSON */ }

  // Parse the numbered text format:
  // 1. Title
  //    https://url (2026-10-06T...)
  //    Snippet text...
  const items: SearchResultItem[] = [];
  // Split on numbered entries: "1. ", "2. ", etc.
  const blocks = trimmed.split(/(?:^|\n)\d+\.\s+/).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const title = lines[0];
    // Second line should be URL (possibly with date in parens)
    let url = "";
    let date: string | undefined;
    let snippetStart = 1;
    if (lines.length > 1) {
      const urlLine = lines[1];
      const urlMatch = urlLine.match(/^(https?:\/\/\S+)/);
      if (urlMatch) {
        url = urlMatch[1];
        const dateMatch = urlLine.match(/\((\d{4}-\d{2}-\d{2})/); 
        if (dateMatch) date = dateMatch[1];
        snippetStart = 2;
      }
    }
    const snippet = stripSnippetNoise(lines.slice(snippetStart).join(" ")) || undefined;
    if (title && !title.match(/^\d+ results? from/)) {
      items.push({ title, url, domain: extractDomain(url), date, snippet });
    }
  }
  return items;
}

/** Strip markdown/HTML noise from search snippets. */
function stripSnippetNoise(s: string): string {
  return s
    // Remove markdown headings: # Title
    .replace(/^#+\s+/gm, "")
    // Remove markdown links: [text](url) → text
    .replace(/\[([^\]]*?)\]\(https?:\/\/[^)]+\)/g, "$1")
    // Remove bare ](url) fragments
    .replace(/\]\(https?:\/\/[^)]*\)/g, "")
    // Remove standalone URLs
    .replace(/https?:\/\/\S+/g, "")
    // Remove metadata prefixes: Author: ... Published: ... Source: ... Language: ..
    .replace(/\b(?:Author|Published|Source|Language):\s*\S+/g, "")
    // Collapse whitespace
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/** List with click-to-expand. Shows first 3 items by default when total > 5. */
function ExpandableList({ items, threshold = 5, preview = 3 }: { items: string[]; threshold?: number; preview?: number }) {
  const [expanded, setExpanded] = useState(false);
  const needsCollapse = items.length > threshold;
  const shown = needsCollapse && !expanded ? items.slice(0, preview) : items;
  const hidden = items.length - shown.length;
  return (
    <div className="pl-4">
      {shown.map((item, j) => (
        <div key={j}>• {item}</div>
      ))}
      {needsCollapse && (
        <div
          className="text-link text-[10px] cursor-pointer mt-0.5"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "…less" : `…more (${hidden})`}
        </div>
      )}
    </div>
  );
}

/** Snippet with click-to-expand. Shows 2 lines by default, full text on click. */
function ExpandableSnippet({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 120;
  return (
    <div
      className={"text-[11px] text-fg-fainter mt-0.5" + (isLong && !expanded ? " cursor-pointer" : "")}
      onClick={isLong ? () => setExpanded((v) => !v) : undefined}
    >
      <span className={!expanded && isLong ? "line-clamp-2" : ""}>{text}</span>
      {isLong && !expanded && <span className="text-link text-[10px] ml-1">…more</span>}
      {isLong && expanded && <span className="text-link text-[10px] ml-1 cursor-pointer">…less</span>}
    </div>
  );
}

/** Regex matching bridge-screenshots paths in tool result text. */
const SCREENSHOT_RE = /bridge-screenshots\/[\w.-]+\.(?:png|jpg|jpeg|webp|gif)/g;

/** Regex matching generated-images paths (from generate_image host tool). */
const GENERATED_IMAGE_RE = /generated-images\/([\w.-]+\.(?:png|jpg|jpeg|webp|gif))/g;

// ── Vertical ticker for collapsed tool-call summaries ──────────────



// ── Render-type-aware tool call detail view ─────────────────

// ── Config-driven input renderers ───────────────────────────────

/** Filter + relabel args according to the display config. */
function filterArgs(
  args: Record<string, unknown>,
  cfg?: ResolvedToolDisplay["input"],
): Record<string, unknown> {
  let entries = Object.entries(args).filter(([k]) => !k.startsWith("_"));
  if (cfg?.pick) {
    const pickSet = new Set(cfg.pick);
    entries = entries.filter(([k]) => pickSet.has(k));
  }
  if (cfg?.omit) {
    const omitSet = new Set(cfg.omit);
    entries = entries.filter(([k]) => !omitSet.has(k));
  }
  return Object.fromEntries(entries);
}

function formatKeyValueArgs(
  args: Record<string, unknown>,
  labels?: Record<string, string>,
): string {
  const entries = Object.entries(args).filter(([k]) => !k.startsWith("_"));
  if (entries.length === 0) return "(no arguments)";
  return entries
    .map(([k, v]) => {
      const label = labels?.[k] ?? k;
      const val = typeof v === "string" ? v : JSON.stringify(v);
      return `${label}: ${val.length > 200 ? val.slice(0, 197) + "…" : val}`;
    })
    .join("\n");
}

/** Extract a specific field from a JSON result string. */
function extractResultField(text: string, field: string): string {
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && typeof parsed === "object" && field in parsed) {
      const val = parsed[field];
      return typeof val === "string" ? val : JSON.stringify(val, null, 2);
    }
  } catch { /* fall through */ }
  return text;
}

/** Render input block according to display config. */
function ConfiguredInputRenderer({
  args,
  cfg,
  toolName,
}: {
  args: Record<string, unknown>;
  cfg: NonNullable<ResolvedToolDisplay["input"]>;
  toolName?: string;
}) {
  const t = useT();
  if (cfg.format === "hidden") return null;

  const filteredArgs = filterArgs(args, cfg);

  if (cfg.format === "terminal") {
    const cmd = typeof filteredArgs.command === "string" ? filteredArgs.command : formatArgsText(filteredArgs, toolName, t);
    return (
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[#0d0d0d] px-3 py-2 text-[11px] font-mono">
        <span className="text-[#98c379]">$ </span>
        <span className="text-[#e5c07b]">{cmd}</span>
      </pre>
    );
  }

  if (cfg.format === "sql") {
    // Show the SQL query prominently — extract from query/sql/cypher param
    const sqlParam = filteredArgs.query ?? filteredArgs.sql ?? filteredArgs.cypher ?? "";
    const sqlText = typeof sqlParam === "string" ? sqlParam : JSON.stringify(sqlParam);
    const otherArgs = Object.fromEntries(
      Object.entries(filteredArgs).filter(([k]) => k !== "query" && k !== "sql" && k !== "cypher"),
    );
    const hasOther = Object.keys(otherArgs).length > 0;
    return (
      <div className="flex flex-col gap-0.5">
        {hasOther && (
          <pre className="max-h-16 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-bg-surface/60 px-2 py-1 text-[11px] text-fg-fainter font-mono">
            {formatKeyValueArgs(otherArgs, cfg.labels)}
          </pre>
        )}
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[#0d0d0d] px-3 py-1.5 text-[11px] font-mono text-[#e5c07b]">
          {sqlText}
        </pre>
      </div>
    );
  }

  if (cfg.format === "code") {
    return (
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[#0d0d0d] px-3 py-1.5 text-[11px] font-mono text-[#abb2bf]">
        {formatArgsText(filteredArgs, toolName, t)}
      </pre>
    );
  }

  // "key-value" (default for config-driven)
  return (
    <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-bg-surface/60 px-2 py-1 text-[11px] text-fg-fainter font-mono">
      {formatKeyValueArgs(filteredArgs, cfg.labels)}
    </pre>
  );
}

/** Render output block according to display config. */
function ConfiguredOutputRenderer({
  text,
  failed,
  cfg,
}: {
  text: string;
  failed: boolean;
  cfg: NonNullable<ResolvedToolDisplay["output"]>;
}) {
  const t = useT();
  const displayText = cfg.extract ? extractResultField(text, cfg.extract) : formatResultText(text, undefined, t);

  if (cfg.format === "terminal") {
    return (
      <pre
        className={"max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg px-3 py-2 text-[11px] font-mono leading-relaxed " +
          (failed ? "bg-[#0d0d0d] text-[#e06c75]" : "bg-[#0d0d0d] text-[#abb2bf]")}
      >
        {displayText}
      </pre>
    );
  }

  if (cfg.format === "files") {
    return (
      <div className={"max-h-80 overflow-auto rounded-lg px-3 py-2 " +
        (failed ? "bg-rose-950/40" : "bg-bg-surface/60")}
      >
        <FilesView text={text} />
      </div>
    );
  }

  if (cfg.format === "markdown") {
    return (
      <div
        className={"max-h-64 overflow-auto rounded-lg px-3 py-2 text-xs prose prose-sm prose-invert max-w-none " +
          (failed ? "bg-rose-950/40" : "bg-bg-surface/60")}
        dangerouslySetInnerHTML={{ __html: displayText }}
      />
    );
  }

  if (cfg.format === "table") {
    // Try to parse as JSON with columns/rows structure
    try {
      const data = JSON.parse(text.trim());
      const rows: Record<string, unknown>[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.rows)
          ? data.rows
          : null;
      if (rows && rows.length > 0) {
        const columns = Array.isArray(data?.columns)
          ? (data.columns as string[])
          : Object.keys(rows[0] as object);
        return (
          <div className={"max-h-64 overflow-auto rounded-lg text-[11px] font-mono " +
            (failed ? "bg-rose-950/40" : "bg-bg-surface/60")}
          >
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border-subtle">
                  {columns.map((col) => (
                    <th key={col} className="px-2 py-1 text-left text-fg-muted font-medium">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 50).map((row, i) => (
                  <tr key={i} className="border-b border-border-subtle/50">
                    {columns.map((col) => {
                      const val = (row as Record<string, unknown>)[col];
                      const cellText = val == null ? "" : typeof val === "string" ? val : JSON.stringify(val);
                      return (
                        <td key={col} className="px-2 py-0.5 text-fg-fainter max-w-[200px] truncate" title={cellText}>
                          {cellText}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 50 && (
              <div className="px-2 py-1 text-fg-fainter text-[10px]">…{rows.length - 50} more rows</div>
            )}
          </div>
        );
      }
    } catch { /* fall through to plain */ }
    // Fallback to plain for unparseable results
    return (
      <pre className={"max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg px-2 py-1 text-[11px] font-mono " +
        (failed ? "bg-rose-950/40 text-danger" : "bg-bg-surface/60 text-fg-muted")}
      >
        {displayText}
      </pre>
    );
  }

  if (cfg.format === "json") {
    // Pretty-print JSON
    let pretty = displayText;
    try {
      pretty = JSON.stringify(JSON.parse(displayText.trim()), null, 2);
    } catch { /* keep raw */ }
    return (
      <pre className={"max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg px-2 py-1 text-[11px] font-mono " +
        (failed ? "bg-rose-950/40 text-danger" : "bg-[#0d0d0d] text-[#abb2bf]")}
      >
        {pretty}
      </pre>
    );
  }

  if (cfg.format === "code") {
    return (
      <pre className={"max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg px-3 py-1.5 text-[11px] font-mono " +
        (failed ? "bg-rose-950/40 text-danger" : "bg-[#0d0d0d] text-[#abb2bf]")}
      >
        {displayText}
      </pre>
    );
  }

  // "plain" (default)
  return (
    <pre className={"max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg px-2 py-1 text-[11px] font-mono " +
      (failed ? "bg-rose-950/40 text-danger" : "bg-bg-surface/60 text-fg-muted")}
    >
      {displayText}
    </pre>
  );
}

/** Renders a tool call's input + output based on plugin display config or inferRender(). */
function ToolCallDetail({ call, failed }: { call: MergedToolCall; failed: boolean }) {
  const t = useT();
  // Try plugin-declared display config first.
  const displayConfig = getToolDisplay(call.name);

  if (displayConfig) {
    const resultText = call.result ? call.result.text : "";
    // Full terminal mode: both input and output are terminal-style
    if (displayConfig.input?.format === "terminal" && displayConfig.output?.format === "terminal") {
      const cmd = typeof call.arguments.command === "string" ? call.arguments.command : undefined;
      const output = call.result ? formatResultText(call.result.text, undefined, t) : "";
      return (
        <div className="ml-5 mt-0.5 mb-1 rounded-lg overflow-hidden border border-[#333] shadow-sm">
          <div className="flex items-center gap-1.5 px-3 py-1 bg-[#1a1a1a]">
            <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
            <span className="ml-2 text-[10px] text-[#888] font-mono">terminal</span>
          </div>
          <pre className={"max-h-64 overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-[11px] font-mono leading-relaxed " +
            (failed ? "bg-[#0d0d0d] text-[#e06c75]" : "bg-[#0d0d0d] text-[#abb2bf]")}
          >
            {cmd && <><span className="text-[#98c379]">$ </span><span className="text-[#e5c07b]">{cmd}</span>{"\n"}</>}
            {output}
            {failed && call.result && "\n"}
            {failed && <span className="text-[#e06c75]">exit {(() => { try { const p = JSON.parse(call.result?.text ?? ""); return p.exit_code ?? 1; } catch { return 1; } })()}</span>}
          </pre>
        </div>
      );
    }
    // Mixed config: render input and output independently
    return (
      <div className="ml-5 mt-0.5 mb-1 flex flex-col gap-1">
        {displayConfig.input && (
          <ConfiguredInputRenderer args={call.arguments} cfg={displayConfig.input} toolName={call.name} />
        )}
        {!displayConfig.input && (
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-bg-surface/60 px-2 py-1 text-[11px] text-fg-fainter font-mono">
            {formatArgsText(call.arguments, call.name, t, { skipHumanize: true })}
          </pre>
        )}
        {call.result && displayConfig.output && (
          <ConfiguredOutputRenderer text={resultText} failed={failed} cfg={displayConfig.output} />
        )}
        {call.result && !displayConfig.output && (
          <pre className={"max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg px-2 py-1 text-[11px] font-mono " +
            (failed ? "bg-rose-950/40 text-danger" : "bg-bg-surface/60 text-fg-muted")}
          >
            {formatResultText(call.result.text, undefined, t)}
          </pre>
        )}
      </div>
    );
  }

  // ── Fallback: inferRender() for tools without a display config ──
  const renderType = inferRender(call.name);

  if (renderType === "terminal") {
    const cmd = typeof call.arguments.command === "string" ? call.arguments.command : undefined;
    const output = call.result ? formatResultText(call.result.text, undefined, t) : "";
    return (
      <div className="ml-5 mt-0.5 mb-1 rounded-lg overflow-hidden border border-[#333] shadow-sm">
        <div className="flex items-center gap-1.5 px-3 py-1 bg-[#1a1a1a]">
          <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
          <span className="ml-2 text-[10px] text-[#888] font-mono">terminal</span>
        </div>
        <pre className={"max-h-64 overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-[11px] font-mono leading-relaxed " +
          (failed ? "bg-[#0d0d0d] text-[#e06c75]" : "bg-[#0d0d0d] text-[#abb2bf]")}
        >
          {cmd && <><span className="text-[#98c379]">$ </span><span className="text-[#e5c07b]">{cmd}</span>{"\n"}</>}
          {output}
          {failed && call.result && "\n"}
          {failed && <span className="text-[#e06c75]">exit {(() => { try { const p = JSON.parse(call.result?.text ?? ""); return p.exit_code ?? 1; } catch { return 1; } })()}</span>}
        </pre>
      </div>
    );
  }

  if (renderType === "markdown") {
    const rawResult = call.result?.text ?? "";
    // Try to parse structured search results: "N results from ... for ...:\n\n1. Title\n   url (date)\n   snippet"
    const searchResults = parseSearchResults(rawResult);
    return (
      <div className="ml-5 mt-0.5 mb-1 flex flex-col gap-1">
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-bg-surface/60 px-2 py-1 text-[11px] text-fg-fainter font-mono">
          {formatArgsText(call.arguments, call.name, t, { skipHumanize: true })}
        </pre>
        {searchResults.length > 0 ? (
          <div className={"max-h-80 overflow-auto rounded-lg px-3 py-2 text-xs " + (failed ? "bg-rose-950/40" : "bg-bg-surface/60")}>
            {searchResults.map((r, i) => (
              <div key={i} className={i > 0 ? "mt-2 pt-2 border-t border-border-subtle/30" : ""}>
                <div className="font-medium text-fg-muted">{r.title}</div>
                <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-link hover:underline truncate block">{r.domain}{r.date ? ` · ${r.date}` : ""}</a>
                {r.snippet && <ExpandableSnippet text={r.snippet} />}
              </div>
            ))}
          </div>
        ) : (
          rawResult && (
            <pre className={"max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg px-3 py-2 text-[11px] font-mono " +
              (failed ? "bg-rose-950/40 text-danger" : "bg-bg-surface/60 text-fg-muted")}
            >
              {formatResultText(rawResult, undefined, t)}
            </pre>
          )
        )}
      </div>
    );
  }

  // File viewer: read_file / write_file / edit_file
  if (renderType === "file") {
    const normalized = normalizeBridgeName(call.name);
    const fname = typeof call.arguments.path === "string"
      ? (call.arguments.path as string).split("/").pop() || (call.arguments.path as string)
      : "file";
    const lang = extToLang(fname);
    const isWrite = /write/i.test(normalized);
    const isEdit = /edit/i.test(normalized);
    const isDelete = /delete/i.test(normalized);

    // Input content (for write_file)
    const inputContent = isWrite ? extractFileContent(call.arguments) : undefined;
    // Edit file: show edits summary
    const edits = isEdit && Array.isArray(call.arguments.edits) ? call.arguments.edits as Array<{oldText?: string; newText?: string}> : undefined;

    // Output content (for read_file)
    const fileResult = call.result ? extractFileResultContent(call.result.text) : undefined;
    // Fallback result text for non-file-shaped results
    const fallbackResult = call.result && !fileResult ? formatResultText(call.result.text, undefined, t) : undefined;

    return (
      <div className="ml-5 mt-0.5 mb-1 rounded-lg overflow-hidden border border-[#333] shadow-sm">
        {/* File header bar */}
        <div className="flex items-center gap-2 px-3 py-1 bg-[#1a1a1a]">
          <span className="text-[10px] text-[#888] font-mono">
            {isDelete ? "🗑" : isWrite ? "✏️" : isEdit ? "✂️" : "📄"}
          </span>
          <span className="text-[11px] text-[#ccc] font-mono font-medium">{fname}</span>
          {fileResult && (
            <span className="text-[10px] text-[#666] font-mono ml-auto">{fileResult.bytes} bytes</span>
          )}
        </div>

        {/* Write: show content being written */}
        {isWrite && inputContent && (
          <pre className={"max-h-64 overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-[11px] font-mono leading-relaxed bg-[#0d0d0d] " +
            (lang === "json" ? "text-[#e5c07b]" : "text-[#abb2bf]")}
          >
            {inputContent.length > 2000 ? inputContent.slice(0, 2000) + "\n\n…(truncated)" : inputContent}
          </pre>
        )}

        {/* Write with no decodable content (binary) */}
        {isWrite && !inputContent && (
          <div className="px-3 py-1.5 text-[11px] text-[#666] font-mono bg-[#0d0d0d]">
            (binary content)
          </div>
        )}

        {/* Edit: show edits */}
        {isEdit && edits && edits.length > 0 && (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-[11px] font-mono leading-relaxed bg-[#0d0d0d] text-[#abb2bf]">
            {edits.map((e, i) => (
              <span key={i}>
                {i > 0 && "\n"}
                <span className="text-[#e06c75]">- {typeof e.oldText === "string" ? (e.oldText.length > 200 ? e.oldText.slice(0, 200) + "…" : e.oldText) : ""}</span>
                {"\n"}
                <span className="text-[#98c379]">+ {typeof e.newText === "string" ? (e.newText.length > 200 ? e.newText.slice(0, 200) + "…" : e.newText) : ""}</span>
              </span>
            ))}
          </pre>
        )}

        {/* Read: show file content */}
        {fileResult?.content && (
          <pre className={"max-h-64 overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-[11px] font-mono leading-relaxed bg-[#0d0d0d] " +
            (lang === "json" ? "text-[#e5c07b]" : "text-[#abb2bf]")}
          >
            {fileResult.content.length > 2000 ? fileResult.content.slice(0, 2000) + "\n\n…(truncated)" : fileResult.content}
          </pre>
        )}

        {/* Read: binary or no content */}
        {fileResult && !fileResult.content && (
          <div className="px-3 py-1.5 text-[11px] text-[#666] font-mono bg-[#0d0d0d]">
            {fileResult.bytes} bytes (binary)
          </div>
        )}

        {/* Delete: just show the header is enough */}

        {/* Non-file result fallback */}
        {fallbackResult && (
          <pre className={"max-h-48 overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-[11px] font-mono bg-[#0d0d0d] " +
            (failed ? "text-[#e06c75]" : "text-[#abb2bf]")}
          >
            {fallbackResult}
          </pre>
        )}

        {/* Success/fail indicator for write/edit/delete */}
        {(isWrite || isEdit || isDelete) && call.result && (
          <div className={"px-3 py-1 text-[10px] font-mono border-t border-[#333] " +
            (failed ? "text-[#e06c75] bg-[#1a0a0a]" : "text-[#98c379] bg-[#0a1a0a]")}
          >
            {failed ? "✘ failed" : "✔ ok"}
          </div>
        )}
      </div>
    );
  }

  // "files" — structured file list (list_dir, sync_up, sync_down)
  if (renderType === "files") {
    return (
      <div className="ml-5 mt-0.5 mb-1 flex flex-col gap-1">
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-bg-surface/60 px-2 py-1 text-[11px] text-fg-fainter font-mono">
          {formatArgsText(call.arguments, call.name, t, { skipHumanize: true })}
        </pre>
        {call.result && (
          <div className={"max-h-80 overflow-auto rounded-lg px-3 py-2 " +
            (failed ? "bg-rose-950/40" : "bg-bg-surface/60")}
          >
            <FilesView text={call.result.text} />
          </div>
        )}
      </div>
    );
  }

  // "recall" — structured turn-by-turn view
  if (renderType === "recall") {
    return (
      <div className="ml-5 mt-0.5 mb-1 flex flex-col gap-1">
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-bg-surface/60 px-2 py-1 text-[11px] text-fg-fainter font-mono">
          {formatArgsText(call.arguments, call.name, t, { skipHumanize: true })}
        </pre>
        {call.result && (
          <div className={"max-h-[32rem] overflow-auto rounded-lg px-3 py-2 " +
            (failed ? "bg-rose-950/40" : "bg-bg-surface/60")}
          >
            <RecallView text={call.result.text} />
          </div>
        )}
      </div>
    );
  }

  // "plain" / "json" / fallback
  return (
    <div className="ml-5 mt-0.5 mb-1 flex flex-col gap-1">
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-bg-surface/60 px-2 py-1 text-[11px] text-fg-fainter font-mono">
        {formatArgsText(call.arguments, call.name, t, { skipHumanize: true })}
      </pre>
      {call.result && (() => {
        // Try structured toon rendering first — supports collapsible long text
        const rawText = call.result.text.trim();
        let toonNodes: ToonNode[] | null = null;
        if (!rawText.startsWith("{")) {
          toonNodes = parseToon(rawText, t);
        } else {
          try {
            const parsed = JSON.parse(rawText);
            if (typeof parsed === "object" && parsed !== null && "text" in parsed && typeof parsed.text === "string") {
              toonNodes = parseToon(parsed.text, t);
            }
          } catch { /* fall through */ }
        }
        if (toonNodes && toonNodes.length > 0) {
          return (
            <div className={"max-h-80 overflow-auto rounded-lg px-3 py-2 " +
              (failed ? "bg-rose-950/40" : "bg-bg-surface/60")}
            >
              <ToonView nodes={toonNodes} />
            </div>
          );
        }
        return (
          <pre
            className={"max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg px-2 py-1 text-[11px] font-mono " +
              (failed ? "bg-rose-950/40 text-danger" : "bg-bg-surface/60 text-fg-muted")}
          >
            {formatResultText(call.result.text, undefined, t)}
          </pre>
        );
      })()}
    </div>
  );
}

// ── Per-step expandable row inside a tool group ─────────────

function ToolCallStepRow({ call }: { call: MergedToolCall }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const running = !call.result;
  const failed = !!call.result && !call.result.ok;
  const label = humanizeToolCall(call.name, call.arguments, t) || shortToolName(call.name);

  return (
    <div className="flex flex-col min-w-0">
      <button
        type="button"
        onClick={() => !running && setOpen((v) => !v)}
        className={"group flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-xs rounded-lg transition-colors " +
          (running ? "cursor-default" : "cursor-pointer hover:bg-bg-hover")}
      >
        {running && <Loader2 size={10} className="shrink-0 animate-spin text-accent" />}
        {failed && <XCircle size={10} className="shrink-0 text-rose-400" />}
        {!running && !failed && <CheckCircle2 size={10} className="shrink-0 text-emerald-500/60" />}
        <span className={running ? "text-accent font-medium" : failed ? "text-rose-400" : "text-fg-muted"}>
          {label}
        </span>
        <span className="text-fg-fainter font-mono text-[10px] ml-auto truncate max-w-[40%]" title={call.name}>
          {call.name}
        </span>
        {!running && (
          open
            ? <ChevronDown size={10} className="shrink-0 text-fg-fainter" />
            : <ChevronRight size={10} className="shrink-0 text-fg-fainter" />
        )}
      </button>
      {open && <ToolCallDetail call={call} failed={failed} />}
    </div>
  );
}

// ── Tool-call grouping for collapsed runs ──────────────────────────

/** True when a tool call has special visual rendering (screenshots,
 *  generated images, MCP-UI frames) and should NOT be folded into a
 *  collapsed group — it needs its own full-height row. */
function isRichToolCall(call: MergedToolCall): boolean {
  const txt = call.result?.text ?? "";
  if ((call.result?.ui?.length ?? 0) > 0) return true;
  if (SCREENSHOT_RE.test(txt)) { SCREENSHOT_RE.lastIndex = 0; return true; }
  const imgRe = new RegExp(GENERATED_IMAGE_RE.source);
  if (imgRe.test(txt)) return true;
  return false;
}

/** A batch of tool calls that were issued in the same LLM turn
 *  (parallel), or a single sequential call in its own turn. */
interface ToolBatch { calls: MergedToolCall[] }

/** A run of consecutive blocks that are either tool-call batches
 *  (groupable) or a single non-tool / rich-tool block. */
type BlockRun =
  | { kind: "tools"; batches: ToolBatch[] }
  | { kind: "single"; block: MergedAssistantBlock; index: number };

/** Group consecutive plain (non-rich) toolCall blocks into runs.
 *  Uses turnBoundary markers to separate parallel batches.
 *  Text blocks, rich tool calls, and lone tool calls stay as singles. */
function groupBlocks(blocks: MergedAssistantBlock[]): BlockRun[] {
  const runs: BlockRun[] = [];
  let batchBuf: MergedToolCall[] = [];   // current parallel batch
  let batchesBuf: ToolBatch[] = [];      // accumulated batches for current run

  const flushBatch = () => {
    if (batchBuf.length > 0) {
      batchesBuf.push({ calls: [...batchBuf] });
      batchBuf = [];
    }
  };
  const flushRun = () => {
    flushBatch();
    if (batchesBuf.length > 0) {
      runs.push({ kind: "tools", batches: [...batchesBuf] });
      batchesBuf = [];
    }
  };

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === "turnBoundary") {
      // Boundary between LLM turns — start a new batch within the
      // same run (sequential boundary between parallel groups).
      flushBatch();
      continue;
    }
    if (b.kind === "toolCall") {
      const tc = b as unknown as MergedToolCall;
      if (!isRichToolCall(tc)) {
        batchBuf.push(tc);
        continue;
      }
    }
    // Non-tool or rich-tool block — flush accumulated tools and
    // emit the block as a single.
    flushRun();
    runs.push({ kind: "single", block: b, index: i });
  }
  flushRun();
  return runs;
}

/** Collapsed group header for 2+ consecutive tool calls. */
// shortToolName imported from ../lib/humanize-tool

function ToolCallGroup({ batches }: { batches: ToolBatch[] }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  const allCalls = batches.flatMap((b) => b.calls);
  const errorCount = allCalls.filter((c) => c.result && !c.result.ok).length;
  const allDone = allCalls.every((c) => !!c.result);
  const runningIdx = allCalls.findIndex((c) => !c.result);

  const summary = humanizeToolGroup(allCalls, t);

  // Progress: "2/5" style
  const doneCount = allCalls.filter((c) => !!c.result).length;
  const progressText = !allDone ? `${doneCount}/${allCalls.length}` : undefined;

  // Currently running step description
  const runningHint = runningIdx >= 0
    ? humanizeToolCall(allCalls[runningIdx].name, allCalls[runningIdx].arguments, t)
      || shortToolName(allCalls[runningIdx].name)
    : undefined;

  const headerIcon = !allDone ? (
    <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
  ) : errorCount > 0 ? (
    <XCircle size={13} className="shrink-0 text-rose-400" />
  ) : (
    <CheckCircle2 size={13} className="shrink-0 text-emerald-500/80" />
  );

  return (
    <div className="flex flex-col w-full min-w-0 my-0.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="group flex w-full min-w-0 select-none items-center gap-2 rounded-xl px-3 py-2 text-xs transition-all cursor-pointer bg-bg-surface hover:bg-bg-hover"
      >
        {headerIcon}
        <span className="min-w-0 flex-1 text-left truncate">
          {!allDone && runningHint ? (
            /* While running: show current step */
            <span className="text-accent font-medium">{runningHint}</span>
          ) : (
            /* Done: ticker cycles through all step labels */
            <span className="text-fg-muted">{summary}</span>
          )}
        </span>
        {progressText && (
          <span className="shrink-0 tabular-nums text-fg-fainter">{progressText}</span>
        )}
        {errorCount > 0 && (
          <span className="shrink-0 text-rose-400">
            {t("tool.nFailed", { n: errorCount })}
          </span>
        )}
        {expanded ? (
          <ChevronDown size={12} className="shrink-0 text-fg-fainter group-hover:text-fg-muted transition-colors" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-fg-fainter group-hover:text-fg-muted transition-colors" />
        )}
      </button>
      {expanded && (
        <div className="mt-1 flex flex-col gap-0.5 pl-2">
          {allCalls.map((c) => <ToolCallStepRow key={c.id} call={c} />)}
        </div>
      )}
    </div>
  );
}
/** Renders blocks with consecutive plain tool calls grouped into
 *  collapsible runs. Rich tool calls (screenshots/UI/images) and text
 *  blocks render individually as before. */
function GroupedBlocks({
  blocks,
  isUser,
  MarkdownBlock,
  proseInvert,
}: {
  blocks: MergedAssistantBlock[];
  isUser: boolean;
  MarkdownBlock: React.ComponentType<{ children: string; noProse?: boolean }>;
  proseInvert: string;
}) {
  const runs = useMemo(() => groupBlocks(blocks), [blocks]);
  return (
    <div className={`flex w-full min-w-0 flex-col gap-1.5 ${isUser ? "items-end" : "items-start"}`}>
      {runs.map((run, ri) => {
        if (run.kind === "tools") {
          const allCalls = run.batches.flatMap((b) => b.calls);
          // Single tool call → render normally (no extra nesting)
          if (allCalls.length === 1) {
            return <ToolCallRow key={allCalls[0].id} call={allCalls[0]} />;
          }
          // 2+ tool calls → collapsed group with batch info
          return <ToolCallGroup key={`tg${ri}`} batches={run.batches} />;
        }
        // Single block (text or rich tool call)
        return renderAssistantBlock(run.block, run.index, isUser, MarkdownBlock, proseInvert);
      })}
    </div>
  );
}

/** Strip the [System] Triggered at: ... prefix from cron text, keep only user message. */
function stripSystemPrefix(text: string): string {
  // Format: [System] Triggered at: <ts> | Job: "<title>" (<type>)\n\n<body>
  const m = text.match(/^\[System\] Triggered at:[^\n]*\n\n(.*)$/s);
  return m ? m[1].trim() : text;
}

/** Format UTC timestamp to friendly relative/absolute time. */
function formatEventTime(firedAt: string, dateLoc: string): string {
  try {
    const d = new Date(firedAt.replace(" ", "T").replace(" (UTC)", "Z"));
    if (isNaN(d.getTime())) return firedAt;
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60_000) return "Just now";
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    return d.toLocaleDateString(dateLoc, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return firedAt;
  }
}

/** Event card for system events (cron fires, recovery, upgrades, etc.) */
function EventCard({ event }: { event: SystemEvent }) {
  const dateLoc = useDateLocale();
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
        <span className={`ml-auto shrink-0 rounded-full ${s.badgeBg} px-2 py-0.5 text-xs font-medium uppercase tracking-wider ${s.badgeColor}`}>
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
          <div className="flex items-center gap-1.5 text-xs text-fg-faint">
            <Calendar size={11} />
            <span>{formatEventTime(event.firedAt, dateLoc)}</span>
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
