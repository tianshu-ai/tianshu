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
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getTianshuHome } from "../core/paths.js";

let recognizer: any = null;

/** Force reload the recognizer (called when admin activates a model). */
export async function reloadAsrModel(): Promise<boolean> {
  recognizer = null;
  return initRecognizer();
}

// Model preference order: best quality first
interface ModelCandidate {
  dir: string;
  type: "senseVoice" | "paraformer" | "whisper";
  model: string;  // relative to dir
  tokens: string;
}

const MODEL_CANDIDATES: { dirName: string; type: ModelCandidate["type"]; model: string }[] = [
  { dirName: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17", type: "senseVoice", model: "model.int8.onnx" },
  { dirName: "sherpa-onnx-paraformer-zh-2024-03-09", type: "paraformer", model: "model.int8.onnx" },
  { dirName: "sherpa-onnx-paraformer-zh-small-2024-03-09", type: "paraformer", model: "model.int8.onnx" },
  { dirName: "sherpa-onnx-whisper-tiny", type: "whisper", model: "tiny-encoder.int8.onnx" },
];

function getModelsRoots(): string[] {
  return [
    path.join(getTianshuHome(), "models"),
  ];
}

function findBestModel(): ModelCandidate | null {
  const modelsRoot = getModelsRoots()[0];

  // Check if admin selected a specific model
  const activeFile = path.join(modelsRoot, "active-asr-model.txt");
  if (fs.existsSync(activeFile)) {
    const activeId = fs.readFileSync(activeFile, "utf8").trim();
    const byId: Record<string, typeof MODEL_CANDIDATES[0]> = {
      "paraformer-zh-small": MODEL_CANDIDATES[2],
      "paraformer-zh": MODEL_CANDIDATES[1],
      "sense-voice-zh": MODEL_CANDIDATES[0],
      "whisper-tiny": MODEL_CANDIDATES[3],
    };
    const pick = byId[activeId];
    if (pick) {
      const dir = path.join(modelsRoot, pick.dirName);
      if (fs.existsSync(path.join(dir, pick.model))) {
        return { dir, type: pick.type, model: pick.model, tokens: "tokens.txt" };
      }
    }
  }

  // Fallback: auto-select best available
  for (const c of MODEL_CANDIDATES) {
    const dir = path.join(modelsRoot, c.dirName);
    if (fs.existsSync(path.join(dir, c.model)) && fs.existsSync(path.join(dir, "tokens.txt"))) {
      return { dir, type: c.type, model: c.model, tokens: "tokens.txt" };
    }
  }
  return null;
}

async function initRecognizer(): Promise<boolean> {
  if (recognizer) return true;
  const best = findBestModel();
  if (!best) {
    console.warn("[asr] no ASR model found — transcribe endpoint disabled. Download one from Settings → 语音识别.");
    return false;
  }
  try {
    // @ts-ignore — no type declarations for sherpa-onnx-node
    const mod = await import("sherpa-onnx-node");
    const OfflineRecognizer = mod.OfflineRecognizer ?? mod.default?.OfflineRecognizer;

    // Build config based on model type
    const modelPath = path.join(best.dir, best.model);
    const tokensPath = path.join(best.dir, best.tokens);
    let modelConfig: Record<string, unknown>;

    if (best.type === "senseVoice") {
      modelConfig = {
        senseVoice: { model: modelPath, language: "auto", useInverseTextNormalization: 1 },
        tokens: tokensPath,
        numThreads: 4,
      };
    } else if (best.type === "whisper") {
      const decoderPath = modelPath.replace("encoder", "decoder");
      modelConfig = {
        whisper: { encoder: modelPath, decoder: decoderPath, language: "zh" },
        tokens: tokensPath,
        numThreads: 4,
      };
    } else {
      // paraformer
      modelConfig = {
        paraformer: { model: modelPath },
        tokens: tokensPath,
        numThreads: 4,
      };
    }

    recognizer = new OfflineRecognizer({ modelConfig });
    console.log(`[asr] loaded ${best.type} from ${best.dir}`);
    return true;
  } catch (e) {
    console.warn("[asr] failed to load sherpa-onnx:", e);
    return false;
  }
}

/**
 * Convert audio to 16kHz mono WAV using ffmpeg.
 * Returns the path to the temp WAV file.
 */
function convertToWav(inputPath: string): string {
  const wavPath = inputPath + ".wav";
  execSync(
    `ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 -f wav "${wavPath}" 2>/dev/null`,
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

export function mountAsrRoute(app: Express): void {
  // Try to init at mount time (fire-and-forget, won't block boot)
  initRecognizer().then((ok) => {
    if (ok) console.log("[asr] POST /api/transcribe ready");
  });

  // Lightweight check — frontend hides mic button when ASR is unavailable
  app.get("/api/transcribe/status", (_req: Request, res: Response) => {
    res.json({ available: !!recognizer });
  });

  app.post("/api/transcribe", async (req: Request, res: Response) => {
    if (!recognizer && !(await initRecognizer())) {
      res.status(503).json({ error: "ASR model not loaded" });
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

        const stream = recognizer.createStream();
        stream.acceptWaveform({ samples, sampleRate });
        recognizer.decode(stream);
        const text = recognizer.getResult(stream).text || "";

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
