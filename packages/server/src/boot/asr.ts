/**
 * Server-side ASR using sherpa-onnx-node (paraformer-zh-small).
 * Zero Python dependency — pure Node.js C++ addon.
 *
 * POST /api/transcribe
 * Body: raw audio (audio/webm, audio/wav, etc.)
 * Response: { text: "识别结果" }
 */

import { type Express, type Request, type Response } from "express";
import { execSync } from "node:child_process";

/** Resolve ffmpeg binary: ffmpeg-static (bundled) → system PATH */
function getFfmpegPath(): string {
  try {
    // @ts-ignore
    const staticPath = require("ffmpeg-static");
    if (staticPath && fs.existsSync(staticPath)) return staticPath;
  } catch {}
  return "ffmpeg"; // fallback to system PATH
}
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getTianshuHome } from "../core/paths.js";

// Yu, 2026-09-19: dual-mode ASR support. Only one recognizer is live
// at a time — the active model in ~/.tianshu/models/active-asr-model.txt
// decides which. Downstream code should read `activeMode` before
// touching either recognizer variable; the wrong one is always null.
let offlineRecognizer: any = null;
let onlineRecognizer: any = null;
let activeMode: "offline" | "online" | null = null;

/** For legacy compatibility — several places still refer to `recognizer`
 *  through this getter, meaning “whichever recognizer is loaded”. */
function getActiveRecognizer(): any {
  return activeMode === "online" ? onlineRecognizer : offlineRecognizer;
}

/** Exposed for the /ws/asr endpoint. Returns the OnlineRecognizer
 *  handle if the active model is streaming, otherwise null. */
export function getOnlineRecognizer(): any {
  return activeMode === "online" ? onlineRecognizer : null;
}

/** True iff a streaming (online) recognizer is currently loaded. */
export function isOnlineActive(): boolean {
  return activeMode === "online" && onlineRecognizer !== null;
}

/** Ensure a recognizer is loaded. Used by /ws/asr to lazy-init on
 *  the first connection instead of failing when boot-time init lost
 *  the race (e.g. the model was downloaded after server start). */
export async function ensureRecognizer(): Promise<boolean> {
  return initRecognizer();
}

/** Force reload the recognizer (called when admin activates a model). */
export async function reloadAsrModel(): Promise<boolean> {
  // Yu, 2026-09-19: reset both variants so a mode switch (offline
  // ↔ online) actually rebinds. Prior code only cleared the single
  // `recognizer` slot which is now gone.
  offlineRecognizer = null;
  onlineRecognizer = null;
  activeMode = null;
  return initRecognizer();
}

// Model preference order: best quality first
// Model preference order. `arch` chooses the sherpa modelConfig
// shape; `mode` chooses OfflineRecognizer vs OnlineRecognizer.
interface ModelCandidate {
  dir: string;
  arch: "senseVoice" | "paraformer" | "whisper" | "zipformer";
  mode: "offline" | "online";
  model: string;  // for zipformer this is the encoder
  tokens: string;
}

type CandidateSpec = {
  id: string;
  dirName: string;
  arch: ModelCandidate["arch"];
  mode: ModelCandidate["mode"];
  model: string;
  tokens: string;
};

const MODEL_CANDIDATES: CandidateSpec[] = [
  // Offline models — best quality first.
  { id: "sense-voice-zh", dirName: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17", arch: "senseVoice", mode: "offline", model: "model.int8.onnx", tokens: "tokens.txt" },
  { id: "paraformer-zh", dirName: "sherpa-onnx-paraformer-zh-2024-03-09", arch: "paraformer", mode: "offline", model: "model.int8.onnx", tokens: "tokens.txt" },
  { id: "paraformer-zh-small", dirName: "sherpa-onnx-paraformer-zh-small-2024-03-09", arch: "paraformer", mode: "offline", model: "model.int8.onnx", tokens: "tokens.txt" },
  { id: "whisper-tiny", dirName: "sherpa-onnx-whisper-tiny", arch: "whisper", mode: "offline", model: "tiny-encoder.int8.onnx", tokens: "tiny-tokens.txt" },

  // Streaming (online) — for WS /ws/asr real-time partials.
  // For zipformer the `model` field points to the encoder; the actual
  // recognizer needs the tuple of encoder+decoder+joiner — initRecognizer
  // derives decoder/joiner from the same directory.
  { id: "streaming-zipformer-bilingual", dirName: "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20", arch: "zipformer", mode: "online", model: "encoder-epoch-99-avg-1.int8.onnx", tokens: "tokens.txt" },
];

function getModelsRoots(): string[] {
  return [
    path.join(getTianshuHome(), "models"),
  ];
}

function findBestModel(): ModelCandidate | null {
  const modelsRoot = getModelsRoots()[0];

  // Check if admin selected a specific model.
  // Yu, 2026-09-19: replaced the old index-based byId map with a
  // find-by-id lookup so adding a new streaming candidate doesn't
  // silently break the mapping.
  const activeFile = path.join(modelsRoot, "active-asr-model.txt");
  if (fs.existsSync(activeFile)) {
    const activeId = fs.readFileSync(activeFile, "utf8").trim();
    const pick = MODEL_CANDIDATES.find((c) => c.id === activeId);
    if (pick) {
      const dir = path.join(modelsRoot, pick.dirName);
      if (fs.existsSync(path.join(dir, pick.model)) && fs.existsSync(path.join(dir, pick.tokens))) {
        return { dir, arch: pick.arch, mode: pick.mode, model: pick.model, tokens: pick.tokens };
      }
    }
  }

  // Fallback: auto-select best available.
  for (const c of MODEL_CANDIDATES) {
    const dir = path.join(modelsRoot, c.dirName);
    if (fs.existsSync(path.join(dir, c.model)) && fs.existsSync(path.join(dir, c.tokens))) {
      return { dir, arch: c.arch, mode: c.mode, model: c.model, tokens: c.tokens };
    }
  }
  return null;
}

async function initRecognizer(): Promise<boolean> {
  if (getActiveRecognizer()) return true;
  const best = findBestModel();
  if (!best) {
    console.warn("[asr] no ASR model found — transcribe endpoint disabled. Download one from Settings → 语音识别.");
    return false;
  }
  try {
    // @ts-ignore — no type declarations for sherpa-onnx-node
    const mod = await import("sherpa-onnx-node");
    if (best.mode === "online") {
      return initOnlineRecognizer(mod, best);
    }
    return initOfflineRecognizer(mod, best);
  } catch (e) {
    console.warn("[asr] failed to load sherpa-onnx:", e);
    return false;
  }
}

function initOfflineRecognizer(mod: any, best: ModelCandidate): boolean {
  const OfflineRecognizer = mod.OfflineRecognizer ?? mod.default?.OfflineRecognizer;
  if (!OfflineRecognizer) {
    console.warn("[asr] sherpa-onnx-node has no OfflineRecognizer export");
    return false;
  }
  const modelPath = path.join(best.dir, best.model);
  const tokensPath = path.join(best.dir, best.tokens);
  let modelConfig: Record<string, unknown>;

  if (best.arch === "senseVoice") {
    modelConfig = {
      senseVoice: { model: modelPath, language: "auto", useInverseTextNormalization: 1 },
      tokens: tokensPath,
      numThreads: 4,
    };
  } else if (best.arch === "whisper") {
    const decoderPath = modelPath.replace("encoder", "decoder");
    modelConfig = {
      whisper: { encoder: modelPath, decoder: decoderPath, language: "zh" },
      tokens: tokensPath,
      numThreads: 4,
    };
  } else {
    // paraformer (offline)
    modelConfig = {
      paraformer: { model: modelPath },
      tokens: tokensPath,
      numThreads: 4,
    };
  }

  offlineRecognizer = new OfflineRecognizer({ modelConfig });
  activeMode = "offline";
  console.log(`[asr] loaded offline ${best.arch} from ${best.dir}`);
  return true;
}

/**
 * Streaming recognizer init. Yu, 2026-09-19: only zipformer supported
 * today (validated end-to-end by scripts/spike-online-asr.mjs). Adding
 * more online model families is a matter of extending this switch and
 * MODEL_CANDIDATES.
 *
 * zipformer needs three onnx files (encoder + decoder + joiner); we
 * derive decoder/joiner by name substitution from the encoder path
 * because sherpa release archives use that convention.
 */
function initOnlineRecognizer(mod: any, best: ModelCandidate): boolean {
  const OnlineRecognizer = mod.OnlineRecognizer ?? mod.default?.OnlineRecognizer;
  if (!OnlineRecognizer) {
    console.warn("[asr] sherpa-onnx-node has no OnlineRecognizer export");
    return false;
  }
  const encoderPath = path.join(best.dir, best.model);
  const decoderPath = encoderPath.replace("encoder", "decoder");
  const joinerPath = encoderPath.replace("encoder", "joiner");
  const tokensPath = path.join(best.dir, best.tokens);

  if (best.arch !== "zipformer") {
    console.warn(`[asr] online arch "${best.arch}" not yet wired \u2014 only zipformer supported`);
    return false;
  }

  const config = {
    modelConfig: {
      transducer: {
        encoder: encoderPath,
        decoder: decoderPath,
        joiner: joinerPath,
      },
      tokens: tokensPath,
      numThreads: 4,
    },
    // Endpoint detection lets a caller notice the user paused; the WS
    // handler will use it to finalise one utterance and start another
    // without tearing down the recognizer.
    enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20,
  };

  onlineRecognizer = new OnlineRecognizer(config);
  activeMode = "online";
  console.log(`[asr] loaded online ${best.arch} from ${best.dir}`);
  return true;
}

/**
 * Convert audio to 16kHz mono WAV using ffmpeg.
 * Returns the path to the temp WAV file.
 */
function convertToWav(inputPath: string): string {
  const wavPath = inputPath + ".wav";
  const ffmpeg = getFfmpegPath();
  execSync(
    `"${ffmpeg}" -y -i "${inputPath}" -ar 16000 -ac 1 -f wav "${wavPath}" 2>/dev/null`,
  );
  return wavPath;
}

/**
 * Read WAV file and return Float32Array of samples.
 */
function readWavSamples(wavPath: string): { samples: Float32Array; sampleRate: number } {
  const buf = fs.readFileSync(wavPath);
  // Skip 44-byte WAV header, read 16-bit PCM
  const dataStart = 44;
  const int16 = new Int16Array(buf.buffer, buf.byteOffset + dataStart, (buf.byteLength - dataStart) / 2);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }
  return { samples: float32, sampleRate: 16000 };
}

/**
 * Public ASR routes — no tenant/auth required.
 *
 * Mount BEFORE tenantMiddleware. Only exposes read-only availability
 * checks; no audio data crosses this boundary.
 *
 * Kicks off initRecognizer as a side effect so the model is warm by
 * the time the first POST arrives on the authed route.
 */
export function mountAsrPublicRoutes(app: Express): void {
  // Try to init at mount time (fire-and-forget, won't block boot)
  initRecognizer().then((ok) => {
    if (ok) console.log("[asr] POST /api/transcribe ready");
  });

  // Lightweight check — frontend hides mic button when ASR is unavailable
  app.get("/api/transcribe/status", async (_req: Request, res: Response) => {
    // Check if sherpa-onnx-node is installed
    let runtimeInstalled = true;
    // @ts-ignore
    try { await import("sherpa-onnx-node"); } catch { runtimeInstalled = false; }
    res.json({
      available: !!getActiveRecognizer(),
      // Yu, 2026-09-19: expose active mode so the frontend knows
      // whether streaming (WS /ws/asr) or one-shot (POST /api/transcribe)
      // is the right entry point for this install.
      mode: activeMode,
      runtimeInstalled,
    });
  });
}

/**
 * Authed ASR route — audio upload endpoint.
 *
 * Mount AFTER tenantMiddleware. The handler still keeps a defensive
 * `!req.ctx` check, but with correct mount order it should never
 * trip — tenantMiddleware either sets req.ctx or 401's the request
 * before it reaches here.
 *
 * Yu, 2026-09-19 13:48: this used to be part of mountAsrRoute() and
 * was mounted BEFORE tenantMiddleware in index.ts. That meant every
 * upload got a 401 in dev and in the deployed CLI — req.ctx was
 * never populated. Split into two functions so mount order is
 * unambiguous.
 */
export function mountAsrAuthedRoutes(app: Express): void {
  app.post("/api/transcribe", async (req: Request, res: Response) => {
    // Require authentication — reject anonymous requests
    if (!req.ctx) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    // Yu, 2026-09-19: this route is the offline (one-shot) path only.
    // If the active model is online, the caller should switch to the
    // WS endpoint; refuse rather than silently misbehave.
    if (!offlineRecognizer && !(await initRecognizer())) {
      res.status(503).json({ error: "ASR model not loaded" });
      return;
    }
    if (activeMode !== "offline") {
      res.status(409).json({
        error: `active ASR model is ${activeMode}; use WS /ws/asr for streaming input`,
      });
      return;
    }

    // Collect body as buffer
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const audioBuffer = Buffer.concat(chunks);
      if (audioBuffer.length === 0) {
        res.status(400).json({ error: "empty audio" });
        return;
      }

      // Write to temp file, convert to WAV, transcribe
      const tmpDir = os.tmpdir();
      const tmpInput = path.join(tmpDir, `asr-${Date.now()}.webm`);
      const tmpWav = tmpInput + ".wav";

      try {
        fs.writeFileSync(tmpInput, audioBuffer);
        const wavPath = convertToWav(tmpInput);
        const { samples, sampleRate } = readWavSamples(wavPath);

        const stream = offlineRecognizer.createStream();
        stream.acceptWaveform({ samples, sampleRate });
        offlineRecognizer.decode(stream);
        const text = offlineRecognizer.getResult(stream).text || "";

        res.json({ text: text.trim() });
      } catch (e) {
        res.status(500).json({ error: `transcription failed: ${e}` });
      } finally {
        // Cleanup
        try { fs.unlinkSync(tmpInput); } catch {}
        try { fs.unlinkSync(tmpWav); } catch {}
      }
    });
  });

}
