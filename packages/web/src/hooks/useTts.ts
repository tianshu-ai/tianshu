// TTS playback hook.
//
// Yu, 2026-09-19: added in feat/voice-conversation-mode. Sits on
// top of the /api/tts server route (which forwards to CosyVoice 2
// locally). Exposes:
//
//   const { speak, stop, isSpeaking } = useTts();
//   await speak("你好，天枢。");
//
// Design:
//
//   - One shared HTMLAudioElement per hook instance. We reuse it
//     rather than creating a new Audio() per utterance to keep
//     browser resource use bounded and let stop() work reliably.
//
//   - speak(text) is a promise that resolves when playback finishes
//     (or rejects on network / decode error). Callers can await it
//     to sequence multiple utterances without overlap.
//
//   - stop() cancels the current playback and any queued fetch.
//     Useful when the user disables voice mode mid-reply or when a
//     new assistant message arrives before the previous one finished.
//
//   - We hold ONE AbortController per pending fetch so we don't
//     leak network requests when the user rapidly toggles voice
//     mode.
//
//   - The fetched audio is loaded as an object URL. We revoke it
//     after playback (or on stop) to keep the blob URL table
//     shallow — Safari especially cares about this over long
//     sessions.
//
// Not doing yet (deliberate for the first cut):
//   - Streaming playback (fetch → chunk → play). Simpler to blob-
//     the whole clip first; add streaming if latency is too high.
//   - Voice selection UI. Server-side default speaker only.
//   - Rate/pitch controls. CosyVoice supports them; browser hook
//     does not expose yet.

import { useCallback, useEffect, useRef, useState } from "react";

interface SpeakOptions {
  /** Speaker id passed through to /api/tts. Server picks a sensible
   *  default when omitted. */
  voice?: string;
  /** TTS provider override: "edge" | "cosyvoice". When omitted the
   *  server uses its TTS_PROVIDER env default. Yu, 2026-09-19:
   *  added so the client can honour the user's Settings choice
   *  without restarting the server. */
  provider?: string;
}

export function useTts(): {
  speak: (text: string, opts?: SpeakOptions) => Promise<void>;
  stop: () => void;
  isSpeaking: boolean;
} {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);

  // Lazily create the shared <audio> element on first speak() call.
  // This lets us hook 'ended'/'error' once and reuse for all clips.
  function getAudio(): HTMLAudioElement {
    if (audioRef.current) return audioRef.current;
    const el = new Audio();
    el.preload = "auto";
    audioRef.current = el;
    return el;
  }

  const stop = useCallback(() => {
    // Cancel any in-flight fetch.
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    // Pause / reset the audio element.
    if (audioRef.current) {
      try {
        audioRef.current.pause();
      } catch {
        // Ignore — element may already be in a torn-down state.
      }
      audioRef.current.currentTime = 0;
    }
    // Revoke any blob URL to release memory.
    if (objectUrlRef.current) {
      try {
        URL.revokeObjectURL(objectUrlRef.current);
      } catch {
        // ignore
      }
      objectUrlRef.current = null;
    }
    setIsSpeaking(false);
  }, []);

  const speak = useCallback(
    async (text: string, opts?: SpeakOptions): Promise<void> => {
      if (!text.trim()) return;

      // Cancel anything currently speaking before starting the new one.
      stop();

      const controller = new AbortController();
      abortRef.current = controller;

      let audioBlob: Blob;
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            text,
            voice: opts?.voice,
            provider: opts?.provider,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          // Try to surface the server's error JSON if any.
          let detail = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            if (body?.error) detail = body.error;
          } catch {
            // response wasn't JSON; keep HTTP status
          }
          throw new Error(`[tts] ${detail}`);
        }
        audioBlob = await res.blob();
      } catch (err) {
        // If we were aborted, that's a normal stop() — swallow silently.
        if ((err as { name?: string })?.name === "AbortError") return;
        setIsSpeaking(false);
        throw err;
      }

      // Only proceed if we weren't stopped mid-flight.
      if (controller.signal.aborted) return;

      const url = URL.createObjectURL(audioBlob);
      objectUrlRef.current = url;
      const audio = getAudio();

      return new Promise<void>((resolve, reject) => {
        function cleanup() {
          audio.removeEventListener("ended", onEnded);
          audio.removeEventListener("error", onError);
          if (objectUrlRef.current === url) {
            try {
              URL.revokeObjectURL(url);
            } catch {
              // ignore
            }
            objectUrlRef.current = null;
          }
          setIsSpeaking(false);
        }
        function onEnded() {
          cleanup();
          resolve();
        }
        function onError() {
          cleanup();
          reject(new Error("[tts] audio playback failed"));
        }

        audio.addEventListener("ended", onEnded);
        audio.addEventListener("error", onError);
        audio.src = url;
        setIsSpeaking(true);
        audio.play().catch((err) => {
          // Autoplay policy can reject here (user hasn't interacted
          // yet). Surface the error so the caller can prompt the
          // user to click first.
          cleanup();
          reject(err);
        });
      });
    },
    [stop],
  );

  // Cleanup on unmount — stop playback and release blob URL.
  useEffect(() => {
    return () => {
      stop();
      audioRef.current = null;
    };
  }, [stop]);

  return { speak, stop, isSpeaking };
}
