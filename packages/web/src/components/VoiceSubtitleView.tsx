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

interface ChunkRowProps {
  text: string;
  role: "prev" | "current" | "next";
}

/** One subtitle row. `role` drives sizing + opacity. */
function ChunkRow({ text, role }: ChunkRowProps) {
  const base =
    "mx-auto max-w-4xl px-6 text-center transition-all duration-300 ease-out leading-relaxed";
  if (role === "current") {
    return (
      <div
        className={`${base} text-3xl font-medium text-fg-default sm:text-4xl md:text-5xl`}
      >
        {text}
      </div>
    );
  }
  if (role === "prev") {
    return (
      <div className={`${base} text-lg text-fg-faint opacity-60 sm:text-xl`}>
        {text}
      </div>
    );
  }
  // next
  return (
    <div className={`${base} text-lg text-fg-muted opacity-60 sm:text-xl`}>
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
  const displayPrev =
    currentIndex > 0 ? tailChunks[currentIndex - 1] : undefined;
  const displayNext =
    currentIndex >= 0 && currentIndex < tailChunks.length - 1
      ? tailChunks[currentIndex + 1]
      : undefined;

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
          <>
            <div className="min-h-[2em]">
              {displayPrev && <ChunkRow text={displayPrev} role="prev" />}
            </div>
            <ChunkRow text={displayCurrent} role="current" />
            <div className="min-h-[2em]">
              {displayNext && <ChunkRow text={displayNext} role="next" />}
            </div>
          </>
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
