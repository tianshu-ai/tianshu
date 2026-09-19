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
 * Strip common markdown markers so TTS reads text naturally.
 * Not a full markdown parser — just enough to avoid the worst
 * "star star" / "hash hash" reading artefacts.
 */
function textForSpeech(md: string): string {
  return (
    md
      // fenced code blocks: replace with a single spoken hint
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
      // heading hashes at line start
      .replace(/^#{1,6}\s+/gm, "")
      // list bullet markers at line start
      .replace(/^[-*+]\s+/gm, "")
      .replace(/^\d+\.\s+/gm, "")
      // collapse whitespace
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function useAutoSpeakReplies() {
  const { enabled } = useVoiceMode();
  // Route through the global voice store so auto-speak and the
  // per-bubble play buttons share a single audio element —
  // playing a manual message stops any auto-play in flight and
  // vice versa. Yu, 2026-09-19 21:40.
  const play = useVoiceStore((s) => s.play);
  const stop = useVoiceStore((s) => s.stop);

  // Track the last message id we successfully asked to speak.
  // Persist across renders via ref rather than state — we don't
  // want to re-render when this changes.
  //
  // Yu, 2026-09-19 21:06: bug — first mount with an existing chat
  // history would fire speak() on the pre-existing tail message
  // ("刷新以后会自动播放最新的那个消息"). Fix: seed the ref
  // with the current tail on mount so only messages that arrive
  // AFTER voice mode is on trigger playback. Bootstrap flag makes
  // that one-time initialisation observable to the effect.
  const spokenIdsRef = useRef<Set<string>>(new Set());
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
      spokenIdsRef.current = new Set();
      return;
    }

    // On first pass with voice mode on, mark every current
    // assistant message as "already spoken" so historical replies
    // that predate the toggle aren't read out.
    //
    // Yu, 2026-09-19 21:24: page refresh regression — first mount
    // sees messages=[] (store still loading history), so the seed
    // recorded an empty set. When history landed a moment later,
    // every assistant message looked "new" and got spoken.
    //
    // Fix: don't seed when the array is empty; wait for the first
    // non-empty snapshot and seed off THAT. New assistant messages
    // arriving after seed still trigger speak() because they land
    // in a later effect run, by which point seededRef is true.
    //
    // Edge case: if voice mode is toggled on in a truly empty
    // session (no history at all, no messages ever sent), the
    // seed is deferred until the first message arrives. That's
    // fine — the first message will be the user's own prompt,
    // which we mark as spoken (only assistant ids are added, so
    // it's a no-op) and then the first assistant reply is
    // correctly identified as new.
    if (!seededRef.current) {
      if (messages.length === 0) return;
      for (const m of messages) {
        if (m.role === "assistant") spokenIdsRef.current.add(m.id);
      }
      seededRef.current = true;
      return;
    }

    // Walk the array, speak any assistant message whose id isn't
    // in the spoken set. Fire them in order so multi-step replies
    // are voiced in the order they appear on screen.
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      if (spokenIdsRef.current.has(m.id)) continue;
      if (typeof m.text !== "string" || !m.text.trim()) continue;

      const spoken = textForSpeech(m.text);
      if (!spoken) continue;

      // Reserve the id BEFORE the async speak() so a re-render
      // during network fetch doesn't double-fire on the same id.
      spokenIdsRef.current.add(m.id);

      // Fire and forget. play() rejects on network / decode errors;
      // we log but don't disrupt the chat UI — voice is an enhancement.
      play({
        id: m.id,
        text: spoken,
        provider: ttsProvider ?? undefined,
        voice: ttsVoice ?? undefined,
      }).catch((err) => {
        console.warn("[voice] auto-speak failed:", err);
      });
    }
    // ttsProvider/ttsVoice deliberately NOT in deps — a pref refresh
    // should NOT re-fire speak on a message that was already spoken.
    // isStreaming intentionally dropped — tracking a spoken-id set
    // decouples us from the stream_start/stream_end lifecycle, which
    // stays true across an entire multi-step turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, messages, play, stop]);
}
