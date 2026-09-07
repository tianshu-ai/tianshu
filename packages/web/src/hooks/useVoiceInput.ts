/**
 * Hook for voice input via server-side ASR.
 *
 * Flow: record mic → POST /api/transcribe → get text back.
 * No browser-side model, no external API. Server runs sherpa-onnx-node.
 */

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "idle" | "recording" | "transcribing" | "error";

export function useVoiceInput(onResult: (text: string) => void) {
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [available, setAvailable] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Check server ASR availability on mount
  useEffect(() => {
    fetch("/api/transcribe/status", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setAvailable(!!d.available))
      .catch(() => setAvailable(false));
    return () => {
      recorderRef.current?.stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const toggle = useCallback(async () => {
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);
      return;
    }

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

        setStatus("transcribing");
        try {
          const res = await fetch("/api/transcribe", {
            method: "POST",
            headers: { "Content-Type": "audio/webm" },
            body: blob,
          });
          if (!res.ok) {
            console.error("[voice] transcribe failed:", res.status);
            setStatus("error");
            return;
          }
          const data = await res.json();
          if (data.text) {
            onResult(data.text);
          }
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
    } catch (e) {
      console.error("[voice] microphone access denied:", e);
      setStatus("error");
    }
  }, [recording, onResult]);

  const voiceLoading = status === "transcribing";

  return { recording, status, toggle, voiceLoading, available };
}
