// POST /api/tts: text -> audio proxy for CosyVoice 2.
//
// Yu, 2026-09-19: forwards to a locally-launched CosyVoice 2 FastAPI
// server that Yu starts separately (Apache 2.0, ~150 ms first-packet
// latency, native Apple Silicon MPS since commit 029f931).
//
// Wire protocol matches the official CosyVoice runtime/python/fastapi
// server.py at /main verbatim:
//
//   POST /inference_sft
//     form fields: tts_text=<string>, spk_id=<string>
//     response: StreamingResponse yielding raw int16 PCM bytes
//     (no wav header, no content-type sniffing help)
//
// The browser's <audio> element cannot play raw PCM directly, so
// this proxy:
//   1. sends multipart/form-data to CosyVoice
//   2. collects the PCM stream
//   3. prepends a RIFF/wav header (44 bytes)
//   4. streams the resulting wav-with-header back to the browser
//
// Both the sample rate (24000 for CosyVoice2-0.5B) and channels (1)
// are constants that match the model output. If Yu ever swaps to a
// model with a different rate we'd expose those as env vars.
//
// The upstream URL is read from env TTS_URL (default localhost:50000
// matching CosyVoice server.py's default port).
//
// First-cut is buffered rather than truly streamed to the browser —
// we collect the whole PCM stream, build the wav header (which
// needs the total byte count), then send. Streaming with a
// length-of-0xFFFFFFFF trick is possible if latency becomes a
// concern; leave it as a follow-up.

import type { Express, Request, Response } from "express";

/** Default CosyVoice FastAPI server URL when TTS_URL env is unset.
 *  Matches server.py's default `--port 50000`. */
const DEFAULT_TTS_URL = "http://localhost:50000";

/** CosyVoice2-0.5B outputs 24 kHz mono int16 PCM. Hardcoded to
 *  match the model; expose as env if we ever run a different one. */
const TTS_SAMPLE_RATE = 24000;
const TTS_CHANNELS = 1;
const TTS_BITS_PER_SAMPLE = 16;

/** Absolute cap on request text — we never let a browser paste a
 *  novel-length string; the upstream will time out anyway. */
const MAX_TEXT_CHARS = 4000;

/** Default speaker id passed to CosyVoice when the client doesn't
 *  specify one. CosyVoice SFT voices are named e.g. "中文女" /
 *  "中文男" / "英文女". Yu can override per-request. */
const DEFAULT_VOICE = "中文女";

interface TtsRequestBody {
  text?: unknown;
  voice?: unknown;
}

/**
 * Build a 44-byte RIFF wav header for mono int16 PCM.
 * https://docs.fileformat.com/audio/wav/ — canonical layout.
 */
function buildWavHeader(pcmByteLen: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate =
    TTS_SAMPLE_RATE * TTS_CHANNELS * (TTS_BITS_PER_SAMPLE / 8);
  const blockAlign = TTS_CHANNELS * (TTS_BITS_PER_SAMPLE / 8);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmByteLen, 4); // ChunkSize = 36 + Subchunk2Size
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size for PCM
  header.writeUInt16LE(1, 20); // AudioFormat 1 = PCM
  header.writeUInt16LE(TTS_CHANNELS, 22);
  header.writeUInt32LE(TTS_SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(TTS_BITS_PER_SAMPLE, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmByteLen, 40);

  return header;
}

export function mountTtsRoutes(app: Express) {
  app.post("/api/tts", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as TtsRequestBody;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const voice =
      typeof body.voice === "string" && body.voice.trim().length
        ? body.voice.trim()
        : DEFAULT_VOICE;

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

    const upstream = process.env.TTS_URL || DEFAULT_TTS_URL;
    const url = `${upstream}/inference_sft`;

    // CosyVoice's FastAPI uses form-data (per its server.py:
    // `tts_text: str = Form(), spk_id: str = Form()`). Node 18+
    // FormData is the WHATWG one which fetch() serialises as
    // multipart/form-data automatically.
    const form = new FormData();
    form.set("tts_text", text);
    form.set("spk_id", voice);

    console.log(
      `[tts] forwarding: len=${text.length} voice=${voice} url=${url}`,
    );

    let upstreamRes: globalThis.Response;
    try {
      upstreamRes = await fetch(url, { method: "POST", body: form });
    } catch (err) {
      console.warn(`[tts] upstream unreachable: ${upstream}`, err);
      res.status(503).json({
        error: "tts upstream unreachable",
        detail: err instanceof Error ? err.message : String(err),
        hint: `Is CosyVoice running at ${upstream}? Set TTS_URL env to change.`,
      });
      return;
    }

    if (!upstreamRes.ok || !upstreamRes.body) {
      console.warn(
        `[tts] upstream error: ${upstreamRes.status} ${upstreamRes.statusText}`,
      );
      res.status(upstreamRes.status).json({
        error: "tts upstream returned error",
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
      });
      return;
    }

    // CosyVoice yields raw int16 PCM bytes with no wav header. We
    // need the total byte length to build the header, so we buffer
    // the whole stream first, then send header + payload.
    // ~24 KB per second of audio at 24 kHz mono int16, so a 10 s
    // reply is ~240 KB — small enough to buffer in memory without
    // concern.
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
      console.warn("[tts] read from upstream failed:", err);
      res.status(502).json({
        error: "tts upstream stream aborted",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (totalBytes === 0) {
      console.warn("[tts] upstream returned empty PCM stream");
      res.status(502).json({ error: "tts upstream returned empty audio" });
      return;
    }

    const header = buildWavHeader(totalBytes);
    const wavLen = header.length + totalBytes;

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", String(wavLen));
    res.setHeader("Cache-Control", "no-store");

    res.write(header);
    for (const chunk of chunks) {
      res.write(chunk);
    }
    res.end();

    console.log(
      `[tts] delivered wav: pcm=${totalBytes}B total=${wavLen}B (${(
        totalBytes /
        TTS_SAMPLE_RATE /
        (TTS_BITS_PER_SAMPLE / 8) /
        TTS_CHANNELS
      ).toFixed(1)}s)`,
    );
  });

  console.log(
    `[tts] mounted /api/tts upstream=${process.env.TTS_URL || DEFAULT_TTS_URL}`,
  );
}
