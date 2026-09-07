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

let recognizer: any = null;

function getModelDir(): string | null {
  // Look for the model in several locations
  const base = "sherpa-onnx-paraformer-zh-small-2024-03-09";
  const candidates = [
    path.join(process.cwd(), "models", base),
    path.join(process.cwd(), "..", "..", "models", base),
    path.join(process.cwd(), "..", "models", base),
    // Absolute fallback for monorepo root
    path.resolve(__dirname, "..", "..", "..", "..", "models", base),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "model.int8.onnx"))) return dir;
  }
  return null;
}

function initRecognizer(): boolean {
  if (recognizer) return true;
  const modelDir = getModelDir();
  if (!modelDir) {
    console.warn("[asr] paraformer model not found — transcribe endpoint disabled");
    return false;
  }
  try {
    const { OfflineRecognizer } = require("sherpa-onnx-node");
    recognizer = new OfflineRecognizer({
      modelConfig: {
        paraformer: { model: path.join(modelDir, "model.int8.onnx") },
        tokens: path.join(modelDir, "tokens.txt"),
        numThreads: 4,
      },
    });
    console.log("[asr] paraformer-zh-small loaded from", modelDir);
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
  // Try to init at mount time (lazy — won't block if model missing)
  const ready = initRecognizer();

  app.post("/api/transcribe", async (req: Request, res: Response) => {
    if (!recognizer && !initRecognizer()) {
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

  if (ready) {
    console.log("[asr] POST /api/transcribe ready");
  }
}
