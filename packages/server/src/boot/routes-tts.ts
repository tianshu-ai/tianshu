// POST /api/tts: text -> audio proxy.
//
// Yu, 2026-09-19: supports two TTS backends selected by env
// TTS_PROVIDER:
//
//   "edge" (default) — Microsoft Edge's online TTS via the
//     @andresaya/edge-tts npm package. Zero local setup, no API key,
//     free unlimited use. Chinese voices (Xiaoxiao/Yunxi/Yunyang)
//     are near-production quality. Trade-off: needs internet;
//     Microsoft EULA forbids commercial use (fine for a personal
//     side project like tianshu, revisit before shipping).
//
//   "cosyvoice" — Local CosyVoice 2 FastAPI server (Apache 2.0,
//     ~150 ms first-packet latency, native Apple Silicon MPS).
//     Yu runs the CosyVoice server separately; tianshu forwards
//     via HTTP. See scripts/COSYVOICE_SETUP.md for setup.
//
// Same public contract in both cases:
//   POST /api/tts   body: { text, voice? }
//   → response body: audio/* (mp3 for edge, wav for cosyvoice)
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
  header.writeUInt32LE(36 + pcmByteLen, 4);
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
 * Edge TTS handler — synthesises via @andresaya/edge-tts, returns
 * MP3 bytes. Cloud-only, no local setup needed.
 */
async function handleEdge(
  res: Response,
  text: string,
  voice: string | undefined,
): Promise<void> {
  const useVoice = voice?.trim() || DEFAULT_EDGE_VOICE;
  const tts = new EdgeTTS();
  console.log(
    `[tts] edge synthesise: len=${text.length} voice=${useVoice}`,
  );
  try {
    await tts.synthesize(text, useVoice, {
      outputFormat: EDGE_OUTPUT_FORMAT,
    });
  } catch (err) {
    console.warn("[tts] edge synthesis failed:", err);
    res.status(502).json({
      error: "edge tts synthesis failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // API note (probed against @andresaya/edge-tts@1.8.0 on 2026-09-19):
  //   toBase64() and toRaw() both return the audio as a base64
  //   STRING (not Buffer, despite what "raw" sounds like). Neither
  //   getBase64 nor getAudioBuffer exists on this version. Use
  //   toBase64() explicitly — same output, clearer name.
  const b64 = (tts as unknown as { toBase64: () => string }).toBase64();
  if (!b64) {
    console.warn("[tts] edge returned empty audio");
    res.status(502).json({ error: "edge tts returned empty audio" });
    return;
  }
  const audio = Buffer.from(b64, "base64");

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Length", String(audio.length));
  res.setHeader("Cache-Control", "no-store");
  res.end(audio);

  console.log(`[tts] edge delivered mp3: ${audio.length}B`);
}

/**
 * CosyVoice handler — forwards to the local FastAPI server, buffers
 * PCM, prepends a wav header, streams back.
 */
async function handleCosyvoice(
  res: Response,
  text: string,
  voice: string | undefined,
): Promise<void> {
  const useVoice = voice?.trim() || DEFAULT_COSY_VOICE;
  const upstream = process.env.TTS_URL || DEFAULT_COSY_URL;
  const url = `${upstream}/inference_sft`;

  // CosyVoice's FastAPI expects multipart/form-data (server.py:
  // `tts_text: str = Form(), spk_id: str = Form()`).
  const form = new FormData();
  form.set("tts_text", text);
  form.set("spk_id", useVoice);

  console.log(
    `[tts] cosyvoice forwarding: len=${text.length} voice=${useVoice} url=${url}`,
  );

  let upstreamRes: globalThis.Response;
  try {
    upstreamRes = await fetch(url, { method: "POST", body: form });
  } catch (err) {
    console.warn(`[tts] cosyvoice upstream unreachable: ${upstream}`, err);
    res.status(503).json({
      error: "tts upstream unreachable",
      detail: err instanceof Error ? err.message : String(err),
      hint: `Is CosyVoice running at ${upstream}? See scripts/COSYVOICE_SETUP.md.`,
    });
    return;
  }

  if (!upstreamRes.ok || !upstreamRes.body) {
    console.warn(
      `[tts] cosyvoice upstream error: ${upstreamRes.status} ${upstreamRes.statusText}`,
    );
    res.status(upstreamRes.status).json({
      error: "tts upstream returned error",
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
    });
    return;
  }

  // Buffer full PCM then wrap with RIFF wav header (needs total
  // byte length up front). ~24 KB/s at 24 kHz mono int16 — a 10 s
  // reply is ~240 KB, safe in memory.
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const reader = upstreamRes.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      chunks.push(buf);
      totalBytes += buf.length;
    }
  } catch (err) {
    console.warn("[tts] cosyvoice stream aborted:", err);
    res.status(502).json({
      error: "tts upstream stream aborted",
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (totalBytes === 0) {
    console.warn("[tts] cosyvoice returned empty PCM");
    res.status(502).json({ error: "tts upstream returned empty audio" });
    return;
  }

  const header = buildWavHeader(totalBytes);
  const wavLen = header.length + totalBytes;

  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Content-Length", String(wavLen));
  res.setHeader("Cache-Control", "no-store");
  res.write(header);
  for (const chunk of chunks) res.write(chunk);
  res.end();

  console.log(
    `[tts] cosyvoice delivered wav: pcm=${totalBytes}B total=${wavLen}B ` +
      `(${(
        totalBytes /
        COSY_SAMPLE_RATE /
        (COSY_BITS_PER_SAMPLE / 8) /
        COSY_CHANNELS
      ).toFixed(1)}s)`,
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
    } else if (requestedProvider === "cosyvoice") {
      await handleCosyvoice(res, text, voice);
    } else {
      console.warn(`[tts] unknown provider: ${requestedProvider}`);
      res.status(400).json({
        error: `unknown provider: ${requestedProvider}`,
        hint: "Use provider=edge or provider=cosyvoice",
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
