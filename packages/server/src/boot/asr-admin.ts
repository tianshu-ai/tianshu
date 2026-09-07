/**
 * Admin API for ASR model management.
 * GET  /api/admin/asr/models           — list models (available + installed)
 * POST /api/admin/asr/models/:id/download — start background download
 * DELETE /api/admin/asr/models/:id      — delete installed model
 */

import { type Express, type Request, type Response } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
import { execSync } from "node:child_process";

interface ModelDef {
  id: string;
  name: string;
  lang: string;
  size: string;
  url: string;
  dir: string;
  description: string;
}

const MODELS: ModelDef[] = [
  {
    id: "paraformer-zh-small",
    name: "Paraformer 中文 (Small)",
    lang: "zh",
    size: "78 MB",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2",
    dir: "sherpa-onnx-paraformer-zh-small-2024-03-09",
    description: "高质量中文语音识别，适合大部分场景",
  },
  {
    id: "paraformer-zh",
    name: "Paraformer 中文 (Large)",
    lang: "zh",
    size: "232 MB",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2024-03-09.tar.bz2",
    dir: "sherpa-onnx-paraformer-zh-2024-03-09",
    description: "最高质量中文识别，更大更准",
  },
  {
    id: "sense-voice-zh",
    name: "SenseVoice 中英日韩粤",
    lang: "zh,en,ja,ko,yue",
    size: "~240 MB",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2",
    dir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    description: "多语言识别（中/英/日/韩/粤语）",
  },
  {
    id: "whisper-tiny",
    name: "Whisper Tiny (多语言)",
    lang: "multi",
    size: "~60 MB",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2",
    dir: "sherpa-onnx-whisper-tiny",
    description: "OpenAI Whisper tiny，轻量多语言",
  },
];

// Download state
const downloads = new Map<string, { progress: number; total: number; status: "downloading" | "extracting" | "done" | "error"; error?: string }>();

function getModelsDir(): string {
  // Try monorepo root first, then cwd
  for (const base of [
    path.resolve(process.cwd(), "..", ".."),
    process.cwd(),
  ]) {
    const dir = path.join(base, "models");
    if (fs.existsSync(dir)) return dir;
  }
  // Create at monorepo root
  const dir = path.resolve(process.cwd(), "..", "..", "models");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isInstalled(model: ModelDef): boolean {
  const modelsDir = getModelsDir();
  return fs.existsSync(path.join(modelsDir, model.dir, "tokens.txt"));
}

export function mountAsrAdminRoutes(app: Express): void {
  // List models
  app.get("/api/admin/asr/models", (_req: Request, res: Response) => {
    const list = MODELS.map((m) => ({
      ...m,
      installed: isInstalled(m),
      downloading: downloads.get(m.id)?.status === "downloading" || downloads.get(m.id)?.status === "extracting",
      downloadProgress: downloads.get(m.id) ?? null,
    }));
    res.json({ models: list, modelsDir: getModelsDir() });
  });

  // Download a model
  app.post("/api/admin/asr/models/:id/download", async (req: Request, res: Response) => {
    const paramId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const model = MODELS.find((m) => m.id === paramId);
    if (!model) return res.status(404).json({ error: "unknown model" });
    if (isInstalled(model)) return res.json({ ok: true, message: "already installed" });

    const existing = downloads.get(model.id);
    if (existing && (existing.status === "downloading" || existing.status === "extracting")) {
      return res.json({ ok: true, message: "download in progress" });
    }

    // Start background download
    const state = { progress: 0, total: 0, status: "downloading" as const };
    downloads.set(model.id, state);
    res.json({ ok: true, message: "download started" });

    const modelsDir = getModelsDir();
    const tarPath = path.join(modelsDir, `${model.id}.tar.bz2`);

    try {
      const response = await fetch(model.url, { redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

      const cl = response.headers.get("content-length");
      state.total = cl ? parseInt(cl, 10) : 0;

      // Stream download to file with progress tracking
      const fileStream = createWriteStream(tarPath);
      const reader = response.body.getReader();
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(value);
        received += value.byteLength;
        state.progress = received;
      }
      fileStream.end();
      await new Promise<void>((resolve) => fileStream.on("finish", resolve));

      // Extract
      const ds = downloads.get(model.id)!;
      ds.status = "extracting";
      execSync(`tar xjf "${tarPath}" -C "${modelsDir}"`, { timeout: 120_000 });
      fs.unlinkSync(tarPath);

      ds.status = "done";
      ds.progress = ds.total;
      console.log(`[asr-admin] model ${model.id} installed`);
    } catch (e) {
      const ds = downloads.get(model.id)!;
      ds.status = "error";
      ds.error = String(e);
      console.error(`[asr-admin] download failed for ${model.id}:`, e);
      try { fs.unlinkSync(tarPath); } catch {}
    }
  });

  // Download progress
  app.get("/api/admin/asr/models/:id/status", (req: Request, res: Response) => {
    const sid = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const state = downloads.get(sid);
    if (!state) return res.json({ status: "idle" });
    res.json(state);
  });

  // Delete model
  app.delete("/api/admin/asr/models/:id", (req: Request, res: Response) => {
    const did = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const model = MODELS.find((m) => m.id === did);
    if (!model) return res.status(404).json({ error: "unknown model" });
    const dir = path.join(getModelsDir(), model.dir);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    downloads.delete(model.id);
    res.json({ ok: true });
  });
}
