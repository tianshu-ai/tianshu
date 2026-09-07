/**
 * Admin API for ASR model management.
 * GET  /api/admin/asr/models           — list models (available + installed)
 * POST /api/admin/asr/models/:id/download — start background download
 * DELETE /api/admin/asr/models/:id      — delete installed model
 */

import { type Express, type Request, type Response } from "express";
import { reloadAsrModel } from "./asr.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { getTianshuHome } from "../core/paths.js";

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
    name: "Paraformer Chinese (Small)",
    lang: "zh",
    size: "74 MB",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2",
    dir: "sherpa-onnx-paraformer-zh-small-2024-03-09",
    description: "",
  },
  {
    id: "paraformer-zh",
    name: "Paraformer Chinese (Large)",
    lang: "zh",
    size: "950 MB",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2024-03-09.tar.bz2",
    dir: "sherpa-onnx-paraformer-zh-2024-03-09",
    description: "",
  },
  {
    id: "sense-voice-zh",
    name: "SenseVoice (zh/en/ja/ko/yue)",
    lang: "zh,en,ja,ko,yue",
    size: "~1 GB",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2",
    dir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    description: "",
  },
  {
    id: "whisper-tiny",
    name: "Whisper Tiny",
    lang: "multi",
    size: "110 MB",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2",
    dir: "sherpa-onnx-whisper-tiny",
    description: "",
  },
];

// Download state
const downloads = new Map<string, { progress: number; total: number; status: "downloading" | "extracting" | "done" | "error"; error?: string }>();

/** Walk up from server dist to find the top-level package.json with the bin field. */
function findPackageRoot(): string | null {
  let dir = path.resolve(import.meta.dirname ?? process.cwd());
  for (let i = 0; i < 10; i++) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const json = JSON.parse(fs.readFileSync(pkg, "utf8"));
        if (json.bin?.tianshu || json.name === "@tianshu-ai/tianshu") return dir;
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function getModelsDir(): string {
  // Primary: <TIANSHU_HOME>/models (works for both dev and production)
  const homeDir = path.join(getTianshuHome(), "models");
  if (!fs.existsSync(homeDir)) {
    fs.mkdirSync(homeDir, { recursive: true });
  }
  return homeDir;
}

function isInstalled(model: ModelDef): boolean {
  const modelsDir = getModelsDir();
  return fs.existsSync(path.join(modelsDir, model.dir, "tokens.txt"));
}

function getActiveModelId(): string | null {
  try {
    return fs.readFileSync(path.join(getModelsDir(), "active-asr-model.txt"), "utf8").trim() || null;
  } catch { return null; }
}

function setActiveModelId(id: string | null): void {
  const p = path.join(getModelsDir(), "active-asr-model.txt");
  if (id) fs.writeFileSync(p, id, "utf8");
  else try { fs.unlinkSync(p); } catch {}
}

export function mountAsrAdminRoutes(app: Express): void {
  // List models
  app.get("/api/admin/asr/models", (_req: Request, res: Response) => {
    const activeId = getActiveModelId();
    const list = MODELS.map((m) => ({
      ...m,
      installed: isInstalled(m),
      active: m.id === activeId,
      downloading: downloads.get(m.id)?.status === "downloading" || downloads.get(m.id)?.status === "extracting",
      downloadProgress: downloads.get(m.id) ?? null,
    }));
    res.json({ models: list, activeModelId: activeId, modelsDir: getModelsDir() });
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

      // Extract .tar.bz2 using pure Node.js (no system bzip2 needed)
      const ds = downloads.get(model.id)!;
      ds.status = "extracting";
      // @ts-ignore
      const bz2 = (await import("unbzip2-stream")).default;
      // @ts-ignore
      const tar = await import("tar-fs");
      await new Promise<void>((resolve, reject) => {
        createReadStream(tarPath)
          .pipe(bz2())
          .pipe(tar.extract(modelsDir))
          .on("finish", resolve)
          .on("error", reject);
      });
      fs.unlinkSync(tarPath);

      ds.status = "done";
      ds.progress = ds.total;
      console.log(`[asr-admin] model ${model.id} installed`);
      // Auto-activate if it's the first model, then hot-reload
      if (!getActiveModelId()) {
        setActiveModelId(model.id);
      }
      if (getActiveModelId() === model.id) {
        await reloadAsrModel();
      }
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

  // Install sherpa-onnx-node runtime
  app.post("/api/admin/asr/install-runtime", async (_req: Request, res: Response) => {
    try {
      // Find the tianshu package root (where package.json lives)
      const pkgRoot = findPackageRoot();
      if (!pkgRoot) {
        res.status(500).json({ error: "Cannot find tianshu package root" });
        return;
      }
      res.json({ ok: true, message: "installing" });
      // Run in background — don't block the response
      const { exec } = await import("node:child_process");
      exec(`npm install sherpa-onnx-node`, { cwd: pkgRoot, timeout: 120_000 }, (err) => {
        if (err) {
          console.error("[asr-admin] runtime install failed:", err.message);
        } else {
          console.log("[asr-admin] sherpa-onnx-node installed successfully");
        }
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Activate model
  app.post("/api/admin/asr/models/:id/activate", async (req: Request, res: Response) => {
    const paramId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const model = MODELS.find((m) => m.id === paramId);
    if (!model) return res.status(404).json({ error: "unknown model" });
    if (!isInstalled(model)) return res.status(400).json({ error: "model not installed" });
    setActiveModelId(model.id);
    // Hot-reload the recognizer so it takes effect immediately
    const loaded = await reloadAsrModel();
    res.json({ ok: true, activeModelId: model.id, loaded });
  });

  // Delete model
  app.delete("/api/admin/asr/models/:id", async (req: Request, res: Response) => {
    const did = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const model = MODELS.find((m) => m.id === did);
    if (!model) return res.status(404).json({ error: "unknown model" });
    const dir = path.join(getModelsDir(), model.dir);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    downloads.delete(model.id);
    // If deleting the active model, clear selection and unload
    if (getActiveModelId() === model.id) {
      setActiveModelId(null);
      await reloadAsrModel(); // will find nothing → recognizer = null
    }
    res.json({ ok: true });
  });
}
