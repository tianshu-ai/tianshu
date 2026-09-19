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
// speak() exactly once per newly completed assistant reply.
//
// Detection rule (deliberately simple):
//
//   A reply is "newly completed" when the last message in the
//   messages array satisfies:
//     - role === "assistant"
//     - id !== the id we last spoke
//     - isStreaming === false
//     - content is a non-empty string
//
// Why check id rather than a boolean flag: the store already tracks
// each message by id, and we want the spoken audio to line up with
// exactly one bubble — including the case where the same assistant
// content later gets edited/retried (new id, new audio).
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

import { useEffect, useRef } from "react";
import { useChatStore } from "../stores/chat-store";
import { useVoiceMode } from "./useVoiceMode";
import { useTts } from "./useTts";

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
  const { speak, stop } = useTts();

  // Track the last message id we successfully asked to speak.
  // Persist across renders via ref rather than state — we don't
  // want to re-render when this changes.
  const lastSpokenIdRef = useRef<string | null>(null);

  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);

  useEffect(() => {
    // If the user turned voice mode off mid-playback, cut the audio.
    if (!enabled) {
      stop();
      return;
    }

    // Only speak when streaming finished — otherwise we'd speak
    // partial assistant text every render.
    if (isStreaming) return;

    const last = messages[messages.length - 1];
    if (!last) return;
    if (last.role !== "assistant") return;
    if (last.id === lastSpokenIdRef.current) return;
    // WireMessage.text is the human-readable body. Tool-only turns
    // have empty text; skip those — nothing to speak.
    if (typeof last.text !== "string" || !last.text.trim()) return;

    const spoken = textForSpeech(last.text);
    if (!spoken) return;

    // Reserve the id BEFORE the async speak() so a rapid re-render
    // during network fetch doesn't double-fire.
    lastSpokenIdRef.current = last.id;

    // Fire and forget. speak() rejects on network / decode errors;
    // we log but don't disrupt the chat UI — voice is an enhancement.
    speak(spoken).catch((err) => {
      console.warn("[voice] auto-speak failed:", err);
    });
  }, [enabled, isStreaming, messages, speak, stop]);
}
