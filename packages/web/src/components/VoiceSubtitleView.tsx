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
import { Headphones, PanelLeftClose, PanelLeftOpen } from "lucide-react";
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
  let background: string | undefined;
  let webkitBackgroundClip: string | undefined;
  let webkitTextFillColor: string | undefined;

  if (isCurrent) {
    // Yu 2026-09-20 13:15 “字幕颜色和效果要适配几种主题”:
    // Read gradient + glow tint from CSS vars so dark / light /
    // classical each get their own palette. Fallback keeps old
    // cyan→white→lavender look if the theme forgot to declare
    // its --voice-current-gradient (shouldn't happen; both roots
    // and both [data-theme] blocks now define the full set).
    color = "transparent";
    background =
      "var(--voice-current-gradient, linear-gradient(120deg, #a5d8ff 0%, #ffffff 50%, #d0bfff 100%))";
    webkitBackgroundClip = "text";
    webkitTextFillColor = "transparent";
    scale = "1.06";
    tiltDeg = "0deg";
  } else if (offset < 0) {
    color =
      abs === 1
        ? "var(--voice-past-1, rgba(255,255,255,0.35))"
        : abs === 2
          ? "var(--voice-past-2, rgba(255,255,255,0.20))"
          : "var(--voice-past-3, rgba(255,255,255,0.10))";
    scale = "1";
    tiltDeg = `${Math.min(abs * 2, 6)}deg`;
  } else {
    color =
      abs === 1
        ? "var(--voice-next-1, rgba(255,255,255,0.55))"
        : abs === 2
          ? "var(--voice-next-2, rgba(255,255,255,0.28))"
          : "var(--voice-next-3, rgba(255,255,255,0.14))";
    scale = "1";
    tiltDeg = `-${Math.min(abs * 2, 6)}deg`;
  }

  // Only current wraps multi-line; off-center rows truncate to a
  // single line + ellipsis so they can't collide with neighbors.
  const wrapClass = isCurrent ? "" : "truncate";

  // Yu 2026-09-20 13:22 “正在播放的 trunk 的背景搞成磨砂玻璃的样子”:
  // 拆成两层。外层 <div> 处理位置、transform、磨砂玻璃背景（仅
  // current）。内层 <span> 处理文本颜色、渐变填充、drop-shadow 发光。
  // 不能把 background 同时用在文字渐变（background-clip:text）和背
  // 景玻璃层上——不兼容。双层后各自干自己的活。
  if (isCurrent) {
    return (
      <div
        className={`absolute inset-x-0 mx-4 sm:mx-6 md:mx-8 voice-current-row`}
        style={{
          top: `calc(50% + ${offset * ROW_HEIGHT_PX}px)`,
          transform: `translateY(-50%) scale(${scale}) rotateX(${tiltDeg})`,
          transformOrigin: "center",
          transition:
            "top 500ms cubic-bezier(0.4, 0, 0.2, 1), transform 500ms cubic-bezier(0.4, 0, 0.2, 1)",
          // Frosted-glass pill: theme-aware tint + heavy backdrop
          // blur + saturate. Rounded, subtle inner ring so the
          // panel edge reads even on solid backgrounds.
          background:
            "var(--voice-current-panel-bg, rgba(255,255,255,0.05))",
          backdropFilter: "blur(20px) saturate(1.6)",
          WebkitBackdropFilter: "blur(20px) saturate(1.6)",
          borderRadius: "24px",
          boxShadow:
            "inset 0 0 0 1px var(--voice-current-panel-ring, rgba(255,255,255,0.12)), 0 8px 32px var(--voice-current-panel-shadow, rgba(0,0,0,0.25))",
          padding: "20px 28px",
        }}
      >
        <span
          className="text-left text-3xl sm:text-4xl md:text-5xl block"
          style={{
            color: "transparent",
            fontWeight: 800,
            lineHeight: 1.25,
            letterSpacing: "-0.01em",
            background,
            WebkitBackgroundClip: webkitBackgroundClip,
            WebkitTextFillColor: webkitTextFillColor,
            backgroundClip: webkitBackgroundClip,
            filter:
              "drop-shadow(0 0 24px var(--voice-current-glow-1, rgba(165,216,255,0.35))) drop-shadow(0 0 48px var(--voice-current-glow-2, rgba(208,191,255,0.20)))",
          }}
        >
          {text}
        </span>
      </div>
    );
  }

  // Non-current rows: single flat div, no frosted panel.
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
        fontWeight: 600,
        lineHeight: 1.25,
        letterSpacing: "-0.01em",
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
  // Yu 2026-09-20 02:15 wanted cross-turn continuity (concat all
  // messages' chunks), and 2026-09-20 10:06 log showed why the
  // 30-chunk sliding limit was WRONG: streaming keeps adding new
  // chunks, and each addition slid the old "好。" chunk from idx=28
  // to 27 to 26 ... because slice(all.length - 30) chased the
  // window head. currentIndex tracked the moving idx correctly
  // (log showed EXACT idx=28,27,26,25,...) but every change fired
  // an effectiveIndex CHANGE which scrolled the filmstrip.
  //
  // Fix: keep the FULL history so chunk indices stay STABLE across
  // deltas. React memo on FilmstripRow + stable indices = subtitle
  // stays put unless the audio pipeline actually advances.
  //
  // Trade-off: memory grows linearly with the session. A long
  // session (say 1000 chunks * 100 chars each) is ~200 KB of
  // strings held in memory. Filmstrip still renders only 5 rows
  // via VISIBLE_RADIUS window — the extra chunks are just Array
  // storage. Acceptable.
  const tailChunks = useMemo(() => {
    const all: string[] = [];
    for (const m of messages) {
      if (m.role !== "assistant" || !m.text) continue;
      for (const c of splitChunks(m.text)) all.push(c);
    }
    return all;
  }, [messages]);

  // Parallel array mapping chunk index → owning assistant message id.
  // Used to find the user question that triggered the currently-
  // playing chunk. Yu 2026-09-20 12:06: fix a user-question pill at
  // top of subtitle view so we always know what question is being
  // answered right now.
  const chunkMessageIds = useMemo(() => {
    const ids: string[] = [];
    for (const m of messages) {
      if (m.role !== "assistant" || !m.text) continue;
      for (const _c of splitChunks(m.text)) ids.push(m.id);
    }
    return ids;
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
    if (!needle) {
      return -1;
    }

    // Priority 1: exact match. This is the normal state — tailChunks
    // has the chunk verbatim, findIndex nails it.
    const exact = tailChunks.findIndex((c) => c === needle);
    if (exact !== -1) {
      return exact;
    }

    // Priority 2: needle IS-A-PREFIX-OF a chunk (chunk is still
    // growing). Yu 2026-09-20 09:58: previous fix scanned backward
    // for ANY startsWith match — but streaming adds new chunks
    // whose openings often coincide with the previous chunk's
    // opener ("好的，" pattern), so the match jumped forward to
    // the newer chunk, then back once it grew past the shared
    // prefix. Bidirectional flicker.
    //
    // Fix: require the chunk to be UNAMBIGUOUSLY needle's growing
    // successor — (a) chunk.startsWith(needle) AND (b) chunk is
    // AT MOST needle.length + 200 chars (chunks generally settle
    // within 200 more chars before the next blank line). Also,
    // the needle itself must be non-trivial (>= 10 chars) so
    // short openers can't cause false matches.
    if (needle.length >= 10) {
      for (let i = tailChunks.length - 1; i >= 0; i--) {
        const c = tailChunks[i];
        if (
          c.startsWith(needle) &&
          c.length <= needle.length + 200 &&
          c.length > needle.length
        ) {
          return i;
        }
      }
    }

    // Priority 3: chunk IS-A-PREFIX-OF needle. This is the rarer
    // case: needle was assembled from a chunk after user played
    // a longer version. Only match when chunk length is close
    // to needle length so we don't grab an early-shortened version.
    for (let i = tailChunks.length - 1; i >= 0; i--) {
      const c = tailChunks[i];
      if (needle.startsWith(c) && c.length >= needle.length - 40) {
        return i;
      }
    }

    return -1;
  }, [tailChunks, currentDisplayText]);

  const displayCurrent =
    currentDisplayText ||
    lastCurrentRef.current ||
    (tailChunks.length > 0 ? tailChunks[tailChunks.length - 1] : "");

  // The user question associated with the currently-playing chunk.
  // Walk messages backward from the owning assistant message id
  // (chunkMessageIds[currentIndex]) to find the immediately-
  // preceding user message. Yu 2026-09-20 12:06: pill fixed at
  // the top of the subtitle view keeps context visible even
  // during long AI replies.
  const currentUserQuestion = useMemo(() => {
    if (currentIndex < 0) return null;
    const owningId = chunkMessageIds[currentIndex];
    if (!owningId) return null;
    const owningIdx = messages.findIndex((mm) => mm.id === owningId);
    if (owningIdx < 0) return null;
    // Scan backward for the nearest user message.
    for (let i = owningIdx - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "user" && m.text) {
        return m.text.trim();
      }
    }
    return null;
  }, [currentIndex, chunkMessageIds, messages]);

  // Effective center index. Yu 2026-09-20 09:55: "streaming 过程里
  // 字幕 queue 会不断增加，增加的时候会导致字幕来回滚动".
  //
  // The old fallback "tailChunks.length - 1" was the flicker
  // culprit: any time currentIndex momentarily dropped to -1
  // (chunk-transition frame in voice-store when currentDisplayText
  // is cleared before the next chunk's is set), effectiveIndex
  // jumped to the growing tail end. As streaming added chunks,
  // that fallback value climbed too, and the filmstrip visibly
  // scrolled downward on every new chunk boundary.
  //
  // Fix: cache the last VALID effectiveIndex in a ref. When
  // currentIndex resolves to -1, reuse the cached one instead of
  // chasing tailChunks.length. Only update when we have a real
  // exact/prefix match.
  const lastEffectiveIndexRef = useRef<number>(0);
  const effectiveIndex = useMemo(() => {
    if (currentIndex >= 0) {
      if (lastEffectiveIndexRef.current !== currentIndex) {
      }
      lastEffectiveIndexRef.current = currentIndex;
      return currentIndex;
    }
    return lastEffectiveIndexRef.current;
  }, [currentIndex]);

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

    // Initial focus. Yu 2026-09-20 11:49: after enlarging the
    // composer via 05f594a, the initial focus grabbed the wrong
    // moment sometimes — either the ChatInput textarea hadn't
    // mounted yet, or React swapped the DOM node during the
    // className change and our cached ref pointed at the stale
    // one. Retry 3x with increasing delays; log each attempt.
    let attempt = 0;
    let initTimer: number | null = null;
    function tryInitFocus() {
      const c = findComposer();
      if (c) {
        c.focus();
        // Verify focus took — sometimes .focus() silently fails on
        // hidden or transitioning elements.
        window.requestAnimationFrame(() => {
          if (document.activeElement !== c && attempt < 3) {
            attempt++;
            initTimer = window.setTimeout(tryInitFocus, 100 * attempt);
          }
        });
      } else if (attempt < 3) {
        attempt++;
        initTimer = window.setTimeout(tryInitFocus, 100 * attempt);
      }
    }
    initTimer = window.setTimeout(tryInitFocus, 0);

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
      if (initTimer !== null) window.clearTimeout(initTimer);
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
            <Headphones size={16} />
          </button>
        </div>
      </header>

      {/* Pinned user-question pill. Yu 2026-09-20 12:06: keeps
          context visible during long replies. Shows the user
          message that triggered whatever chunk is currently
          playing. Hidden when nothing is playing (idle). */}
      {currentUserQuestion && (
        <div className="flex-none px-6 pt-4">
          <div className="mx-auto max-w-4xl rounded-2xl border border-white/10 bg-white/5 px-6 py-3 backdrop-blur">
            <div className="flex items-baseline gap-3">
              <span className="flex-none text-xs font-medium uppercase tracking-widest text-fg-faint">
                • 你问
              </span>
              <span className="line-clamp-2 flex-1 text-lg text-fg-muted sm:text-xl">
                {currentUserQuestion}
              </span>
            </div>
          </div>
        </div>
      )}

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
