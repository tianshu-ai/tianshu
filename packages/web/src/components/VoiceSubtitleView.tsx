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

import { memo, useEffect, useMemo, useRef } from "react";
import { PanelLeftClose, PanelLeftOpen, Volume2 } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import { useVoiceStore } from "../stores/voice-store";
import { useVoiceMode } from "../hooks/useVoiceMode";
import ChatInput from "./ChatInput";
import PluginTopBarButtons from "./PluginTopBarButtons";

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

// Apple Music lyrics-style layout.
//
// Yu 2026-09-20 02:08 "有点乱" screenshot: v2 (cc6fe92) had all
// rows at 5xl full-multi-line, so adjacent chunks stacked into
// each other. Also the halo backdrop looked like garbled text.
//
// v3: keep the Apple Music left-aligned bold big vibe, but:
//   - Off-center rows TRUNCATE to single line (only current wraps)
//   - Halo backdrop removed (it was noise, not ambiance)
//   - ROW_HEIGHT_PX bumped to 240 to comfortably fit 3-line current
//   - VISIBLE_RADIUS 2 (5 rows total) — Apple's actual UI shows
//     roughly 2 sung + current + 2 upcoming
const ROW_HEIGHT_PX = 240;
const VISIBLE_RADIUS = 2;

interface FilmstripRowProps {
  text: string;
  /** Distance from currentIndex; 0 = center, negative = above,
   *  positive = below. Drives size + opacity. */
  offset: number;
}

/**
 * Apple Music-style lyric row.
 *
 * Uniform font-size across all rows so the scroll feels
 * continuous — depth comes from color / opacity / scale / tilt,
 * not from shrinking off-center text.
 *
 * offset semantics:
 *   0     : current line — white 100%, bold-heavier, slight scale
 *  <0    : sung — fades to 12% opacity, back-tilt (rotateX +)
 *  >0    : upcoming — subtly brighter than sung at same distance,
 *          forward-tilt (rotateX -) so it feels like it's leaning
 *          into view
 *
 * Yu 2026-09-20 01:52: match Apple Music's ambient scroll UX.
 */
const FilmstripRow = memo(function FilmstripRow({
  text,
  offset,
}: FilmstripRowProps) {
  const abs = Math.abs(offset);
  const isCurrent = abs === 0;

  let color: string;
  let scale: string;
  let tiltDeg: string;

  if (isCurrent) {
    color = "rgba(255,255,255,1)";
    scale = "1.03";
    tiltDeg = "0deg";
  } else if (offset < 0) {
    color =
      abs === 1
        ? "rgba(255,255,255,0.35)"
        : abs === 2
          ? "rgba(255,255,255,0.20)"
          : "rgba(255,255,255,0.10)";
    scale = "1";
    tiltDeg = `${Math.min(abs * 2, 6)}deg`;
  } else {
    color =
      abs === 1
        ? "rgba(255,255,255,0.55)"
        : abs === 2
          ? "rgba(255,255,255,0.28)"
          : "rgba(255,255,255,0.14)";
    scale = "1";
    tiltDeg = `-${Math.min(abs * 2, 6)}deg`;
  }

  // Only current wraps multi-line; off-center rows truncate to a
  // single line + ellipsis so they can't collide with neighbors.
  const wrapClass = isCurrent ? "" : "truncate";

  return (
    <div
      className={`absolute inset-x-0 px-6 text-left text-3xl sm:text-4xl md:text-5xl ${wrapClass}`}
      style={{
        top: `calc(50% + ${offset * ROW_HEIGHT_PX}px)`,
        transform: `translateY(-50%) scale(${scale}) rotateX(${tiltDeg})`,
        transformOrigin: offset < 0 ? "top center" : "bottom center",
        transition:
          "top 500ms cubic-bezier(0.4, 0, 0.2, 1), transform 500ms cubic-bezier(0.4, 0, 0.2, 1), color 500ms ease-out",
        color,
        fontWeight: isCurrent ? 700 : 600,
        lineHeight: 1.25,
        letterSpacing: "-0.01em",
        textShadow: isCurrent ? "0 0 30px rgba(255,255,255,0.15)" : "none",
      }}
    >
      {text}
    </div>
  );
});

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

  // All assistant chunks across ALL assistant messages, in order.
  // Yu 2026-09-20 02:15: taking only the LAST message's chunks
  // makes the second reply feel abrupt — there's no fade-back
  // context of what was said earlier. Concatenating chunks from
  // every assistant reply keeps the Apple-Music-style scroll feel
  // continuous across turns: the previous reply's tail chunks
  // linger at the top as sung/faded, then the current chunk of
  // the new reply arrives in the middle, then future chunks stay
  // below waiting.
  //
  // Trimming to the last ~30 chunks so the filmstrip doesn't grow
  // unbounded on a long session. VISIBLE_RADIUS=2 needs 5 rows,
  // so 30 leaves plenty of context and keeps the DOM tiny.
  const CHUNK_HISTORY_LIMIT = 30;
  const tailChunks = useMemo(() => {
    const all: string[] = [];
    for (const m of messages) {
      if (m.role !== "assistant" || !m.text) continue;
      for (const c of splitChunks(m.text)) all.push(c);
    }
    if (all.length > CHUNK_HISTORY_LIMIT) {
      return all.slice(all.length - CHUNK_HISTORY_LIMIT);
    }
    return all;
  }, [messages]);

  // Locate the current chunk within tailChunks so we can pick prev
  // and next context rows. `currentDisplayText` was pre-trimmed by
  // useAutoSpeakReplies before enqueueing, so equality works.
  //
  // Yu 2026-09-20 09:43 "长文本回复时字幕会经常刷新":
  // during streaming, tailChunks changes on every delta — the
  // last chunk's text keeps growing until the next blank-line
  // arrives. If we use string equality against a MUTATING chunk,
  // findIndex flip-flops between the previous match and -1,
  // making effectiveIndex jump, filmstrip translate, and CSS
  // transitions re-fire on every keystroke's delta — the "flicker"
  // Yu sees.
  //
  // Fix: prefer EXACT match, but if that fails, fall back to
  // "startsWith" — the currently-playing chunk's snapshot text
  // is a stable prefix of the growing tail chunk. Once the tail
  // stabilises (next blank-line arrives), exact match returns.
  const currentIndex = useMemo(() => {
    const needle = currentDisplayText || lastCurrentRef.current;
    if (!needle) return -1;
    const exact = tailChunks.findIndex((c) => c === needle);
    if (exact !== -1) return exact;
    // Fallback: the currently-spoken chunk may be a stable prefix
    // of a still-growing final tail chunk. Search backward so we
    // pick the LATEST match (most recent chunk) not an older
    // repeat of the same opening.
    for (let i = tailChunks.length - 1; i >= 0; i--) {
      if (tailChunks[i].startsWith(needle)) return i;
    }
    return -1;
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

  // Keep the composer textarea focused whenever voice mode is on.
  //
  // Yu 2026-09-20 09:34: wanted zero-friction dictation for far-
  // viewing UX — sit back, watch subtitles, start talking. First
  // attempt used a keydown listener to catch the first char and
  // steer it into the composer, but Yu 2026-09-20 09:46 flagged
  // that OS dictation (macOS fn+fn, Windows Win+H) uses IME
  // composition events, NOT keydown. Fix: keep composer focused
  // ALL THE TIME while voice mode is on, so IME composition has
  // a target ready without any keystroke needed.
  //
  // Strategy:
  //   1. On mount, focus the composer.
  //   2. Listen for focusin on the whole document. If focus lands
  //      anywhere else, refocus the composer — UNLESS the new
  //      focus is on one of the allowed exceptions (sidebar
  //      toggle, plugin bar buttons, voice-off button, plugin
  //      panel content). Users need those to be interactive.
  //   3. On mouse click landing on the subtitle area (not on a
  //      button), we can rely on browser default to move focus
  //      to body, and step 2 kicks it back to the composer.
  useEffect(() => {
    let composer: HTMLTextAreaElement | null = null;

    function findComposer(): HTMLTextAreaElement | null {
      if (composer && document.contains(composer)) return composer;
      composer = document.querySelector("textarea") as
        | HTMLTextAreaElement
        | null;
      return composer;
    }

    // Initial focus. defer to next tick so the DOM has settled
    // after this effect flush.
    const initTimer = window.setTimeout(() => {
      findComposer()?.focus();
    }, 0);

    function isInteractiveTarget(el: Element | null): boolean {
      if (!el) return false;
      // Any button, link, form control, or contenteditable is
      // interactive and should keep focus. Plugin panels can hold
      // their own inputs (like the DataSource query editor); if
      // focus lands inside them, respect that.
      let node: Element | null = el;
      while (node) {
        const tag = node.tagName;
        if (
          tag === "BUTTON" ||
          tag === "A" ||
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          (node as HTMLElement).isContentEditable
        ) {
          return true;
        }
        // aside = PluginRightPanel wrapper; anything inside a plugin
        // panel should be treated as legitimate user focus.
        if (tag === "ASIDE") return true;
        node = node.parentElement;
      }
      return false;
    }

    function onFocusIn(ev: FocusEvent) {
      const target = ev.target as Element | null;
      const c = findComposer();
      if (!c) return;
      if (target === c) return; // already the composer
      if (isInteractiveTarget(target)) return; // legit user click
      // Fell through to non-interactive area — grab focus back.
      c.focus();
    }

    // Also keep listening for character keydowns for a safety net,
    // in case IME composition lands somewhere unexpected — same
    // logic as before but the primary win is now focusin above.
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key.length !== 1 && ev.key !== "Enter") return;
      const target = ev.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          target.isContentEditable ||
          target.getAttribute("role") === "textbox"
        ) {
          return;
        }
      }
      const c = findComposer();
      if (!c) return;
      c.focus();
      if (ev.key.length === 1) {
        ev.preventDefault();
        const start = c.selectionStart ?? c.value.length;
        const end = c.selectionEnd ?? c.value.length;
        const newValue = c.value.slice(0, start) + ev.key + c.value.slice(end);
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        if (setter) {
          setter.call(c, newValue);
          c.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          c.value = newValue;
        }
        c.selectionStart = c.selectionEnd = start + 1;
      }
    }

    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(initTimer);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      {/* Header: keep sidebar + plugin-panel controls so voice mode
          still lets Yu manage side panels manually AND lets tianshu
          drive them via plugin bar buttons. Yu 2026-09-20 01:15:
          "聊天模式你把插件的 panel 隐掉了，我还希望 tianshu 可以帮我
          操作边栏的". */}
      <header className="flex h-12 items-center justify-between border-b border-border-subtle bg-bg-elevated/50 px-4 backdrop-blur">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={toggleSidebar}
            className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg-default"
            title={sidebarOpen ? "隐藏侧栏" : "显示侧栏"}
          >
            {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
          <span className="text-xs uppercase tracking-widest text-fg-faint">
            🎧 语音模式
          </span>
        </div>
        <div className="flex items-center gap-2">
          <PluginTopBarButtons />
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
        </div>
      </header>

      {/* Big centered subtitle area. `min-h-0` on the flex child
          + `overflow-hidden` on the wrapper: without these, the
          fixed-height filmstrip (480px) can push its parent past
          the flex allocation and cover the composer below. Yu
          2026-09-20 01:18 reported ModelSelector unclickable in
          voice mode — that's this. */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 overflow-hidden px-4 py-12">
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
          // Filmstrip. `perspective` on the wrapper turns rotateX
          // on rows into real 3D depth. `relative` allows the halo
          // backdrop to absolute-position inside. Max-w-5xl keeps
          // subtitle lines readable at desktop widths.
          <div
            className="relative mx-auto w-full max-w-5xl overflow-hidden"
            style={{
              height: `${ROW_HEIGHT_PX * (1 + 2 * VISIBLE_RADIUS)}px`,
              perspective: "1200px",
            }}
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

      {/* Composer. `relative z-10` guarantees it stacks above any
          filmstrip row that briefly extends past its container
          during a transition. Yu 2026-09-20 01:18: ModelSelector
          was unclickable behind a 5xl chunk row. */}
      <div className="relative z-10 border-t border-border-subtle bg-bg-elevated/50 backdrop-blur">
        <div className="mx-auto max-w-3xl">
          <ChatInput />
        </div>
      </div>
    </main>
  );
}
