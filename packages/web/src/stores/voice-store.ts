// Global voice playback store.
//
// Yu, 2026-09-19 21:40: "在每个 tianshu 消息里放个播放按钮，可以
// 主动播放，但是同时只能播一个，参考其他 app 的行为". Familiar
// pattern from WeChat voice messages, iOS Podcasts, YouTube chapters —
// one play control per item plus a global "only one plays at a time"
// rule.
//
// The store owns exactly one HTMLAudioElement and one active
// MediaSource. All playback goes through it: the auto-speak-on-new-
// reply hook, the per-message play button, and any future entry
// point (Settings preview test, hotkey, etc.). Because there's one
// audio element, starting a new utterance implicitly stops the
// previous one — no coordinating flag needed.
//
// State observers can subscribe with `useVoiceStore(s => s.playingId)`
// to render play/pause icons on the right bubble.

import { create } from "zustand";

/** What to say. Called by every entry point that wants audio out. */
export interface SpeakRequest {
  /** Stable id for the utterance (usually a message id). Used to
   *  drive UI state — the bubble whose id matches `playingId`
   *  shows a pause icon; everyone else shows play. */
  id: string;
  /** Raw text (already markdown-stripped). */
  text: string;
  /** Optional voice / provider overrides. Server picks a default
   *  when omitted. */
  voice?: string;
  provider?: string;
}

interface VoiceState {
  /** Id of the utterance currently playing (or fetching audio for);
   *  null when idle. */
  playingId: string | null;
  /** Last error surface; useful for the caller to show a toast. */
  lastError: string | null;

  /** Fire an utterance. Cancels any current playback. Resolves
   *  when playback finishes (or rejects on fetch/decode error). */
  play: (req: SpeakRequest) => Promise<void>;
  /** Stop whatever is currently playing / fetching. Safe to call
   *  when nothing is active. */
  stop: () => void;
}

// ─── Internal singletons ──────────────────────────────────────
// Live outside the store because they don't need to trigger
// re-renders and creating them lazily lets us dodge SSR issues
// (Audio / MediaSource are browser-only globals).

let audio: HTMLAudioElement | null = null;
let mediaSource: MediaSource | null = null;
let objectUrl: string | null = null;
let abortController: AbortController | null = null;

// Blob URL cleanup, take 5 (Yu 2026-09-19 22:00 fourth failure).
// Give up on URL.revokeObjectURL entirely — four strategies failed:
//   1. sync revoke: audio.load() fetch still queued, 404
//   2. queueMicrotask: fetch dispatch is macrotask, revoke wins
//   3. 'emptied' event: apparently doesn't fire late enough on
//      the Chrome paths we hit
//   4. defer to next play(): still races the detach fetch
//
// The browser eventually reaps blob URLs on page unload. Memory
// leak per utterance is ~25-85 KB (edge-tts mp3 for a short reply);
// a chat with a few hundred replies leaks a few MB, well under
// what a normal page holds. No throughput or correctness impact.
//
// If leak ever matters we could switch to <audio>.srcObject =
// MediaSource (Chrome 108+ / Safari 15+ / Firefox 121+) which
// sidesteps blob URLs entirely, but srcObject support for
// MediaSource is less battle-tested than createObjectURL. Not
// worth the risk of introducing new playback bugs for a leak
// nobody will ever hit in practice.

function getAudio(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = "auto";
  return audio;
}

/**
 * Cleanup helper — tear down whatever state a previous play() set up
 * so a new play() (or an explicit stop()) starts from a known state.
 * Idempotent; safe to call repeatedly.
 */
function teardown() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  if (mediaSource) {
    const ms = mediaSource;
    mediaSource = null;
    try {
      if (ms.readyState === "open") ms.endOfStream();
    } catch {
      // ignore — normal after abort
    }
  }
  // Deliberately DO NOT revoke objectUrl. See top-of-file comment
  // for why every ordering strategy failed. Let the browser reap
  // on page unload.
  objectUrl = null;
  if (audio) {
    try {
      audio.pause();
    } catch {
      // ignore
    }
    audio.currentTime = 0;
    try {
      audio.removeAttribute("src");
      audio.load();
    } catch {
      // ignore
    }
  }
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  playingId: null,
  lastError: null,

  stop: () => {
    teardown();
    if (get().playingId !== null) {
      set({ playingId: null });
    }
  },

  play: async (req: SpeakRequest) => {
    // Cancel whatever's playing / fetching before starting fresh.
    teardown();
    set({ playingId: req.id, lastError: null });

    const controller = new AbortController();
    abortController = controller;

    let res: globalThis.Response;
    try {
      res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          text: req.text,
          voice: req.voice,
          provider: req.provider,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body?.error) detail = body.error;
        } catch {
          // response wasn't JSON
        }
        throw new Error(detail);
      }
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        // stop() was called mid-fetch — this is normal, not an error.
        return;
      }
      set({ playingId: null, lastError: err instanceof Error ? err.message : String(err) });
      throw err;
    }

    // If stop() fired while we were awaiting fetch, the controller
    // signals are aborted but we may have raced past the check.
    // Bail if that happened.
    if (controller.signal.aborted) {
      set({ playingId: null });
      return;
    }

    const contentType = res.headers.get("content-type") ?? "";
    const el = getAudio();

    // Streaming path for audio/mpeg (edge-tts). Fallback to blob()
    // for other content types (CosyVoice wav) or when MediaSource
    // doesn't support mpeg.
    const canStream =
      contentType.startsWith("audio/mpeg") &&
      typeof MediaSource !== "undefined" &&
      MediaSource.isTypeSupported("audio/mpeg");

    if (!canStream) {
      let blob: Blob;
      try {
        blob = await res.blob();
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        set({ playingId: null, lastError: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      if (controller.signal.aborted) {
        set({ playingId: null });
        return;
      }
      const url = URL.createObjectURL(blob);
      objectUrl = url;
      return new Promise<void>((resolve, reject) => {
        function cleanup() {
          el.removeEventListener("ended", onEnded);
          el.removeEventListener("error", onError);
          // Deliberately don't revoke url — see top-of-file comment
          // (Yu 2026-09-19 22:00, four revoke strategies all raced
          // audio's internal detach fetch).
          if (objectUrl === url) objectUrl = null;
          set({ playingId: null });
        }
        function onEnded() {
          cleanup();
          resolve();
        }
        function onError() {
          cleanup();
          reject(new Error("audio playback failed"));
        }
        el.addEventListener("ended", onEnded);
        el.addEventListener("error", onError);
        el.src = url;
        el.play().catch((err) => {
          cleanup();
          reject(err);
        });
      });
    }

    // Streaming MediaSource path. Same shape as the older useTts
    // hook — kept in comments for reference:
    //   - Create MediaSource, wire audio.src to its objectURL
    //   - On sourceopen: addSourceBuffer("audio/mpeg"), pump
    //     res.body chunks through a queue, endOfStream() when done
    //   - Resolve on audio.ended
    const ms = new MediaSource();
    mediaSource = ms;
    const url = URL.createObjectURL(ms);
    objectUrl = url;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      function cleanup() {
        el.removeEventListener("ended", onEnded);
        el.removeEventListener("error", onError);
        // Deliberately don't revoke url — see top-of-file comment.
        if (objectUrl === url) objectUrl = null;
        // Only clear playingId if it still belongs to this request;
        // a newer play() may have already claimed it.
        if (get().playingId === req.id) set({ playingId: null });
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
        reject(new Error("audio playback failed"));
      }
      el.addEventListener("ended", onEnded);
      el.addEventListener("error", onError);

      ms.addEventListener(
        "sourceopen",
        async () => {
          let sourceBuffer: SourceBuffer;
          try {
            sourceBuffer = ms.addSourceBuffer("audio/mpeg");
          } catch (err) {
            if (!settled) {
              settled = true;
              cleanup();
              reject(err);
            }
            return;
          }

          const queue: Uint8Array[] = [];
          let ended = false;
          let appending = false;

          function pump() {
            if (appending) return;
            if (queue.length === 0) {
              if (ended) {
                try {
                  if (ms.readyState === "open") ms.endOfStream();
                } catch {
                  // ignore
                }
              }
              return;
            }
            // Bail if the MediaSource was superseded (rapid play()
            // reentry from a different message id).
            if (settled || mediaSource !== ms || ms.readyState !== "open") {
              queue.length = 0;
              return;
            }
            appending = true;
            const next = queue.shift()!;
            try {
              sourceBuffer.appendBuffer(next as BufferSource);
            } catch (err) {
              appending = false;
              const name = (err as { name?: string })?.name;
              if (name === "InvalidStateError") {
                // Superseded by a newer play — treat as silent stop.
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

          el.src = url;
          el.play().catch((err) => {
            if (!settled) {
              settled = true;
              cleanup();
              reject(err);
            }
          });

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

      el.src = url;
    });
  },
}));
