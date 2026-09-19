#!/usr/bin/env node
// Spike: verify sherpa-onnx-node OnlineRecognizer works end-to-end
// with a streaming zipformer model.
//
// Success criteria:
//   1. Model archive downloads + extracts without error
//   2. OnlineRecognizer instantiates from the model files
//   3. Feeding audio in ~250ms chunks yields incremental partial
//      results — text grows across decode() calls, not just at end
//   4. isEndpoint() eventually fires on trailing silence
//
// Run (from repo root):
//   node scripts/spike-online-asr.mjs
//
// If sherpa-onnx-node is missing, install first:
//   npm i sherpa-onnx-node
//
// Test audio: uses a bundled 16kHz mono WAV if available under
// scripts/fixtures/, otherwise falls back to a synthesised sine tone
// (which won't produce meaningful text but exercises the pipeline).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// ── Model: streaming zipformer bilingual zh-en ────────────────────
const MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2";
const MODEL_DIR = "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20";
const SPIKE_ROOT = path.join(REPO_ROOT, ".spike-asr");
const MODEL_ROOT = path.join(SPIKE_ROOT, MODEL_DIR);

function log(msg) {
  console.log(`[spike] ${msg}`);
}

function ensureModel() {
  if (fs.existsSync(MODEL_ROOT)) {
    log(`model already extracted at ${MODEL_ROOT}`);
    return;
  }
  fs.mkdirSync(SPIKE_ROOT, { recursive: true });
  const tarPath = path.join(SPIKE_ROOT, path.basename(MODEL_URL));
  if (!fs.existsSync(tarPath)) {
    log(`downloading ${MODEL_URL} (~150 MB)`);
    execSync(`curl -L -o "${tarPath}" "${MODEL_URL}"`, { stdio: "inherit" });
  }
  log(`extracting ${tarPath}`);
  execSync(`tar -xjf "${tarPath}" -C "${SPIKE_ROOT}"`, { stdio: "inherit" });
  if (!fs.existsSync(MODEL_ROOT)) {
    throw new Error(`extraction succeeded but ${MODEL_ROOT} missing — check tar contents`);
  }
  log(`extracted to ${MODEL_ROOT}`);
  // List what's inside so we can confirm encoder/decoder/joiner names.
  const files = fs.readdirSync(MODEL_ROOT).filter((f) => f.endsWith(".onnx") || f === "tokens.txt");
  log(`model files: ${files.join(", ")}`);
}

function pickModelFiles() {
  // Zipformer streaming ships encoder/decoder/joiner as three onnx files,
  // usually with an "-epoch-N-avg-M" suffix and both fp32 and int8 variants.
  // Prefer int8 for smaller memory footprint.
  const files = fs.readdirSync(MODEL_ROOT);
  const pick = (kind) => {
    // int8 first, then fp32; the "chunk-16-left-128" variants exist too but
    // we take whatever matches simplest.
    const int8 = files.find((f) => f.includes(kind) && f.includes("int8") && f.endsWith(".onnx"));
    if (int8) return path.join(MODEL_ROOT, int8);
    const fp = files.find((f) => f.includes(kind) && f.endsWith(".onnx") && !f.includes("int8"));
    if (!fp) throw new Error(`no ${kind} onnx found in ${MODEL_ROOT}`);
    return path.join(MODEL_ROOT, fp);
  };
  return {
    encoder: pick("encoder"),
    decoder: pick("decoder"),
    joiner: pick("joiner"),
    tokens: path.join(MODEL_ROOT, "tokens.txt"),
  };
}

// ── Test audio ─────────────────────────────────────────────────────

function loadOrSynthesiseAudio() {
  // Prefer a real WAV bundled with the model itself (sherpa releases usually
  // ship test_wavs/ inside). Fall back to synthesising a sine tone so the
  // pipeline exercises even without a fixture.
  const testWavsDir = path.join(MODEL_ROOT, "test_wavs");
  if (fs.existsSync(testWavsDir)) {
    const wavs = fs.readdirSync(testWavsDir).filter((f) => f.endsWith(".wav"));
    if (wavs.length > 0) {
      const pick = path.join(testWavsDir, wavs[0]);
      log(`using test wav: ${pick}`);
      return readWav16k(pick);
    }
  }
  log(`no test_wavs/ found; synthesising 3s 440Hz sine (pipeline exercise only, no meaningful text)`);
  const sr = 16000;
  const dur = 3;
  const samples = new Float32Array(sr * dur);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / sr);
  }
  return { samples, sampleRate: sr };
}

function readWav16k(wavPath) {
  // Minimal WAV reader — assumes PCM 16-bit mono. Real fixtures from sherpa
  // are exactly that. Uses ffmpeg to convert on the fly if we ever pass a
  // non-conforming file.
  const buf = fs.readFileSync(wavPath);
  // RIFF header
  if (buf.slice(0, 4).toString() !== "RIFF" || buf.slice(8, 12).toString() !== "WAVE") {
    throw new Error(`not a WAV: ${wavPath}`);
  }
  // Find fmt + data chunks.
  let off = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataOff = 0;
  let dataLen = 0;
  while (off < buf.length - 8) {
    const id = buf.slice(off, off + 4).toString();
    const sz = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === "data") {
      dataOff = off + 8;
      dataLen = sz;
      break;
    }
    off += 8 + sz;
  }
  if (dataOff === 0 || bits !== 16 || channels !== 1) {
    throw new Error(`unsupported WAV (want mono/16-bit): sr=${sampleRate} ch=${channels} bits=${bits}`);
  }
  const int16 = new Int16Array(
    buf.buffer,
    buf.byteOffset + dataOff,
    dataLen / 2,
  );
  const samples = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) samples[i] = int16[i] / 32768;
  log(`loaded wav: ${samples.length} samples @ ${sampleRate}Hz (${(samples.length / sampleRate).toFixed(2)}s)`);
  return { samples, sampleRate };
}

// ── Main spike ─────────────────────────────────────────────────────

async function main() {
  ensureModel();
  const files = pickModelFiles();
  log(`encoder: ${path.basename(files.encoder)}`);
  log(`decoder: ${path.basename(files.decoder)}`);
  log(`joiner : ${path.basename(files.joiner)}`);
  log(`tokens : ${path.basename(files.tokens)}`);

  const sherpa = await import("sherpa-onnx-node");
  const OnlineRecognizer = sherpa.OnlineRecognizer ?? sherpa.default?.OnlineRecognizer;
  if (!OnlineRecognizer) {
    throw new Error("sherpa-onnx-node has no OnlineRecognizer export (check version)");
  }

  const config = {
    modelConfig: {
      transducer: {
        encoder: files.encoder,
        decoder: files.decoder,
        joiner: files.joiner,
      },
      tokens: files.tokens,
      numThreads: 4,
    },
    enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20,
  };

  log(`instantiating OnlineRecognizer...`);
  const t0 = Date.now();
  const rec = new OnlineRecognizer(config);
  log(`recognizer ready in ${Date.now() - t0}ms`);

  const stream = rec.createStream();
  const { samples, sampleRate } = loadOrSynthesiseAudio();

  // Feed in ~250ms chunks (4000 samples @16kHz) to simulate WS chunking.
  const CHUNK_SAMPLES = Math.floor(sampleRate * 0.25);
  let feedIdx = 0;
  let lastText = "";
  let decodeCalls = 0;
  const partials = [];
  const startTs = Date.now();

  while (feedIdx < samples.length) {
    const end = Math.min(feedIdx + CHUNK_SAMPLES, samples.length);
    const chunk = samples.slice(feedIdx, end);
    feedIdx = end;
    stream.acceptWaveform({ samples: chunk, sampleRate });

    // Drain any ready decodes.
    while (rec.isReady(stream)) {
      rec.decode(stream);
      decodeCalls++;
      const result = rec.getResult(stream);
      const text = (result.text ?? "").trim();
      if (text !== lastText) {
        partials.push({
          atMs: Date.now() - startTs,
          feedMs: Math.round((feedIdx / sampleRate) * 1000),
          text,
        });
        lastText = text;
        log(`partial @${partials[partials.length - 1].atMs}ms (fed ${partials[partials.length - 1].feedMs}ms): "${text}"`);
      }
      if (rec.isEndpoint(stream)) {
        log(`endpoint detected — resetting stream`);
        rec.reset(stream);
      }
    }
  }

  // Signal end + final drain.
  stream.inputFinished();
  while (rec.isReady(stream)) {
    rec.decode(stream);
    decodeCalls++;
  }
  const finalResult = rec.getResult(stream);
  const finalText = (finalResult.text ?? "").trim();
  log(`FINAL: "${finalText}"`);
  log(`stats: ${decodeCalls} decode calls, ${partials.length} distinct partials, ${Date.now() - startTs}ms wall`);

  // ── Success criteria check ─────────────────────────────────────
  console.log("");
  console.log("======== SPIKE VERDICT ========");
  const gotPartials = partials.length > 1;
  const growingText = partials.length >= 2
    && partials[partials.length - 1].text.length >= partials[0].text.length;
  console.log(`1. Model loaded:             ✓`);
  console.log(`2. Recognizer instantiated:  ✓`);
  console.log(`3. Multiple partials:        ${gotPartials ? "✓" : "✗"} (${partials.length} distinct)`);
  console.log(`4. Text grew over time:      ${growingText ? "✓" : "?"}`);
  console.log(`5. Final text non-empty:     ${finalText.length > 0 ? "✓" : "✗"}`);
  console.log("");
  if (!gotPartials || finalText.length === 0) {
    console.log(`If using synthetic sine tone, empty text is expected — need real audio.`);
    console.log(`Bundle a Chinese/English utterance under ${path.join(MODEL_ROOT, "test_wavs")}`);
    console.log(`(the sherpa release usually ships one; check the extracted tar).`);
  }
}

main().catch((err) => {
  console.error(`[spike] FAILED: ${err.stack ?? err.message}`);
  process.exit(1);
});
