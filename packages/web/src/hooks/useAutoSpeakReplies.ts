// Auto-speak assistant replies when voice mode is on.
//
// Yu, 2026-09-19: added in feat/voice-conversation-mode. This is the
// glue between:
//   - useVoiceMode: whether the user wants voice replies at all
//   - useTts: playback plumbing (fetch /api/tts, HTMLAudioElement)
//   - useChatStore: source of truth for "did a new assistant message
//                   just complete?"
//
// Sits at the ChatArea level, subscribes to the store, and fires
// speak() once per assistant message that appears AFTER voice mode
// turns on.
//
// Detection rule:
//
//   We track a set of assistant-message ids we've already spoken.
//   Each render, we walk the messages array and speak any assistant
//   message that:
//     - has non-empty text
//     - has an id not in the spoken set
//
//   The spoken set is seeded on first pass with the current
//   assistant messages so pre-existing history isn't read out.
//
// Why NOT gate on isStreaming: Yu 2026-09-19 21:21 pointed out
// that multi-step replies (assistant text → tool call → assistant
// text → tool call → final assistant text) only spoke the last
// segment. Root cause: for the full multi-step turn, isStreaming
// stays true — there's no false window between the intermediate
// assistant messages and the next tool call. Tracking the id set
// directly means each new assistant bubble triggers speak() as it
// appears, regardless of whether the turn is still in flight.
//
// This does mean a partial (streaming) assistant message could
// trigger speak() as its id first appears — but WireMessage.text
// is only populated on stream chunks with content; empty-text
// intermediate frames get skipped. If we see "partial-text" audio
// artefacts in practice we can add a "minimum text length" or
// "debounce until text stops growing" guard.
//
// Why not subscribe to stream_end events directly: keeping the
// dependency on useChatStore matches how the rest of the UI reads
// state; means we auto-work with any future paths that append an
// assistant message (edited replies, replayed transcript, etc.)
// without wiring more event listeners.
//
// Text sanitisation: we strip markdown syntax before speaking so
// the TTS doesn't read "star star hello star star" for **hello**.
// Kept minimal — just the common markers. If replies contain lots
// of URLs or code, we may want to expand this later.

import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../stores/chat-store";
import { useVoiceStore } from "../stores/voice-store";
import { useVoiceMode } from "./useVoiceMode";

/**
 * Fetch a single user preference. Returns null when unset or the
 * request fails — we deliberately swallow errors here because
 * preference reads shouldn't disrupt the chat UI.
 */
async function readPreference(key: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/preferences/${encodeURIComponent(key)}`, {
      credentials: "include",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { value?: string | null };
    return typeof body?.value === "string" ? body.value : null;
  } catch {
    return null;
  }
}

/**
 * `<silent>...</silent>` marks a portion of the assistant reply that
 * should be VISIBLE on screen but NOT spoken by TTS.
 *
 * Yu, 2026-09-19 22:28: switched from a voice_summary opt-in tag to
 * this opt-out tag. "写篇文章念给我听" needs the whole reply spoken,
 * not a summary. Default is speak-everything; the LLM only wraps
 * bits that don't translate to speech (code, URLs, hashes, etc.).
 *
 * Case-insensitive; matches non-greedy so multiple silenced regions
 * in one reply each get stripped independently.
 *
 * Handles two open-ended forms so mid-stream text (before the closer
 * arrives) also drops correctly:
 *   1. `<silent>body</silent>` — complete tag, both spans stripped
 *   2. `<silent>body...`         — unclosed tag at end of stream, drop
 *      from the opener onward. The audio pipeline runs off the final
 *      text so unclosed tags only exist mid-stream, and by
 *      auto-play time (end of streaming) we get form 1.
 */
const SILENT_CLOSED_RE = /<silent>[\s\S]*?<\/silent>/gi;
const SILENT_UNCLOSED_TAIL_RE = /<silent>[\s\S]*$/i;

/**
 * Remove every <silent>...</silent> region from a piece of assistant
 * text. What's left is the intended spoken content.
 *
 * Exported so MessageBubble's per-message play button can share it —
 * both auto-speak and manual play speak identical audio.
 */
export function stripSilent(text: string): string {
  return text.replace(SILENT_CLOSED_RE, "").replace(SILENT_UNCLOSED_TAIL_RE, "");
}

/**
 * Emoji + pictographic character regex.
 *
 * Yu, 2026-09-19 22:48: "图片、emoji 之类的内容就不应该念出来".
 * Emoji get "grinning face" or nothing at all read from most TTS
 * engines, either way not what the user wants.
 *
 * Covers the Unicode ranges that render as pictographs:
 *   - Emoticons                       U+1F600 – U+1F64F
 *   - Misc Symbols and Pictographs    U+1F300 – U+1F5FF
 *   - Transport and Map Symbols       U+1F680 – U+1F6FF
 *   - Regional Indicator (flags)      U+1F1E6 – U+1F1FF
 *   - Supplemental Symbols and Pict.  U+1F900 – U+1F9FF
 *   - Symbols and Pictographs Ext-A   U+1FA70 – U+1FAFF
 *   - Miscellaneous Symbols           U+2600  – U+26FF
 *   - Dingbats                        U+2700  – U+27BF
 *   - Variation selectors + ZWJ       U+FE00–U+FE0F, U+200D
 *
 * Uses the `u` flag so surrogate-pair emoji are matched as a single
 * unit rather than half-and-half.
 */
const EMOJI_RE =
  /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]/gu;

/**
 * Strip common markdown markers AFTER silent regions have been
 * removed. Not a full markdown parser — just enough to avoid the
 * worst "star star" / "hash hash" reading artefacts on the content
 * that IS being spoken.
 *
 * Also strips emoji and image references so TTS reads clean text
 * without "grinning face" or an alt text alone in the audio.
 */
function stripMarkdown(md: string): string {
  return (
    md
      // image markdown ![alt](url) — drop entirely; alt text alone
      // is not useful in audio and reading a URL is worse
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      // fenced code blocks: replace with a single spoken hint. In
      // voice mode tianshu is expected to <silent>-wrap code blocks,
      // but be defensive in case a block leaks through.
      .replace(/```[\s\S]*?```/g, "。代码块。")
      // inline code: drop backticks, keep content
      .replace(/`([^`]+)`/g, "$1")
      // bold / italic markers
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      // markdown links [text](url) → text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // raw URLs on their own — speak nothing; embedded URLs inside
      // sentences also get stripped, which is desirable in audio
      .replace(/https?:\/\/\S+/g, "")
      // heading hashes at line start
      .replace(/^#{1,6}\s+/gm, "")
      // list bullet markers at line start
      .replace(/^[-*+]\s+/gm, "")
      .replace(/^\d+\.\s+/gm, "")
      // emoji + variation selectors + ZWJ joiners: drop entirely
      .replace(EMOJI_RE, "")
      // collapse whitespace
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Given raw assistant text, return the string TTS should read.
 * Removes <silent>...</silent> regions first (whether closed mid-
 * text or unclosed at the tail), then strips visual markdown.
 */
export function spokenTextFor(md: string): string {
  return stripMarkdown(stripSilent(md));
}

/**
 * Sentence-boundary regex.
 *
 * Matches at the END of a sentence — the char AFTER the terminator.
 * Chinese full-width punct (。！？) doesn't need whitespace to end
 * a sentence; ASCII (. ! ?) requires whitespace or newline right
 * after to avoid mis-splitting on decimals / URLs / abbreviations.
 * Double newlines also end a paragraph regardless of terminators.
 *
 * Yu, 2026-09-19 22:36: streaming auto-speak walks assistant text
 * as it grows, extracts completed sentences via this regex, and
 * enqueues each. Result: TTS starts within one sentence of the
 * first word arriving, not after the whole reply finishes.
 */
const SENTENCE_END_RE = /(?:[。！？]|[.!?](?=\s|$)|\n\n)/g;

/**
 * Find the end index (exclusive) of the last complete sentence in
 * `text` starting from `from`. Returns null if no complete sentence
 * is available yet — caller should wait for more text.
 *
 * "Complete" means: sentence terminator present AND not inside an
 * unclosed `<silent>` block starting after `from`. If an unclosed
 * silent tag opens before the last terminator, the last terminator
 * before the unclosed tag counts — we don't split MID silent block.
 */
function findLastCompleteSentenceEnd(
  text: string,
  from: number,
): number | null {
  if (from >= text.length) return null;
  const region = text.slice(from);

  // Detect an unclosed <silent> in the region. If present, anything
  // after its opener is ineligible for slicing until the closer
  // arrives.
  const openIdx = region.search(/<silent>/i);
  const closeIdx = region.search(/<\/silent>/i);
  let ceiling = region.length;
  if (openIdx !== -1) {
    if (closeIdx === -1 || closeIdx < openIdx) {
      // Unclosed silent tag — sentences after the opener are
      // ineligible. Ceiling = opener position.
      ceiling = openIdx;
    }
  }

  // Find the LAST sentence terminator inside [0, ceiling).
  let lastEnd: number | null = null;
  SENTENCE_END_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_END_RE.exec(region)) !== null) {
    const end = m.index + m[0].length;
    if (end > ceiling) break;
    lastEnd = end;
  }
  if (lastEnd == null) return null;
  return from + lastEnd;
}

export function useAutoSpeakReplies() {
  const { enabled } = useVoiceMode();
  const enqueue = useVoiceStore((s) => s.enqueue);
  const stop = useVoiceStore((s) => s.stop);

  // Streaming sentence cursor: for each assistant message id, how
  // many characters of its speechSource we've already enqueued.
  // Set on seed to the full length of every current assistant
  // message so pre-existing history isn't spoken.
  const cursorRef = useRef<Map<string, number>>(new Map());
  const seededRef = useRef(false);

  // Cached user preferences for TTS provider + voice. Read once
  // when voice mode turns on; re-fetched when the user toggles it
  // (which is when they'd typically go to Settings to reconfigure
  // anyway). Kept in state rather than ref so useEffect can
  // observe them; but we don't want them in the trigger dep array
  // because we only want to speak on message change, not on prefs
  // load.
  const [ttsProvider, setTtsProvider] = useState<string | null>(null);
  const [ttsVoice, setTtsVoice] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      const [p, v] = await Promise.all([
        readPreference("tts.provider"),
        readPreference("tts.voice"),
      ]);
      if (cancelled) return;
      setTtsProvider(p);
      setTtsVoice(v);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);

  useEffect(() => {
    // If the user turned voice mode off mid-playback, cut the audio.
    // Also reset the seed so re-enabling voice mode later won't
    // replay whatever's already on screen.
    if (!enabled) {
      stop();
      seededRef.current = false;
      cursorRef.current = new Map();
      return;
    }

    // Defer seed until history has landed — first mount often sees
    // messages=[] before the WS finishes streaming history.
    if (!seededRef.current) {
      if (messages.length === 0) return;
      for (const m of messages) {
        if (m.role !== "assistant") continue;
        const src = m.text ?? "";
        // Seed cursor at the end so nothing existing is spoken.
        cursorRef.current.set(m.id, src.length);
      }
      seededRef.current = true;
      return;
    }

    // Streaming per-sentence enqueue. Only track the LAST assistant
    // message; historical messages are pre-seeded (cursor=length)
    // to avoid re-speaking on refresh AND to avoid re-slicing when
    // the server swaps the streaming placeholder id for a persistent
    // id at stream_end (Yu 2026-09-19 23:10: log showed the story
    // arrived twice — once as streaming id `ming__...`, then
    // instantly again as persistent id `c114a3...` from cursor 0,
    // duplicating enqueues and thrashing the audio queue).
    //
    // For the current tail message:
    //   - Look up cursor (0 for new messages, previous slice end
    //     otherwise)
    //   - Find the last complete sentence terminator from cursor
    //   - If found: extract [cursor → terminator], enqueue, advance
    //   - Else if !isStreaming: flush remaining as a final slice
    //   - Else: no complete sentence yet, wait for next delta
    //
    // When a new tail message id appears (persistent id swap or a
    // new turn), we mark all prior ids as "already done" (cursor at
    // their full length) so they don't re-slice. This is what the
    // seed pass on line above already does for pre-existing history.
    const tail = messages[messages.length - 1];
    if (tail && tail.role === "assistant") {
      // Handle the placeholder → persistent id swap that server does
      // on stream_end. Yu 2026-09-19 23:14 log:
      //   ming__ streams to 243 chars, slices 12 sentences
      //   THEN persistent id 9b5d3b appears with the same 243 chars
      //   fresh cursorRef entry for 9b5d3b starts at 0
      //   → re-slices the whole story as one giant slice
      //
      // Detection: if we've never seen this tail id AND there's
      // another assistant message with matching text prefix (the
      // placeholder we've been slicing), inherit its cursor.
      if (!cursorRef.current.has(tail.id)) {
        const tailText = tail.text ?? "";
        let inheritedCursor: number | null = null;
        for (const other of messages) {
          if (other.role !== "assistant" || other.id === tail.id) continue;
          const otherText = other.text ?? "";
          const otherCursor = cursorRef.current.get(other.id);
          if (otherCursor == null) continue;
          // Same-prefix match: the persistent row's text starts with
          // (or IS) the placeholder's text up to the placeholder's
          // cursor. Handles both "same content, swap id at end" and
          // "placeholder was fully sliced but stream added a bit
          // more before persist".
          const commonLen = Math.min(otherText.length, tailText.length);
          if (
            commonLen > 0 &&
            otherText.slice(0, commonLen) === tailText.slice(0, commonLen)
          ) {
            inheritedCursor = Math.max(
              inheritedCursor ?? 0,
              Math.min(otherCursor, tailText.length),
            );
          }
        }
        if (inheritedCursor != null) {
          cursorRef.current.set(tail.id, inheritedCursor);
        }

        // Regardless of inheritance, mark every OTHER assistant
        // message as "done" so a re-render doesn't re-slice them.
        for (const other of messages) {
          if (other.role === "assistant" && other.id !== tail.id) {
            const src = other.text ?? "";
            cursorRef.current.set(other.id, src.length);
          }
        }
      }
    }

    for (const m of messages) {
      if (m.role !== "assistant") continue;
      // Only slice the LAST assistant message. Historical ones are
      // seeded above to cursor=length so this check is a no-op for
      // them, but keep it explicit so the intent is obvious.
      if (m !== tail) continue;
      const src = m.text ?? "";
      if (!src.trim()) continue;
      const cursor = cursorRef.current.get(m.id) ?? 0;
      if (cursor >= src.length) continue;

      let sliceEnd = findLastCompleteSentenceEnd(src, cursor);

      // Flush any trailing text as a final slice once streaming for
      // the whole turn has settled (isStreaming false). Otherwise we
      // wait for more text to arrive or a terminator to close the
      // in-progress sentence.
      if (sliceEnd == null && !isStreaming) {
        sliceEnd = src.length;
      }
      if (sliceEnd == null || sliceEnd <= cursor) {
        // Diagnostic (Yu 2026-09-19 22:55, chase-down for skipped
        // content in streaming voice). Log why we're NOT slicing so
        // we can see if cursor got ahead of text or terminator search
        // failed.
        console.log(
          `[voice] no-slice id=${m.id.slice(-6)} cursor=${cursor} ` +
            `len=${src.length} isStreaming=${isStreaming} ` +
            `sliceEnd=${sliceEnd}`,
        );
        continue;
      }

      const raw = src.slice(cursor, sliceEnd);
      const spoken = spokenTextFor(raw);
      const prevCursor = cursor;
      cursorRef.current.set(m.id, sliceEnd);

      // Diagnostic: show every slice we take, with raw and spoken
      // lengths so we can see if stripSilent/stripMarkdown ate more
      // than expected. Uses console.log (not debug) because Chrome
      // hides debug level by default and Yu didn't see the earlier
      // logs (2026-09-19 23:06).
      console.log(
        `[voice] slice id=${m.id.slice(-6)} ` +
          `[${prevCursor}..${sliceEnd}] rawLen=${raw.length} ` +
          `spokenLen=${spoken.length} spoken=${JSON.stringify(spoken.slice(0, 40))}`,
      );

      if (!spoken) continue;

      enqueue({
        // Each slice needs a unique id so the store's playingId can
        // reflect the currently-playing slice — but the UI's
        // per-bubble button watches only the message id, so we keep
        // the message id as prefix for observability without
        // colliding on repeat plays.
        id: `${m.id}#${cursor}`,
        text: spoken,
        provider: ttsProvider ?? undefined,
        voice: ttsVoice ?? undefined,
      });
    }
    // ttsProvider/ttsVoice deliberately NOT in deps — a pref refresh
    // should NOT re-fire on old slices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, isStreaming, messages, enqueue, stop]);
}
