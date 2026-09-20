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
 * Blank-line boundary regex.
 *
 * Yu, 2026-09-20 00:03: abandoned <chunk> tag approach after
 * repeated evidence that opus-class models ignore the instruction
 * to wrap EVERY sentence — log showed 1 tag at the opener then
 * 200+ chars of un-wrapped prose. Instead we lean into the fact
 * that markdown output NATURALLY separates paragraphs with blank
 * lines: the system prompt now tells tianshu to keep 1-2 sentences
 * per paragraph, and we slice on blank-line boundaries here.
 *
 * The regex matches ONE OR MORE blank lines (possibly containing
 * whitespace). A blank line = \n\n at minimum. Matching \n\s*\n
 * tolerates a stray space in the empty line.
 *
 * Streaming safety: we only slice when a paragraph is BOUNDED on
 * BOTH sides — either preceded by a blank-line separator (or
 * cursor start) AND followed by a blank line. An unbounded
 * paragraph (still being streamed) is left for the next delta.
 */
const BLANK_LINE_RE = /\n\s*\n/g;

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

  // Last-tail snapshot for detecting placeholder → persistent id
  // swaps. Yu 2026-09-19 23:17: the earlier prefix-search fix
  // failed because at swap time the server had already removed
  // the placeholder row from messages[]; we couldn't find it to
  // read its cursor. Snapshot the tail here across renders so the
  // swap detector always has the previous state to compare.
  const lastTailIdRef = useRef<string | null>(null);
  const lastTailTextRef = useRef<string>("");

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

  // Track the most-recent user-message id so we can detect when a
  // NEW user turn starts (Yu 2026-09-20 11:11: sending another
  // message mid-playback means "interrupt current reply, jump to
  // the new one"). Ref so it doesn't trigger extra effect fires.
  const lastUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    // If the user turned voice mode off mid-playback, cut the audio.
    // Also reset the seed so re-enabling voice mode later won't
    // replay whatever's already on screen.
    if (!enabled) {
      stop();
      seededRef.current = false;
      cursorRef.current = new Map();
      lastUserIdRef.current = null;
      return;
    }

    // Detect user-initiated interruption: a NEW user message id
    // appears at the tail of messages. That means Yu sent a
    // follow-up while audio was still playing the previous reply.
    // Stop everything and let the new reply's chunks stream in
    // fresh via the slice loop below.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "user") continue;
      // We only care about the newest user message. If it's the
      // same as we already saw, nothing to do.
      if (lastUserIdRef.current !== m.id) {
        // First seed run: don't stop anything, just record.
        // Subsequent user-id changes DURING playback: stop audio
        // + flush queue so the new reply starts talking
        // immediately when its first chunk arrives.
        if (lastUserIdRef.current !== null && seededRef.current) {
          stop();
        }
        lastUserIdRef.current = m.id;
      }
      break;
    }

    // Defer seed until history has landed — first mount often sees
    // messages=[] before the WS finishes streaming history.
    //
    // Yu 2026-09-20 01:33 "还有的时候会把前一两句跳掉":
    // if the component mounts (or re-mounts — e.g. voice toggle
    // swaps ChatArea ↔ VoiceSubtitleView) mid-stream, the tail
    // assistant message already has 1-2 sentences buffered.
    // Seeding cursor=length there means those first sentences
    // never get sliced/enqueued.
    //
    // Fix: streaming tail seeds to 0 (speak from start); everything
    // else seeds to length (skip existing history).
    if (!seededRef.current) {
      if (messages.length === 0) return;
      let lastAssistantIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
          lastAssistantIdx = i;
          break;
        }
      }
      // Yu 2026-09-20 02:00 log confirmed: second-message seeding
      // hits the else branch (isStreaming was still FALSE at seed
      // time) even though tail was actively streaming. The delta
      // arrives before the store finishes flipping isStreaming to
      // true, so relying on it as the sole gate is racy.
      //
      // Fix: treat the LAST assistant message as "streaming from
      // start" whenever it's short enough to plausibly be brand-
      // new. 100 chars threshold: shorter than any real prior
      // reply that the user would've fully read, so no risk of
      // re-speaking historical text; longer than the first-delta
      // burst (typically 20-60 chars) that races isStreaming.
      const NEW_TAIL_LEN_THRESHOLD = 100;
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role !== "assistant") continue;
        const src = m.text ?? "";
        const isTail = i === lastAssistantIdx;
        // Tail is "new / streaming" when either:
        //   - the store already flipped isStreaming to true, or
        //   - the message is short enough that it can only be a
        //     freshly-started reply (below the threshold)
        const looksNew =
          isTail && (isStreaming || src.length < NEW_TAIL_LEN_THRESHOLD);
        if (looksNew) {
          cursorRef.current.set(m.id, 0);
        } else {
          cursorRef.current.set(m.id, src.length);
        }
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
      // Placeholder → persistent id swap on stream_end.
      //
      // Yu 2026-09-19 23:17 log showed the earlier fix (f17a5dc)
      // failed because at swap time the server REMOVED the
      // placeholder row from messages[] and inserted the persistent
      // row — they didn't coexist. Looking at
      // `messages[].id` couldn't find the placeholder because it
      // was gone. Slice started from cursor=0 on 3c9497 and
      // re-spoke 408 chars of story.
      //
      // Fix: track the LAST tail id we sliced against (lastTailIdRef)
      // and its cursor. When tail.id changes AND we've never seen
      // the new id AND the new tail's text starts with the last
      // placeholder's sliced prefix, inherit the cursor. This works
      // regardless of whether the placeholder still exists in
      // messages[] — we keep the reference across renders.
      if (!cursorRef.current.has(tail.id)) {
        const tailText = tail.text ?? "";
        let inheritedCursor: number | null = null;

        // Check the immediately-previous tail id, if any. This is
        // the placeholder in almost every case.
        // Only treat as id-swap when previous tail text is a REAL
        // prefix of the new tail text ("server renamed the id").
        // A stale prevText from an earlier settled reply happens
        // to share an opener like "好的，" is NOT a swap — those
        // are new independent replies. Require the prev's ENTIRE
        // text to appear as a prefix of the new tail (and non-
        // trivially long).
        //
        // Yu 2026-09-20 11:30 "tool 前第一句不念":
        // when tianshu says a SHORT sentence (e.g. "让我搜一下 ACP
        // 的 RPT 模型。" ~19 chars) then calls a tool,
        // STREAMING_ID gets replaced by a persisted message id in
        // chat-store. Previously the 20-char threshold rejected
        // this as "not a swap" and inherited cursor=0, but by then
        // isStreaming had flipped to false and the trailing region
        // wasn't flushed either. Lowered threshold to 4 chars —
        // still filters out coincidental "好的" openers across
        // truly separate replies while catching the short-swap case.
        const SWAP_MIN_PREV_LEN = 4;
        const prevId = lastTailIdRef.current;
        if (prevId && prevId !== tail.id) {
          const prevText = lastTailTextRef.current;
          const prevCursor = cursorRef.current.get(prevId);
          if (
            prevCursor != null &&
            prevText.length >= SWAP_MIN_PREV_LEN &&
            tailText.length >= prevText.length &&
            tailText.slice(0, prevText.length) === prevText
          ) {
            inheritedCursor = prevCursor;
          }
        }

        // Fallback: check other current-messages assistant rows in
        // case the store keeps both rows around briefly during swap.
        //
        // Yu 2026-09-20 01:49 "第一次发消息，语音回复都正常，
        // 继续发消息，回复就会跳过几个 chunk":
        // this fallback was matching UNRELATED messages by their
        // short common opening (“好的，” “让我” etc.), then
        // treating them as an id-swap and inheriting the other
        // message's fully-played cursor. Result: new reply's opening
        // chunks got seeded past.
        //
        // Fix: require a substantial common prefix (>= 20 chars),
        // AND require the OTHER text to be substantially longer
        // than tail (otherwise it's not a placeholder-→-persistent
        // swap; it's a genuinely new reply that happens to share
        // an opener). Only real id-swaps satisfy both.
        const SWAP_MIN_COMMON_PREFIX = 4;
        if (inheritedCursor == null) {
          for (const other of messages) {
            if (other.role !== "assistant" || other.id === tail.id) continue;
            const otherText = other.text ?? "";
            const otherCursor = cursorRef.current.get(other.id);
            if (otherCursor == null) continue;
            // Real swaps have the placeholder's full text as a
            // prefix of the new tail's text (server just renamed
            // the id). Threshold reduced to 4 chars (2026-09-20
            // 11:30) to catch short opening sentences before tool
            // calls.
            if (otherText.length < SWAP_MIN_COMMON_PREFIX) continue;
            if (otherText.length > tailText.length) continue;
            if (tailText.slice(0, otherText.length) !== otherText) continue;
            inheritedCursor = Math.max(
              inheritedCursor ?? 0,
              Math.min(otherCursor, tailText.length),
            );
          }
        }

        cursorRef.current.set(tail.id, inheritedCursor ?? 0);

        // Log the inheritance decision so we can see it working.

        // Mark every OTHER current assistant row as done so a
        // re-render doesn't re-slice them.
        for (const other of messages) {
          if (other.role === "assistant" && other.id !== tail.id) {
            const src = other.text ?? "";
            cursorRef.current.set(other.id, src.length);
          }
        }

        // Yu 2026-09-20 02:11 log confirmed: server REUSES the
        // same placeholder id ("ming__") for consecutive replies.
        // A stale cursor for that id survives from the previous
        // reply's pre-swap position (typically ~470), so slicing
        // on the SECOND reply starts from 470 and skips the first
        // 470 chars.
        //
        // The current-messages sweep above handles this-tick's
        // other rows. This block handles the PREVIOUS tail id
        // that already vanished from messages[] before this
        // effect run — wipe its cursor so a future reuse of
        // that id starts fresh from 0.
        //
        // Yu 2026-09-20 11:39 log: BEFORE wiping, flush the prev
        // tail's un-played TRAILING region as a final chunk. Log
        // showed the pre-tool short sentence ("让我搜一下 ACP 的
        // RPT 模型。") got a tail-swap from placeholder→persistent
        // id `d63453`, cursor sat at 0 len 35 with isStreaming=true
        // so trailing-flush wouldn't fire, then a NEW placeholder
        // took over and the d63453 row was abandoned with its
        // opening sentence never sliced.
        //
        // Prev tail is being abandoned by definition (tail.id
        // changed). Its text won't grow further — whatever's past
        // its cursor is a complete final chunk. Flush it.
        if (prevId && prevId !== tail.id) {
          const prevCursor = cursorRef.current.get(prevId) ?? 0;
          const prevMsg = messages.find((mm) => mm.id === prevId);
          const prevText = prevMsg?.text ?? lastTailTextRef.current ?? "";
          if (prevCursor < prevText.length) {
            const trailingText = prevText.slice(prevCursor).trim();
            if (trailingText.length > 0) {
              const spoken = spokenTextFor(trailingText);
              if (spoken) {
                enqueue({
                  id: `${prevId}#${prevCursor}`,
                  text: spoken,
                  displayText: trailingText,
                  provider: ttsProvider ?? undefined,
                  voice: ttsVoice ?? undefined,
                });
              }
              // Yu 2026-09-20 11:53 log "有消息念两遍":
              // when prev is a placeholder → persistent id swap
              // (server just renamed the row), the NEW tail's text
              // is the SAME content we just flushed. Without seeding
              // the new tail's cursor to length, the slice-loop
              // below picks up the same content again, enqueues it,
              // and TTS plays it twice.
              //
              // Only do this when new tail's text starts with prev's
              // full text — that's the placeholder-swap signature.
              // A truly new reply won't match this and slice-loop
              // continues normally.
              const newTailText = tail.text ?? "";
              if (
                prevText.length > 0 &&
                newTailText.length >= prevText.length &&
                newTailText.slice(0, prevText.length) === prevText
              ) {
                cursorRef.current.set(tail.id, prevText.length);
              }
            }
          }
          cursorRef.current.delete(prevId);
        }
      }

      // Snapshot the tail state AFTER we've handled any swap so
      // the NEXT swap can look back at this tail's final state.
      const prevTailId = lastTailIdRef.current;
      const prevTailLen = lastTailTextRef.current.length;
      const newTailLen = (tail.text ?? "").length;
      if (prevTailId !== tail.id) {
      }
      lastTailIdRef.current = tail.id;
      lastTailTextRef.current = tail.text ?? "";
    }

    for (const m of messages) {
      if (m.role !== "assistant") continue;
      if (m !== tail) continue;
      const src = m.text ?? "";
      if (!src.trim()) continue;
      const cursor = cursorRef.current.get(m.id) ?? 0;
      // Yu 2026-09-20 11:35 debug: log every slice-loop entry so
      // we see the exact cursor / len / isStreaming state each tick.
      if (cursor >= src.length) continue;

      // Slice on blank-line boundaries. Find every blank line from
      // cursor onward; each region between blank lines (and between
      // cursor and the FIRST blank line) is one chunk. A trailing
      // region with no closing blank line is left for the next
      // delta unless streaming has ended — then flush it as final.
      BLANK_LINE_RE.lastIndex = cursor;
      let regionStart = cursor;
      let anyMatch = false;
      let lastEnd = cursor;
      let m2: RegExpExecArray | null;
      while ((m2 = BLANK_LINE_RE.exec(src)) !== null) {
        const chunkText = src.slice(regionStart, m2.index);
        const chunkEnd = m2.index + m2[0].length;
        const trimmed = chunkText.trim();
        if (trimmed.length > 0) {
          anyMatch = true;
          const spoken = spokenTextFor(chunkText);
          if (spoken) {
            enqueue({
              id: `${m.id}#${regionStart}`,
              text: spoken,
              // displayText for subtitle view: use the trimmed raw
              // chunk (still readable markdown) so on-screen shows
              // the same paragraph the TTS is reading.
              displayText: trimmed,
              provider: ttsProvider ?? undefined,
              voice: ttsVoice ?? undefined,
            });
          }
        }
        lastEnd = chunkEnd;
        regionStart = chunkEnd;
      }

      // Trailing region past the last blank line. Only flush when
      // streaming has ended — otherwise it's likely still growing.
      if (!isStreaming && regionStart < src.length) {
        const chunkText = src.slice(regionStart);
        const trimmed = chunkText.trim();
        if (trimmed.length > 0) {
          anyMatch = true;
          const spoken = spokenTextFor(chunkText);
          if (spoken) {
            enqueue({
              id: `${m.id}#${regionStart}`,
              text: spoken,
              displayText: trimmed,
              provider: ttsProvider ?? undefined,
              voice: ttsVoice ?? undefined,
            });
          }
          lastEnd = src.length;
        }
      }

      if (anyMatch) {
        cursorRef.current.set(m.id, lastEnd);
      } else {
      }
    }
    // ttsProvider/ttsVoice deliberately NOT in deps — a pref refresh
    // should NOT re-fire on old slices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, isStreaming, messages, enqueue, stop]);
}
