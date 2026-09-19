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

  // Track the current MediaSource so stop() can shut it down
  // cleanly. Without this, calling speak() twice in quick succession
  // (e.g. multi-step replies) starts a second SourceBuffer while the
  // previous streaming pump is still inserting into a detached
  // MediaSource → InvalidStateError on appendBuffer.
  const mediaSourceRef = useRef<MediaSource | null>(null);

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
      // Clearing src detaches the MediaSource / blob source so it
      // won't hold references or fight the next speak() call.
      try {
        audioRef.current.removeAttribute("src");
        audioRef.current.load();
      } catch {
        // ignore
      }
    }
    // Tear down any active MediaSource. endOfStream() only works
    // in "open" state; otherwise removeSourceBuffer / detach via
    // src clear above is enough.
    if (mediaSourceRef.current) {
      const ms = mediaSourceRef.current;
      mediaSourceRef.current = null;
      try {
        if (ms.readyState === "open") ms.endOfStream();
      } catch {
        // ignore — stream may already be ending / errored
      }
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

      // Kick off the request. We DON'T await res.blob() any more —
      // we're going to stream the response into MediaSource so the
      // audio starts playing as chunks arrive.
      //
      // Yu, 2026-09-19 21:27: switched from blob() to MediaSource
      // streaming. Edge-tts cloud has ~1.8s first-byte latency +
      // total ~2.6s for a short sentence; buffering the whole blob
      // made the user hear silence for the full 2.6s. Streaming
      // starts playback at ~1.8s — the browser plays as chunks
      // land, roughly halving perceived latency.
      let res: globalThis.Response;
      try {
        res = await fetch("/api/tts", {
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
          let detail = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            if (body?.error) detail = body.error;
          } catch {
            // response wasn't JSON; keep HTTP status
          }
          throw new Error(`[tts] ${detail}`);
        }
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        setIsSpeaking(false);
        throw err;
      }
      if (controller.signal.aborted) return;

      const contentType = res.headers.get("content-type") ?? "";
      const audio = getAudio();

      // CosyVoice returns audio/wav in this codebase. MediaSource
      // works well with MP3 ("audio/mpeg") in all modern browsers,
      // but wav is finicky — spec says supported but every browser
      // has quirks. Fall back to blob() for anything that isn't
      // audio/mpeg so wav from CosyVoice still works.
      const canStream =
        contentType.startsWith("audio/mpeg") &&
        typeof MediaSource !== "undefined" &&
        MediaSource.isTypeSupported("audio/mpeg");

      if (!canStream) {
        // Non-mpeg or MediaSource unsupported — legacy blob path.
        let audioBlob: Blob;
        try {
          audioBlob = await res.blob();
        } catch (err) {
          if ((err as { name?: string })?.name === "AbortError") return;
          setIsSpeaking(false);
          throw err;
        }
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(audioBlob);
        objectUrlRef.current = url;
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
            cleanup();
            reject(err);
          });
        });
      }

      // Streaming path via MediaSource. Flow:
      //   1. Create MediaSource, set audio.src to its objectURL
      //   2. On "sourceopen", add a SourceBuffer for audio/mpeg
      //   3. Read the fetch response body as chunks
      //   4. Serialise appendBuffer calls (SourceBuffer is one-op-
      //      at-a-time; queue and flush on updateend)
      //   5. When the reader is exhausted, endOfStream()
      //   6. Resolve on audio.ended, reject on error
      const mediaSource = new MediaSource();
      mediaSourceRef.current = mediaSource;
      const url = URL.createObjectURL(mediaSource);
      objectUrlRef.current = url;

      return new Promise<void>((resolve, reject) => {
        let settled = false;
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
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        }
        function onError() {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error("[tts] audio playback failed"));
        }
        audio.addEventListener("ended", onEnded);
        audio.addEventListener("error", onError);

        mediaSource.addEventListener(
          "sourceopen",
          async () => {
            let sourceBuffer: SourceBuffer;
            try {
              sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
            } catch (err) {
              if (!settled) {
                settled = true;
                cleanup();
                reject(err);
              }
              return;
            }

            // Queue chunks; SourceBuffer refuses appendBuffer while
            // updating so we serialise.
            const queue: Uint8Array[] = [];
            let ended = false;
            let appending = false;

            function pump() {
              if (appending) return;
              if (queue.length === 0) {
                if (ended) {
                  try {
                    if (mediaSource.readyState === "open") {
                      mediaSource.endOfStream();
                    }
                  } catch {
                    // ignore — audio ended event will resolve us
                  }
                }
                return;
              }
              // Bail if the MediaSource / SourceBuffer was torn
              // down while we were queued (rapid stop() + new speak
              // during multi-step replies). Without this guard the
              // appendBuffer call throws InvalidStateError with
              // "SourceBuffer has been removed from the parent
              // media source" (Yu 2026-09-19 21:34).
              if (
                settled ||
                mediaSourceRef.current !== mediaSource ||
                mediaSource.readyState !== "open"
              ) {
                queue.length = 0;
                return;
              }
              appending = true;
              const next = queue.shift()!;
              try {
                // TS 7 tightened Uint8Array typing; SourceBuffer.appendBuffer
                // takes BufferSource which older TS accepted Uint8Array for
                // implicitly. Explicit cast — runtime is unchanged.
                sourceBuffer.appendBuffer(next as BufferSource);
              } catch (err) {
                appending = false;
                // Treat detach as a silent stop rather than an error
                // — it just means the caller moved on to a new speak.
                const name = (err as { name?: string })?.name;
                if (name === "InvalidStateError") {
                  if (!settled) {
                    settled = true;
                    cleanup();
                    resolve();
                  }
                  return;
                }
                if (!settled) {
                  settled = true;
                  cleanup();
                  reject(err);
                }
              }
            }
            sourceBuffer.addEventListener("updateend", () => {
              appending = false;
              pump();
            });

            // Start playback — audio can begin as soon as the
            // sourceBuffer has enough data for the codec.
            setIsSpeaking(true);
            audio.src = url;
            audio.play().catch((err) => {
              if (!settled) {
                settled = true;
                cleanup();
                reject(err);
              }
            });

            // Pump the fetch stream into the queue.
            if (!res.body) {
              ended = true;
              pump();
              return;
            }
            const reader = res.body.getReader();
            try {
              while (true) {
                if (controller.signal.aborted) {
                  try {
                    reader.cancel();
                  } catch {
                    // ignore
                  }
                  return;
                }
                const { value, done } = await reader.read();
                if (done) break;
                if (value && value.length) {
                  queue.push(value);
                  pump();
                }
              }
              ended = true;
              pump();
            } catch (err) {
              if (!settled) {
                settled = true;
                cleanup();
                reject(err);
              }
            }
          },
          { once: true },
        );

        audio.src = url;
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
