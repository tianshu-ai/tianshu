// POST /api/tts: text -> audio proxy.
//
// Yu, 2026-09-19: split off from the ASR streaming spike after we
// abandoned the sherpa in-process route. This one is smaller in
// scope: tianshu doesn't run a TTS model itself — it forwards to
// a locally-launched CosyVoice 2 FastAPI server that Yu starts
// separately. CosyVoice is the current best local TTS for Chinese
// (Apache 2.0, ~150 ms first-packet latency, native Apple Silicon
// MPS support since commit 029f931).
//
// Wire protocol assumption (to be confirmed on first end-to-end
// integration): the upstream is CosyVoice's `runtime/python/fastapi`
// server, which exposes:
//   POST /inference_sft?tts_text=<url-encoded>&spk_id=<voice>
//   → response body: audio/wav bytes (or WebM/PCM stream depending
//     on server config)
// If Yu's server implements a different shape, we adapt this
// handler; the API tianshu exposes to the browser stays stable at:
//   POST /api/tts   body: { text, voice? }
//   → response body: audio/* (whatever the upstream produced)
//
// We deliberately do NOT stream the response to the browser in
// this first cut. Fetching the whole clip once and playing it is
// simpler to debug end-to-end; if latency is unacceptable after
// integration we switch to WebSocket or fetch() streaming.
//
// The upstream URL is read from env TTS_URL (default localhost:8000)
// so Yu can point at a different port or a remote server without
// code changes.

import type { Express, Request, Response } from "express";

/** Default CosyVoice FastAPI server URL when TTS_URL env is unset. */
const DEFAULT_TTS_URL = "http://localhost:8000";

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

export function mountTtsRoutes(app: Express) {
  app.post("/api/tts", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as TtsRequestBody;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const voice = typeof body.voice === "string" && body.voice.trim().length
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
    // Encode both fields as query params; CosyVoice's FastAPI server
    // takes them that way rather than as JSON body. If we later
    // support a JSON-body-shaped upstream we'll branch on config.
    const url =
      `${upstream}/inference_sft?tts_text=${encodeURIComponent(text)}` +
      `&spk_id=${encodeURIComponent(voice)}`;

    console.log(`[tts] forwarding: len=${text.length} voice=${voice} url=${url}`);

    let upstreamRes: globalThis.Response;
    try {
      upstreamRes = await fetch(url, { method: "POST" });
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
      console.warn(`[tts] upstream error: ${upstreamRes.status} ${upstreamRes.statusText}`);
      res.status(upstreamRes.status).json({
        error: "tts upstream returned error",
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
      });
      return;
    }

    // Pass content-type through so the browser knows how to play it.
    const contentType =
      upstreamRes.headers.get("content-type") ?? "audio/wav";
    res.setHeader("Content-Type", contentType);
    // No caching — the same text could be generated with different
    // voices later, and we don't want stale audio.
    res.setHeader("Cache-Control", "no-store");

    // Node 18+ has WHATWG streams; pipe them into the express response.
    const reader = upstreamRes.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (err) {
      console.warn("[tts] stream copy failed mid-response:", err);
      // Best effort — headers already sent, just close the connection.
      try {
        res.end();
      } catch {
        // response already closed
      }
    }
  });

  console.log(`[tts] mounted /api/tts upstream=${process.env.TTS_URL || DEFAULT_TTS_URL}`);
}
