// POST /api/tts: text -> audio proxy.
//
// Yu, 2026-09-19: initial version with edge + cosyvoice.
// Yu, 2026-09-20: replaced cosyvoice/kokoro with qwentts.
//   CosyVoice (RTF 6x, too slow) and Kokoro (sounds like edge-tts)
//   are removed. Only edge and qwentts remain.
//
// TTS_PROVIDER env selects the default backend:
//
//   "edge" (default) — Microsoft Edge's online TTS via the
//     @andresaya/edge-tts npm package. Zero local setup, no API key.
//     Chinese voices (Xiaoxiao/Yunxi/Yunyang) are near-production
//     quality. Needs internet; Microsoft EULA forbids commercial use.
//
//   "qwentts" — Local Qwen3-TTS 0.6B MLX server (Apache 2.0,
//     RTF ~0.3x on Apple Silicon, 9 preset voices, 10 languages).
//     See scripts/QWEN3_TTS_SETUP.md for setup.
//
// Same public contract in both cases:
//   POST /api/tts   body: { text, voice?, provider? }
//   → response body: audio/* (mp3 for edge, wav for qwentts)
//
// Browser <audio> plays either directly; useTts hook doesn't care.

import type { Express, Request, Response } from "express";
import { EdgeTTS } from "@andresaya/edge-tts";

// ─── Common config ───────────────────────────────────────────

/** Which backend to use. Default "edge" because it works out of
 *  the box with no local deps; user can switch to "cosyvoice"
 *  once that's running locally. */
const TTS_PROVIDER = (process.env.TTS_PROVIDER || "edge").toLowerCase();

/** Absolute cap on request text — we never let a browser paste a
 *  novel-length string; the upstream will time out anyway. */
const MAX_TEXT_CHARS = 4000;

// ─── Edge TTS config ─────────────────────────────────────────

/** Default Chinese voice when the client doesn't specify one.
 *  Xiaoxiao is Microsoft's flagship zh-CN voice — natural
 *  prosody, works for both formal and conversational text.
 *  Alternatives: zh-CN-YunxiNeural (male), zh-CN-YunyangNeural
 *  (male, newscaster), en-US-AriaNeural (English female). */
const DEFAULT_EDGE_VOICE = "zh-CN-XiaoxiaoNeural";

/** Edge output format — 24 kHz mono MP3 at 96 kbps. Browsers
 *  play mp3 natively via <audio>, no header building needed. */
const EDGE_OUTPUT_FORMAT = "audio-24khz-96kbitrate-mono-mp3";

// ─── CosyVoice config ────────────────────────────────────────

/** CosyVoice FastAPI server URL (default matches server.py's
 *  `--port 50000`). */
const DEFAULT_COSY_URL = "http://localhost:50000";

/** CosyVoice2-0.5B outputs 24 kHz mono int16 PCM. Hardcoded to
 *  match the model; expose as env if we run a different one. */
const COSY_SAMPLE_RATE = 24000;
const COSY_CHANNELS = 1;
const COSY_BITS_PER_SAMPLE = 16;

/** Default CosyVoice speaker id. */
const DEFAULT_COSY_VOICE = "中文女";

interface TtsRequestBody {
  text?: unknown;
  voice?: unknown;
  /** Per-request override of TTS_PROVIDER env. Set by the client
   *  when the user picked a provider in Settings. Falls back to
   *  TTS_PROVIDER env when omitted. */
  provider?: unknown;
}

/**
 * Build a 44-byte RIFF wav header for mono int16 PCM.
 * Used by the CosyVoice branch because CosyVoice yields raw PCM.
 */
function buildWavHeader(pcmByteLen: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate =
    COSY_SAMPLE_RATE * COSY_CHANNELS * (COSY_BITS_PER_SAMPLE / 8);
  const blockAlign = COSY_CHANNELS * (COSY_BITS_PER_SAMPLE / 8);

  header.write("RIFF", 0);
  // For streaming (pcmByteLen=0xFFFFFFFF), RIFF chunk size is also
  // 0xFFFFFFFF — signals unknown length to decoders.
  header.writeUInt32LE(
    pcmByteLen === 0xFFFFFFFF ? 0xFFFFFFFF : 36 + pcmByteLen,
    4,
  );
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(COSY_CHANNELS, 22);
  header.writeUInt32LE(COSY_SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(COSY_BITS_PER_SAMPLE, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmByteLen, 40);

  return header;
}

/**
 * Edge TTS handler — streams mp3 chunks via @andresaya/edge-tts's
 * synthesizeStream() async iterator.
 *
 * Yu, 2026-09-19 21:27: switched from batch synthesize() +
 * toBase64() to streaming. Reason: edge-tts's cloud endpoint has
 * ~1.8s first-byte latency; the batch path also waited for the
 * FULL synthesis before returning (~2.6s), so users heard silence
 * for ~2s after the reply text finished streaming. Streaming
 * halves the perceived delay because express flushes each chunk
 * to the browser and MediaSource on the client starts playback
 * as soon as the first chunk arrives.
 *
 * Wire-level (probed 2026-09-19 against @andresaya/edge-tts@1.8.0):
 *   synthesizeStream(text, voice, { outputFormat })
 *     → AsyncIterable<Uint8Array>
 *   Each chunk is ~1.4 KB of raw MP3 frames aligned on frame
 *   boundaries. Content-Type is audio/mpeg. No trailing footer or
 *   completion marker — iterator just ends.
 *
 * Response uses chunked transfer encoding implicitly (express
 * writes without Content-Length). Client MediaSource + fetch
 * ReadableStream + SourceBuffer.appendBuffer plays as chunks land.
 */
async function handleEdge(
  res: Response,
  text: string,
  voice: string | undefined,
): Promise<void> {
  const useVoice = voice?.trim() || DEFAULT_EDGE_VOICE;
  const tts = new EdgeTTS();

  console.log(
    `[tts] edge streaming synthesise: len=${text.length} voice=${useVoice}`,
  );

  // Set headers up-front; don't set Content-Length — that would
  // require buffering the whole thing.
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  // Explicitly disable Nagle-style buffering on the response so
  // the first chunk gets flushed to the client immediately.
  res.setHeader("X-Accel-Buffering", "no");

  const start = Date.now();
  let chunkCount = 0;
  let byteCount = 0;
  let firstChunkMs: number | null = null;

  try {
    const iter = (tts as unknown as {
      synthesizeStream: (
        text: string,
        voice: string,
        opts: { outputFormat: string },
      ) => AsyncIterable<Uint8Array>;
    }).synthesizeStream(text, useVoice, { outputFormat: EDGE_OUTPUT_FORMAT });
    for await (const chunk of iter) {
      if (firstChunkMs == null) firstChunkMs = Date.now() - start;
      chunkCount++;
      byteCount += chunk.length;
      res.write(Buffer.from(chunk));
    }
  } catch (err) {
    console.warn("[tts] edge stream failed mid-flight:", err);
    // Headers already sent; can't return a JSON error body. Best
    // effort: end the response so the browser sees an empty stream.
    try {
      res.end();
    } catch {
      // ignore
    }
    return;
  }

  res.end();
  console.log(
    `[tts] edge streamed mp3: ${byteCount}B in ${chunkCount} chunks ` +
      `(first at ${firstChunkMs}ms, total ${Date.now() - start}ms)`,
  );
}

/**
 * Local TTS handler — forwards to a local FastAPI server (Kokoro or
 * CosyVoice) and streams WAV back to the browser.
 *
 * Yu, 2026-09-20: rewritten from buffer-all to true streaming.
 * Old path buffered ALL PCM before prepending the WAV header,
 * which meant 9+ seconds silence on CosyVoice before audio started.
 *
 * New path:
 *   1. Send a WAV header with data-size = 0xFFFFFFFF (streaming
 *      marker; browsers / MediaSource treat this as "unknown length,
 *      keep reading until connection closes").
 *   2. Pipe upstream PCM chunks directly to the HTTP response as
 *      they arrive — first audio byte reaches the browser as soon
 *      as the model yields its first chunk.
 *   3. Connection close signals end-of-stream.
 *
 * Works with both Kokoro (RTF ~0.4x, first chunk ~2s) and CosyVoice
 * (RTF ~6x, first chunk ~9s). The streaming path benefits Kokoro
 * enormously; CosyVoice still has a long first-chunk wait but at
 * least doesn't add extra buffering delay on top.
 */
async function handleLocalTts(
  res: Response,
  text: string,
  voice: string | undefined,
  providerLabel: string,
): Promise<void> {
  const useVoice = voice?.trim() || DEFAULT_COSY_VOICE;
  const upstream = process.env.TTS_URL || DEFAULT_COSY_URL;
  const url = `${upstream}/inference_sft`;

  const form = new FormData();
  form.set("tts_text", text);
  form.set("spk_id", useVoice);

  console.log(
    `[tts] ${providerLabel} forwarding: len=${text.length} voice=${useVoice} url=${url}`,
  );

  let upstreamRes: globalThis.Response;
  try {
    upstreamRes = await fetch(url, { method: "POST", body: form });
  } catch (err) {
    console.warn(`[tts] ${providerLabel} upstream unreachable: ${upstream}`, err);
    res.status(503).json({
      error: "tts upstream unreachable",
      detail: err instanceof Error ? err.message : String(err),
      hint: `Is the TTS server running at ${upstream}?`,
    });
    return;
  }

  if (!upstreamRes.ok || !upstreamRes.body) {
    console.warn(
      `[tts] ${providerLabel} upstream error: ${upstreamRes.status} ${upstreamRes.statusText}`,
    );
    res.status(upstreamRes.status).json({
      error: "tts upstream returned error",
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
    });
    return;
  }

  // Stream WAV: send header immediately with unknown data size,
  // then pipe PCM chunks as they arrive from upstream.
  const streamingHeader = buildWavHeader(0xFFFFFFFF);
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  res.write(streamingHeader);

  const start = Date.now();
  let totalBytes = 0;
  let chunkCount = 0;
  let firstChunkMs: number | null = null;

  const reader = upstreamRes.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      if (firstChunkMs == null) firstChunkMs = Date.now() - start;
      totalBytes += buf.length;
      chunkCount++;
      res.write(buf);
    }
  } catch (err) {
    console.warn(`[tts] ${providerLabel} stream aborted:`, err);
    // Headers already sent; just close the response.
  }

  res.end();

  if (totalBytes === 0) {
    console.warn(`[tts] ${providerLabel} returned empty PCM`);
    return;
  }

  const audioDur =
    totalBytes / COSY_SAMPLE_RATE / (COSY_BITS_PER_SAMPLE / 8) / COSY_CHANNELS;
  console.log(
    `[tts] ${providerLabel} streamed wav: ${totalBytes}B in ${chunkCount} chunks ` +
      `(first at ${firstChunkMs}ms, total ${Date.now() - start}ms, ` +
      `${audioDur.toFixed(1)}s audio)`,
  );
}

export function mountTtsRoutes(app: Express) {
  app.post("/api/tts", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as TtsRequestBody;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const voice =
      typeof body.voice === "string" && body.voice.trim().length
        ? body.voice.trim()
        : undefined;
    // Client override wins over env default. Yu, 2026-09-19: added
    // so the Settings page can flip between edge/cosyvoice without
    // restarting the server.
    const requestedProvider =
      typeof body.provider === "string" &&
      body.provider.trim().length
        ? body.provider.trim().toLowerCase()
        : TTS_PROVIDER;

    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    if (text.length > MAX_TEXT_CHARS) {
      res.status(400).json({
        error: `text too long: ${text.length} chars > max ${MAX_TEXT_CHARS}`,
      });
      return;
    }

    if (requestedProvider === "edge") {
      await handleEdge(res, text, voice);
    } else if (requestedProvider === "qwentts") {
      await handleLocalTts(res, text, voice, requestedProvider);
    } else {
      console.warn(`[tts] unknown provider: ${requestedProvider}`);
      res.status(400).json({
        error: `unknown provider: ${requestedProvider}`,
        hint: "Use provider=edge or provider=qwentts",
      });
    }
  });

  // GET /api/tts/status
  //
  // Powers the Settings > Text-to-Speech page. Reports:
  //   - providerDefault: server's TTS_PROVIDER env (client uses
  //     this as a fallback when the user has no preference yet)
  //   - cosyvoiceUrl: env TTS_URL (or default) so the user can see
  //     what external service the server is pointed at
  //   - cosyvoiceReachable: null (didn't probe) | true | false
  //     — probes only when the caller asked for it via ?probe=1,
  //     because Yu is happy to launch CosyVoice separately and
  //     doesn't want a health check on every settings page load.
  app.get("/api/tts/status", async (req: Request, res: Response) => {
    const cosyvoiceUrl = process.env.TTS_URL || DEFAULT_COSY_URL;
    let cosyvoiceReachable: boolean | null = null;
    const shouldProbe = String(req.query.probe ?? "1") === "1";
    if (shouldProbe) {
      try {
        // We don't have a dedicated health endpoint on CosyVoice's
        // FastAPI server, so probe /docs (auto-generated by FastAPI
        // — cheap, always present, no side effects).
        const probe = await fetch(`${cosyvoiceUrl}/docs`, {
          method: "GET",
          signal: AbortSignal.timeout(1500),
        });
        cosyvoiceReachable = probe.ok;
      } catch {
        cosyvoiceReachable = false;
      }
    }
    res.json({
      providerDefault: TTS_PROVIDER,
      cosyvoiceUrl,
      cosyvoiceReachable,
    });
  });

  console.log(`[tts] mounted /api/tts + /api/tts/status provider=${TTS_PROVIDER}`);
}
