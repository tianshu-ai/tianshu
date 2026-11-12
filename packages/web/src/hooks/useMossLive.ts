/**
 * Moss-Live realtime voice hook.
 *
 * Manages the WebSocket connection to /moss-live, mic capture,
 * audio playback, and transcript state.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type MossLiveState =
  | "idle"
  | "connecting"
  | "connected"
  | "configuring"
  | "ready"
  | "error"
  | "disconnected";

export interface MossLiveTranscript {
  type: "input" | "output";
  text: string;
  done: boolean;
  ts: number;
}

export interface MossLiveDelegation {
  id: string;
  objective: string;
  status: "created" | "in_progress" | "completed" | "failed";
  text?: string;
}

const SAMPLE_RATE = 16000;
const PLAYBACK_RATE = 48000;

export function useMossLive() {
  const [state, setState] = useState<MossLiveState>("idle");
  const [micEnabled, setMicEnabled] = useState(false);
  const [inputText, setInputText] = useState("");
  const [outputText, setOutputText] = useState("");
  const [delegation, setDelegation] = useState<MossLiveDelegation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const playbackQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const micEnabledRef = useRef(false);

  // Keep ref in sync
  useEffect(() => { micEnabledRef.current = micEnabled; }, [micEnabled]);

  const stopMic = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
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
      if (!micEnabledRef.current) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const float32 = e.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      ws.send(pcm.buffer);
    };

    source.connect(processor);
    processor.connect(actx.destination);
  }, []);

  const playAudio = useCallback((buffer: ArrayBuffer) => {
    playbackQueueRef.current.push(buffer);
    if (!isPlayingRef.current) drainPlayback();
  }, []);

  const drainPlayback = useCallback(async () => {
    const actx = audioCtxRef.current ?? new AudioContext({ sampleRate: PLAYBACK_RATE });
    audioCtxRef.current = actx;
    isPlayingRef.current = true;

    while (playbackQueueRef.current.length > 0) {
      const buf = playbackQueueRef.current.shift()!;
      const int16 = new Int16Array(buf);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 0x8000;
      }
      const audioBuffer = actx.createBuffer(1, float32.length, PLAYBACK_RATE);
      audioBuffer.copyToChannel(float32, 0);
      const sourceNode = actx.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.connect(actx.destination);
      sourceNode.start();
      await new Promise<void>((r) => { sourceNode.onended = () => r(); });
    }

    isPlayingRef.current = false;
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current) return;

    setState("connecting");
    setError(null);

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/moss-live`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => setState("connected");

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        playAudio(event.data);
        return;
      }
      try {
        const msg = JSON.parse(event.data as string);
        handleEvent(msg);
      } catch { /* ignore */ }
    };

    ws.onerror = () => {
      setError("WebSocket connection failed");
      setState("error");
    };

    ws.onclose = () => {
      wsRef.current = null;
      setState("disconnected");
      stopMic();
    };
  }, [playAudio, stopMic]);

  const disconnect = useCallback(() => {
    stopMic();
    wsRef.current?.close();
    wsRef.current = null;
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    playbackQueueRef.current = [];
    isPlayingRef.current = false;
    setState("idle");
    setInputText("");
    setOutputText("");
    setDelegation(null);
  }, [stopMic]);

  const toggleMic = useCallback(async () => {
    const next = !micEnabled;
    setMicEnabled(next);
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: "mic_state", mic: { enabled: next } }));
    }
    if (next) {
      await startMic();
    } else {
      stopMic();
    }
  }, [micEnabled, startMic, stopMic]);

  const handleEvent = useCallback((msg: Record<string, unknown>) => {
    const action = msg.action as string;
    const data = msg.data as Record<string, unknown> | undefined;

    switch (action) {
      case "session_attached":
        setState("configuring");
        break;
      case "session.updated":
        if (data?.error === "") setState("ready");
        break;
      case "input.transcript.updated":
        setInputText(data?.text as string || "");
        break;
      case "input.transcript.done":
        setInputText(data?.text as string || "");
        break;
      case "output.transcript.updated":
        setOutputText(data?.text as string || "");
        break;
      case "output.transcript.done":
        setOutputText(data?.text as string || "");
        break;
      case "input.speech.started":
        // User started speaking — clear old output
        setOutputText("");
        break;
      case "session.delegation.created": {
        const d = data?.delegation as Record<string, unknown>;
        setDelegation({
          id: d?.id as string,
          objective: d?.objective as string,
          status: "created",
        });
        break;
      }
      case "session.commentary.appended":
        // Update delegation status from commentary
        setDelegation((prev) => prev ? { ...prev, status: "in_progress" } : prev);
        break;
      case "error":
        setError((data?.message as string) || "Unknown error");
        break;
      case "stream_error":
        setError((msg as Record<string, string>).reason || "Connection error");
        setState("error");
        break;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => () => { disconnect(); }, [disconnect]);

  return {
    state,
    micEnabled,
    inputText,
    outputText,
    delegation,
    error,
    connect,
    disconnect,
    toggleMic,
  };
}
