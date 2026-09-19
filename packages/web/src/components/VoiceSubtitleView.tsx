// Voice mode subtitle view.
//
// Yu, 2026-09-20 01:02: "conversation 区域最好改成字幕模式，显示的字
// 跟正在念的字一致，并且滚动播放，字体要大一些，支持远距离观看".
//
// When voice mode is on, ChatArea swaps to this view instead of the
// normal message list. Design decisions:
//
//   - **3-row rolling window** (prev / current / next chunk). Yu
//     picked A over "keep full history" and "hide everything else".
//     Newsreader-style subtitles: minimum distraction, focus on
//     what's being spoken RIGHT NOW.
//   - **Big fonts**: current chunk 3xl (30px+), context rows lg
//     (18px). Sofa-distance readable.
//   - **Auto-scroll** naturally: the current row is anchored center;
//     we render the three rows in a fixed vertical layout so no
//     scroll math needed. Chunk transitions fade out old, fade in
//     new.
//   - **Idle state**: when nothing is playing, show a hint plus
//     the last spoken chunk (if any) so the screen isn't blank.
//   - **User input intact**: composer stays visible at the bottom;
//     Yu can dictate replies via OS input as before.
//
// Data model: voice-store owns `currentDisplayText` (the chunk
// text currently being spoken). We derive prev/next by walking
// the same blank-line splitter useAutoSpeakReplies uses, applied
// to the tail assistant message. This keeps everything in sync
// with what the audio pipeline is actually playing.

import { useEffect, useMemo, useRef } from "react";
import { PanelLeftClose, PanelLeftOpen, Volume2 } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import { useVoiceStore } from "../stores/voice-store";
import { useVoiceMode } from "../hooks/useVoiceMode";
import ChatInput from "./ChatInput";

// Same blank-line splitter used by useAutoSpeakReplies. Kept in
// sync via test-if-you-touch-either. Two \n\ns min, tolerates
// intermediate whitespace on the empty line.
const BLANK_LINE_RE = /\n\s*\n/;

/** Split a message body into chunks the same way the audio
 *  pipeline slices them. Empty / whitespace-only chunks are
 *  filtered so subtitle rows don't display blanks. */
function splitChunks(text: string): string[] {
  return text
    .split(BLANK_LINE_RE)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

// Row layout constants. Tuned together so the filmstrip transform
// perfectly aligns the currentIndex row on screen center.
//
// ROW_HEIGHT in px — each subtitle occupies a fixed slot regardless
// of natural text height, so transform math stays predictable.
// If a chunk is long enough to wrap 3+ lines, we let it overflow
// downward; visual clamp on the container hides it.
const ROW_HEIGHT_PX = 96;
// Visual radius: how many rows above / below the current one we
// render. total rendered = 1 + 2*VISIBLE_RADIUS. Higher = smoother
// scroll but more offscreen DOM.
const VISIBLE_RADIUS = 2;

interface FilmstripRowProps {
  text: string;
  /** Distance from currentIndex; 0 = center, negative = above,
   *  positive = below. Drives size + opacity. */
  offset: number;
}

/** One row in the filmstrip. Absolute-positioned; distance from
 *  current governs size and opacity. Yu 2026-09-20 01:13: "搞个
 *  滚动效果" — the ENTIRE strip translates on chunk change so
 *  each row slides up (or down for a rewind) with a smooth ease. */
function FilmstripRow({ text, offset }: FilmstripRowProps) {
  const abs = Math.abs(offset);
  let sizeClass: string;
  let opacityClass: string;
  let colorClass: string;

  if (abs === 0) {
    sizeClass = "text-3xl sm:text-4xl md:text-5xl font-medium";
    opacityClass = "opacity-100";
    colorClass = "text-fg-default";
  } else if (abs === 1) {
    sizeClass = "text-xl sm:text-2xl";
    opacityClass = "opacity-60";
    colorClass = offset < 0 ? "text-fg-faint" : "text-fg-muted";
  } else {
    sizeClass = "text-base sm:text-lg";
    opacityClass = "opacity-25";
    colorClass = "text-fg-faint";
  }

  return (
    <div
      className={`absolute inset-x-0 mx-auto max-w-4xl px-6 text-center leading-relaxed transition-all duration-500 ease-out ${sizeClass} ${opacityClass} ${colorClass}`}
      style={{
        top: `calc(50% + ${offset * ROW_HEIGHT_PX}px)`,
        transform: "translateY(-50%)",
      }}
    >
      {text}
    </div>
  );
}

export default function VoiceSubtitleView() {
  const messages = useChatStore((s) => s.messages);
  const currentDisplayText = useVoiceStore((s) => s.currentDisplayText);
  const playingId = useVoiceStore((s) => s.playingId);
  const { toggle: toggleVoice } = useVoiceMode();
  const sidebarOpen = useChatStore((s) => s.sidebarOpen);
  const toggleSidebar = useChatStore((s) => s.toggleSidebar);

  // Last-known "current chunk" so idle state doesn't blank out
  // during the gap between an assistant reply's chunks arriving
  // and the audio pipeline starting the first play.
  const lastCurrentRef = useRef<string>("");
  useEffect(() => {
    if (currentDisplayText) {
      lastCurrentRef.current = currentDisplayText;
    }
  }, [currentDisplayText]);

  // Tail assistant message chunks — source of prev / next context.
  // Walking chat-store.messages directly (WireMessage) so we see
  // the same raw text useAutoSpeakReplies is slicing.
  const tailChunks = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.text) {
        return splitChunks(m.text);
      }
    }
    return [] as string[];
  }, [messages]);

  // Locate the current chunk within tailChunks so we can pick prev
  // and next context rows. `currentDisplayText` was pre-trimmed by
  // useAutoSpeakReplies before enqueueing, so equality works.
  const currentIndex = useMemo(() => {
    const needle = currentDisplayText || lastCurrentRef.current;
    if (!needle) return -1;
    return tailChunks.findIndex((c) => c === needle);
  }, [tailChunks, currentDisplayText]);

  const displayCurrent =
    currentDisplayText ||
    lastCurrentRef.current ||
    (tailChunks.length > 0 ? tailChunks[tailChunks.length - 1] : "");

  // Effective center index. When currentIndex is -1 (idle or
  // between chunks), fall back to the last chunk in tailChunks so
  // the filmstrip settles somewhere reasonable instead of jumping
  // to 0.
  const effectiveIndex =
    currentIndex >= 0
      ? currentIndex
      : tailChunks.length > 0
        ? tailChunks.length - 1
        : 0;

  // Filmstrip window — slice around effectiveIndex. We track chunks
  // and their ABSOLUTE indices so cross-fades between chunks feel
  // natural even when the window edges hit array boundaries.
  const filmstrip: Array<{ text: string; index: number }> = useMemo(() => {
    if (tailChunks.length === 0) {
      return [{ text: displayCurrent, index: 0 }];
    }
    const out: Array<{ text: string; index: number }> = [];
    for (let i = effectiveIndex - VISIBLE_RADIUS; i <= effectiveIndex + VISIBLE_RADIUS; i++) {
      if (i >= 0 && i < tailChunks.length) {
        out.push({ text: tailChunks[i], index: i });
      }
    }
    return out;
  }, [tailChunks, effectiveIndex, displayCurrent]);

  const idle = !playingId && !lastCurrentRef.current;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      {/* Minimal header — sidebar toggle + close-voice button.
          Anything else would compete with the big subtitles. */}
      <header className="flex h-12 items-center justify-between border-b border-border-subtle bg-bg-elevated/50 px-4 backdrop-blur">
        <button
          type="button"
          onClick={toggleSidebar}
          className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg-default"
          title={sidebarOpen ? "隐藏侧栏" : "显示侧栏"}
        >
          {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
        </button>
        <div className="text-xs uppercase tracking-widest text-fg-faint">
          🎧 语音模式
        </div>
        <button
          type="button"
          onClick={toggleVoice}
          className="rounded-lg p-1.5 text-accent-fill transition-colors hover:bg-bg-raised hover:text-accent-fg"
          title="关闭语音回复"
          aria-label="Disable voice replies"
          aria-pressed={true}
        >
          <Volume2 size={16} />
        </button>
      </header>

      {/* Big centered subtitle area */}
      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-4 py-12">
        {idle ? (
          <div className="text-center">
            <div className="text-2xl text-fg-muted sm:text-3xl">
              🎧 语音模式
            </div>
            <div className="mt-3 text-sm text-fg-faint">
              发消息后，回复会在这里跟着语音一句一句显示
            </div>
          </div>
        ) : (
          // Filmstrip container. Fixed height so absolute-positioned
          // rows can center via `top: 50% + offset`. Overflow hidden
          // so far-offset rows dissolve at the edges instead of
          // spilling into the composer.
          <div
            className="relative w-full overflow-hidden"
            style={{ height: `${ROW_HEIGHT_PX * (1 + 2 * VISIBLE_RADIUS)}px` }}
          >
            {filmstrip.map((row) => (
              <FilmstripRow
                key={row.index}
                text={row.text}
                offset={row.index - effectiveIndex}
              />
            ))}
          </div>
        )}
      </div>

      {/* Composer stays put so voice-mode users can still send. */}
      <div className="border-t border-border-subtle bg-bg-elevated/50 backdrop-blur">
        <div className="mx-auto max-w-3xl">
          <ChatInput />
        </div>
      </div>
    </main>
  );
}
