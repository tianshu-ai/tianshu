/**
 * Web Worker for in-browser Whisper speech recognition.
 *
 * Uses @huggingface/transformers to run whisper-small ONNX model
 * entirely in the browser (WebGPU when available, WASM fallback).
 * Model is cached in IndexedDB after first download (~250MB).
 *
 * Protocol:
 *   Main → Worker:  { type: "transcribe", audio: Float32Array }
 *   Worker → Main:  { type: "result", text: string }
 *   Worker → Main:  { type: "status", status: "loading" | "ready" | "transcribing" }
 *   Worker → Main:  { type: "error", error: string }
 *   Main → Worker:  { type: "load" }  // pre-load model
 */

import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

// Route model downloads through tianshu's own /api/hf-proxy/ endpoint.
// The server proxies to HF or a configured mirror (HF_MIRROR env var),
// solving both CORS and GFW issues. Cached with immutable headers.
env.remoteHost = `${self.location.origin}/api/hf-proxy/`;

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;

const MODEL_ID = "onnx-community/whisper-small";

async function loadModel() {
  if (transcriber) return;
  self.postMessage({ type: "status", status: "loading" });
  try {
    transcriber = await pipeline("automatic-speech-recognition", MODEL_ID, {
      dtype: "q4",          // quantized for speed
      device: "auto",       // WebGPU > WASM
    });
    self.postMessage({ type: "status", status: "ready" });
  } catch (e) {
    self.postMessage({ type: "error", error: `Model load failed: ${e}` });
  }
}

async function transcribe(audio: Float32Array) {
  if (!transcriber) await loadModel();
  if (!transcriber) return;

  self.postMessage({ type: "status", status: "transcribing" });
  try {
    const result = await transcriber(audio, {
      language: "chinese",
      task: "transcribe",
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const text = typeof result === "string"
      ? result
      : (result as { text: string }).text ?? "";
    self.postMessage({ type: "result", text: text.trim() });
  } catch (e) {
    self.postMessage({ type: "error", error: `Transcription failed: ${e}` });
  }
}

self.onmessage = (e: MessageEvent) => {
  const { type } = e.data;
  if (type === "load") {
    void loadModel();
  } else if (type === "transcribe") {
    void transcribe(e.data.audio as Float32Array);
  }
};
