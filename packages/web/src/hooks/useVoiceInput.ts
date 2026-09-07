/**
 * Hook for in-browser voice input using Whisper via Web Worker.
 *
 * Usage:
 *   const { recording, status, toggle } = useVoiceInput(onResult);
 *   <button onClick={toggle}>{recording ? "Stop" : "Mic"}</button>
 *
 * Flow:
 *   1. User clicks mic → start MediaRecorder
 *   2. User clicks again → stop recording → convert to Float32Array
 *   3. Send to whisper-worker → get text back via onResult callback
 */

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "idle" | "recording" | "loading" | "transcribing" | "ready" | "error";

interface WorkerMessage {
  type: "status" | "result" | "error";
  status?: string;
  text?: string;
  error?: string;
}

export function useVoiceInput(onResult: (text: string) => void) {
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const workerRef = useRef<Worker | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Init worker lazily on first use
  const getWorker = useCallback(() => {
    if (workerRef.current) return workerRef.current;
    const worker = new Worker(
      new URL("../workers/whisper-worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      if (msg.type === "status") {
        setStatus(msg.status as Status);
      } else if (msg.type === "result") {
        setStatus("ready");
        if (msg.text) onResult(msg.text);
      } else if (msg.type === "error") {
        setStatus("error");
        console.error("[voice]", msg.error);
      }
    };
    workerRef.current = worker;
    return worker;
  }, [onResult]);

  // Cleanup
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      recorderRef.current?.stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const toggle = useCallback(async () => {
    if (recording) {
      // Stop recording
      recorderRef.current?.stop();
      setRecording(false);
      return;
    }

    // Start recording
    try {
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
        if (blob.size === 0) return;

        // Decode to Float32Array (16kHz mono, what Whisper expects)
        const arrayBuffer = await blob.arrayBuffer();
        const audioCtx = new AudioContext({ sampleRate: 16000 });
        const decoded = await audioCtx.decodeAudioData(arrayBuffer);
        const float32 = decoded.getChannelData(0);
        await audioCtx.close();

        // Send to worker
        const worker = getWorker();
        worker.postMessage(
          { type: "transcribe", audio: float32 },
          [float32.buffer],
        );
      };

      recorder.start(250); // collect chunks every 250ms
      recorderRef.current = recorder;
      setRecording(true);
      setStatus("recording");
    } catch (e) {
      console.error("[voice] microphone access denied:", e);
      setStatus("error");
    }
  }, [recording, getWorker]);

  // Pre-load model (call once to warm up)
  const preload = useCallback(() => {
    getWorker().postMessage({ type: "load" });
  }, [getWorker]);

  return { recording, status, toggle, preload };
}
