/**
 * Hook for voice input via server-side ASR.
 *
 * Yu, 2026-09-19: dual-mode support.
 *   - "offline" model (default sherpa OfflineRecognizer): record whole
 *     utterance → POST /api/transcribe → get final text (original
 *     behaviour, preserved for legacy installs).
 *   - "online" model (streaming zipformer via /ws/asr): open WS, stream
 *     PCM 16 kHz chunks via AudioWorklet, get partial results in
 *     real time — the "one character at a time" experience.
 *
 * Mode picked automatically from /api/transcribe/status → mode field.
 */

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "idle" | "recording" | "transcribing" | "error";
type Mode = "offline" | "online" | null;

// AudioWorklet lives at /asr-worklet.js (served from packages/web/public).
// The processor name it registers is "asr-processor".
const WORKLET_URL = "/asr-worklet.js";
const WORKLET_NAME = "asr-processor";

// Yu, 2026-09-19: streaming mode replaces the current draft each partial
// (text grows across calls), offline mode appends one final result. Callers
// that want smart draft behaviour pass BOTH callbacks; if only `onResult`
// is passed, streaming partials fall back to appending, matching legacy
// offline behaviour.
export interface VoiceInputCallbacks {
  onResult: (text: string) => void;         // fired on offline final / streaming final
  onPartial?: (text: string) => void;       // fired on streaming partials (replace, not append)
}

export function useVoiceInput(
  onResultOrCallbacks: ((text: string) => void) | VoiceInputCallbacks,
) {
  const callbacks: VoiceInputCallbacks =
    typeof onResultOrCallbacks === "function"
      ? { onResult: onResultOrCallbacks }
      : onResultOrCallbacks;
  const onResult = callbacks.onResult;
  const onPartial = callbacks.onPartial ?? callbacks.onResult;
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [available, setAvailable] = useState(false);
  const [mode, setMode] = useState<Mode>(null);

  // Offline mode refs (original MediaRecorder path)
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Online mode refs (WS + AudioWorklet path)
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  // Streaming state accumulated across sherpa "endpoint" resets.
  // sherpa restarts the stream after each detected utterance boundary,
  // so a multi-sentence session produces multiple partial series that
  // each start from empty. We concatenate them so onResult always sees
  // the FULL text produced so far.
  //
  //   finalisedRef  = concatenation of every segment BEFORE the current one
  //   lastPartialRef = most recent partial text of the CURRENT segment
  //
  // On "endpoint": append lastPartial to finalised, reset lastPartial.
  // On "partial":  render finalised + partial. Update lastPartial.
  // On "final":    render finalised + final. teardown.
  const finalisedRef = useRef<string>("");
  const lastPartialRef = useRef<string>("");

  const [shortcut, setShortcut] = useState("ctrl+shift+m");

  // Check server ASR availability + mode + load shortcut preference
  useEffect(() => {
    const check = () =>
      fetch("/api/transcribe/status", { credentials: "include" })
        .then((r) => r.json())
        .then((d) => {
          setAvailable(!!d.available);
          setMode((d.mode as Mode) ?? "offline");
        })
        .catch(() => {
          setAvailable(false);
          setMode(null);
        });
    check();
    const interval = setInterval(check, 10000);
    fetch("/api/preferences/asr.shortcut", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => { if (d.value) setShortcut(d.value); })
      .catch(() => {});
    return () => {
      clearInterval(interval);
      recorderRef.current?.stream?.getTracks().forEach((t) => t.stop());
      teardownOnline();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const teardownOnline = () => {
    try {
      workletRef.current?.port.postMessage("stop");
      workletRef.current?.disconnect();
    } catch {}
    workletRef.current = null;
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {}
    streamRef.current = null;
    try {
      audioCtxRef.current?.close();
    } catch {}
    audioCtxRef.current = null;
    try {
      wsRef.current?.close();
    } catch {}
    wsRef.current = null;
  };

  const startOffline = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm",
    });
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      if (blob.size === 0) {
        setStatus("idle");
        return;
      }
      setStatus("transcribing");
      try {
        const res = await fetch("/api/transcribe", {
          method: "POST",
          headers: { "Content-Type": "audio/webm" },
          body: blob,
          credentials: "include",
        });
        if (!res.ok) {
          console.error("[voice] transcribe failed:", res.status);
          setStatus("error");
          return;
        }
        const data = await res.json();
        if (data.text) onResult(data.text);
        setStatus("idle");
      } catch (e) {
        console.error("[voice] transcribe error:", e);
        setStatus("error");
      }
    };

    recorder.start(250);
    recorderRef.current = recorder;
    setRecording(true);
    setStatus("recording");
  }, [onResult]);

  const startOnline = useCallback(async () => {
    // 1. Mic
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        // 16 kHz not always honoured — worklet resamples to be sure.
      },
    });
    streamRef.current = stream;

    // 2. AudioContext + worklet.
    // Yu, 2026-09-19: MUST create AudioContext at 16 kHz. Letting
    // it default to the platform's native rate (44.1/48 kHz) forced
    // the worklet to resample to 16 kHz in JS, which introduced
    // slightly-off-cadence samples that sherpa's streaming zipformer
    // interpreted as multiple identical utterances ("你你你你"). The
    // browser's native resampler produces clean 16 kHz output.
    // Mirrors sherpa's official WASM demo (app-asr.js).
    //
    // Safari and some older Chrome versions ignore the option and
    // silently return the native rate anyway; log the actual rate
    // so we notice if the fix regresses.
    const ctx = new AudioContext({ sampleRate: 16000 });
    if (ctx.sampleRate !== 16000) {
      console.warn(
        `[voice] AudioContext sampleRate=${ctx.sampleRate}, expected 16000; ` +
        `sherpa will likely produce duplicated tokens. Browser doesn't ` +
        `honour the sampleRate hint on this platform.`,
      );
    }
    audioCtxRef.current = ctx;
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
    } catch (e) {
      console.error("[voice] worklet load failed:", e);
      teardownOnline();
      setStatus("error");
      return;
    }
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, WORKLET_NAME);
    workletRef.current = node;
    source.connect(node);
    // We don't need to output audio anywhere — the worklet is a sink.
    // Some browsers pause the graph if it has no destination path, so
    // we connect to a muted GainNode → destination as a keep-alive.
    const muted = ctx.createGain();
    muted.gain.value = 0;
    node.connect(muted).connect(ctx.destination);

    // 3. WebSocket
    // Same origin, ws:// if page is http, wss:// if https.
    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${wsProto}//${window.location.host}/ws/asr`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    finalisedRef.current = "";

    ws.onopen = () => {
      setStatus("recording");
      setRecording(true);
      // Wire worklet → ws only after socket is open. Base64 encode the
      // Float32 samples so the wire message is plain JSON — the server
      // handler decodes back to a zero-copy Float32Array view.
      node.port.onmessage = (ev) => {
        const samples: Float32Array = ev.data.samples;
        if (!samples || samples.byteLength === 0) return;
        // Float32Array → base64 without dragging in a whole polyfill.
        const bytes = new Uint8Array(samples.buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const b64 = window.btoa(binary);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "audio", samples: b64 }));
        }
      };
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        switch (msg.type) {
          case "ready":
            // Already handled state transition in onopen.
            return;
          case "partial": {
            const text = msg.text ?? "";
            lastPartialRef.current = text;
            // Streaming partials REPLACE the growing draft. `onPartial`
            // is the streaming-aware callback; when the caller only
            // provided the legacy `onResult` it falls back to append
            // (see the callbacks resolution above) which produces the
            // pre-streaming behaviour — acceptable but not ideal.
            onPartial(finalisedRef.current + text);
            return;
          }
          case "endpoint": {
            // Sherpa reset the stream; the current segment is done.
            // Bake the last partial into finalised so upcoming partials
            // (which will start from empty) don't overwrite it.
            if (lastPartialRef.current) {
              // Add a single space between segments so a fresh partial
              // doesn't glue itself onto the previous sentence.
              const sep = finalisedRef.current.length > 0 ? " " : "";
              finalisedRef.current += sep + lastPartialRef.current;
              lastPartialRef.current = "";
            }
            return;
          }
          case "final": {
            // final can be empty when the trailing audio was just
            // silence — that's fine, finalisedRef still has the good
            // stuff. Only render if we have anything new.
            const finalText = msg.text ?? "";
            const sep = finalisedRef.current.length > 0 && finalText.length > 0 ? " " : "";
            const combined = finalisedRef.current + sep + finalText;
            if (combined.length > 0) onResult(combined);
            setStatus("idle");
            setRecording(false);
            teardownOnline();
            return;
          }
          case "error":
            console.error("[voice] ws error:", msg.reason);
            setStatus("error");
            setRecording(false);
            teardownOnline();
            return;
        }
      } catch (e) {
        console.error("[voice] ws message parse:", e);
      }
    };

    ws.onerror = (ev) => {
      console.error("[voice] ws socket error", ev);
      setStatus("error");
      setRecording(false);
      teardownOnline();
    };

    ws.onclose = () => {
      // If we get here without a "final", downgrade to idle silently.
      if (recording) {
        setStatus("idle");
        setRecording(false);
      }
      teardownOnline();
    };
  }, [onResult, recording]);

  const stopOnline = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "end" }));
    } else {
      teardownOnline();
      setStatus("idle");
      setRecording(false);
    }
  }, []);

  const toggle = useCallback(async () => {
    if (recording) {
      if (mode === "online") {
        stopOnline();
      } else {
        recorderRef.current?.stop();
        setRecording(false);
      }
      return;
    }

    try {
      if (mode === "online") {
        await startOnline();
      } else {
        await startOffline();
      }
    } catch (e) {
      console.error("[voice] microphone access denied:", e);
      setStatus("error");
    }
  }, [recording, mode, startOnline, startOffline, stopOnline]);

  const voiceLoading = status === "transcribing";

  return {
    recording,
    status,
    toggle,
    voiceLoading,
    available,
    shortcut,
    setShortcut,
    mode,
  };
}
