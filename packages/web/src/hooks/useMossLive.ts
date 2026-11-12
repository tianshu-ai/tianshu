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
      // Send audio as base64 through moss_live_event
      const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm.buffer)));
      ws.send(JSON.stringify({ type: "moss_live_audio", audio: base64 }));
    };

    source.connect(processor);
    processor.connect(actx.destination);
  }, []);

  const playAudio = useCallback((data: ArrayBuffer) => {
    // Use browser default sample rate; createBuffer with 48000
    // lets the browser resample automatically.
    const pctx = playbackCtxRef.current ?? new AudioContext();
    playbackCtxRef.current = pctx;

    // Validate: PCM S16LE requires even byte count
    if (data.byteLength === 0 || data.byteLength % 2 !== 0) return;

    const int16 = new Int16Array(data);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0;
    }
    // Specify 48000 as the buffer sample rate — browser resamples
    // to match AudioContext.destination automatically.
    const audioBuffer = pctx.createBuffer(1, float32.length, PLAYBACK_RATE);
    audioBuffer.copyToChannel(float32, 0);
    const sourceNode = pctx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(pctx.destination);
    sourceNode.start();
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
          if (data?.error === "") setState("ready");
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
        case "error":
          setError((data?.message as string) || "Unknown error");
          break;
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
  }, [handleWsMessage]);

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
