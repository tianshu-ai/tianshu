/**
 * Moss-Live realtime voice hook.
 *
 * Tunnels through the existing chat /ws connection:
 *   - Sends { type: "moss_live_start" } to start
 *   - Sends { type: "moss_live_event", event: {...} } for control events
 *   - Sends { type: "moss_live_stop" } to stop
 *   - Receives { type: "moss_live_event", event: {...} } for upstream events
 *   - Audio: client sends base64 PCM, server sends raw binary PCM
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { tianshuWs } from "../lib/ws";

export type MossLiveState =
  | "idle"
  | "connecting"
  | "connected"
  | "configuring"
  | "ready"
  | "error"
  | "disconnected";

const SAMPLE_RATE = 16000;
const PLAYBACK_RATE = 48000;

export function useMossLive() {
  const [state, setState] = useState<MossLiveState>("idle");
  const [micEnabled, setMicEnabled] = useState(false);
  const [inputText, setInputText] = useState("");
  const [outputText, setOutputText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const micEnabledRef = useRef(false);
  const activeRef = useRef(false);
  const listenerRef = useRef<((e: MessageEvent) => void) | null>(null);
  const debugLoggedRef = useRef(false);

  useEffect(() => { micEnabledRef.current = micEnabled; }, [micEnabled]);

  const stopMic = useCallback(() => {
    processorRef.current?.disconnect();
    processorRef.current = null;
    sourceNodeRef.current?.disconnect();
    sourceNodeRef.current = null;
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
  }, []);

  const startMic = useCallback(async () => {
    if (mediaStreamRef.current) return;
    const actx = audioCtxRef.current ?? new AudioContext({ sampleRate: SAMPLE_RATE });
    audioCtxRef.current = actx;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    mediaStreamRef.current = stream;

    const source = actx.createMediaStreamSource(stream);
    sourceNodeRef.current = source;
    const processor = actx.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (e) => {
      if (!micEnabledRef.current || !activeRef.current) return;
      const ws = tianshuWs.getSocket();
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const float32 = e.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      // Send audio as base64 through moss_live_audio.
      // Use chunked encoding to avoid stack overflow with spread operator.
      const bytes = new Uint8Array(pcm.buffer);
      let binary = "";
      for (let j = 0; j < bytes.length; j += 1024) {
        binary += String.fromCharCode(...bytes.subarray(j, Math.min(j + 1024, bytes.length)));
      }
      ws.send(JSON.stringify({ type: "moss_live_audio", audio: btoa(binary) }));
    };

    source.connect(processor);
    processor.connect(actx.destination);
  }, []);

  // Sequential audio playback — schedule each chunk right after
  // the previous one ends so they don't overlap (overlap = crackle).
  const nextPlayTimeRef = useRef(0);
  // Track audio state for playback receipts
  const currentResponseIdRef = useRef<string | null>(null);
  const audioDoneRef = useRef(false);
  const lastScheduledEndRef = useRef(0);

  const sendMossEvent = useCallback((event: Record<string, unknown>) => {
    const ws = tianshuWs.getSocket();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "moss_live_event", event }));
    }
  }, []);

  const playAudio = useCallback((data: ArrayBuffer) => {
    const pctx = playbackCtxRef.current ?? new AudioContext();
    playbackCtxRef.current = pctx;

    if (data.byteLength === 0 || data.byteLength % 2 !== 0) return;

    const int16 = new Int16Array(data);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0;
    }

    const audioBuffer = pctx.createBuffer(1, float32.length, PLAYBACK_RATE);
    audioBuffer.copyToChannel(float32, 0);
    const sourceNode = pctx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(pctx.destination);

    // Schedule sequentially: each chunk starts when the previous ends
    const now = pctx.currentTime;
    const startTime = Math.max(now, nextPlayTimeRef.current);
    sourceNode.start(startTime);
    const endTime = startTime + audioBuffer.duration;
    nextPlayTimeRef.current = endTime;

    // Track when the last scheduled audio ends so we can send
    // playback.completed after response.audio.done.
    lastScheduledEndRef.current = endTime;
  }, []);

  const handleWsMessage = useCallback((e: MessageEvent) => {
    if (!activeRef.current) return;

    // Binary: audio from Moss-Live
    if (e.data instanceof ArrayBuffer) {
      if (!debugLoggedRef.current) {
        const view = new Uint8Array(e.data);
        console.log(`[moss-live] first binary frame: ${e.data.byteLength} bytes, header=[${Array.from(view.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}]`);
        debugLoggedRef.current = true;
      }
      playAudio(e.data);
      return;
    }
    if (e.data instanceof Blob) {
      e.data.arrayBuffer().then((buf) => {
        if (!debugLoggedRef.current) {
          const view = new Uint8Array(buf);
          console.log(`[moss-live] first blob frame: ${buf.byteLength} bytes, header=[${Array.from(view.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}]`);
          debugLoggedRef.current = true;
        }
        playAudio(buf);
      });
      return;
    }

    try {
      const msg = JSON.parse(e.data as string);
      if (msg.type !== "moss_live_event") return;

      const event = msg.event as Record<string, unknown>;
      const action = event.action as string;
      const data = event.data as Record<string, unknown> | undefined;

      switch (action) {
        case "session_attached":
          setState("configuring");
          break;
        case "session.updated":
          if (data?.error === "") {
            setState("ready");
          } else if (data?.error) {
            console.warn("[moss-live] session.updated error:", data.error);
          }
          break;
        case "input.transcript.updated":
        case "input.transcript.done":
          setInputText(data?.text as string || "");
          break;
        case "input.speech.started":
          setOutputText("");
          break;
        case "output.transcript.updated":
        case "output.transcript.done":
          setOutputText(data?.text as string || "");
          break;
        // Audio lifecycle events — track for playback receipts
        case "response.audio.started":
          currentResponseIdRef.current = data?.response_id as string ?? null;
          audioDoneRef.current = false;
          break;
        case "response.audio.done": {
          audioDoneRef.current = true;
          // Wait for last scheduled chunk to finish, then send playback.completed
          const responseId = currentResponseIdRef.current;
          const pctx = playbackCtxRef.current;
          const lastEnd = lastScheduledEndRef.current;
          if (pctx && responseId) {
            const remainMs = Math.max(0, (lastEnd - pctx.currentTime) * 1000) + 100;
            setTimeout(() => {
              sendMossEvent({
                action: "playback.completed",
                response_id: responseId,
              });
            }, remainMs);
          }
          break;
        }
        case "error": {
          console.warn("[moss-live] error event:", JSON.stringify(event));
          // Moss-Live nests: { data: { error: { code, message } } }
          const nested = data?.error;
          const errMsg: string | null =
            (typeof nested === "object" && nested !== null && typeof (nested as any).message === "string")
              ? (nested as any).message
              : (typeof nested === "string" ? nested : null)
                || (typeof data?.message === "string" ? (data.message as string) : null)
                || (typeof data?.code === "string" ? (data.code as string) : null);
          // Skip noisy "invalid or unsupported request" from media.configure
          if (errMsg && errMsg !== "invalid or unsupported request") {
            setError(errMsg);
            setTimeout(() => setError((prev) => prev === errMsg ? null : prev), 5000);
          }
          break;
        }
        case "moss_live_closed":
          setState("disconnected");
          activeRef.current = false;
          break;
      }
    } catch { /* ignore */ }
  }, [playAudio]);

  const connect = useCallback(() => {
    const ws = tianshuWs.getSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("Chat WebSocket not connected");
      setState("error");
      return;
    }

    setState("connecting");
    setError(null);
    activeRef.current = true;

    // Listen for moss-live events on the chat WS
    const listener = handleWsMessage;
    listenerRef.current = listener;
    ws.addEventListener("message", listener);

    // Start moss-live session
    ws.send(JSON.stringify({ type: "moss_live_start" }));
    setState("connected");

    // Auto-enable mic after connection — Moss-Live requires
    // continuous audio upload (even silence) to keep the session alive.
    setMicEnabled(true);
    micEnabledRef.current = true;
    startMic().then(() => {
      ws.send(JSON.stringify({
        type: "moss_live_event",
        event: { action: "mic_state", mic: { enabled: true } },
      }));
    });
  }, [handleWsMessage, startMic]);

  const disconnect = useCallback(() => {
    activeRef.current = false;
    stopMic();
    setMicEnabled(false);

    const ws = tianshuWs.getSocket();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "moss_live_stop" }));
    }

    // Remove listener
    if (listenerRef.current && ws) {
      ws.removeEventListener("message", listenerRef.current);
      listenerRef.current = null;
    }

    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    playbackCtxRef.current?.close().catch(() => {});
    playbackCtxRef.current = null;

    setState("idle");
    setInputText("");
    setOutputText("");
  }, [stopMic]);

  const toggleMic = useCallback(async () => {
    const next = !micEnabled;
    setMicEnabled(next);

    const ws = tianshuWs.getSocket();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "moss_live_event",
        event: { action: "mic_state", mic: { enabled: next } },
      }));
    }

    if (next) {
      await startMic();
    } else {
      stopMic();
    }
  }, [micEnabled, startMic, stopMic]);

  // Cleanup on unmount
  useEffect(() => () => { disconnect(); }, [disconnect]);

  return {
    state,
    micEnabled,
    inputText,
    outputText,
    error,
    connect,
    disconnect,
    toggleMic,
  };
}
