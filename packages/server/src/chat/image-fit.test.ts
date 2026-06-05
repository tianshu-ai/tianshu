// Image fit + cache tests.
//
// Uses real sharp to render gradients we know won't shrink under
// quality compression alone, so we can exercise the fallback ladder
// without writing a 5 MB fixture into the repo.

import { describe, expect, it, beforeEach } from "vitest";
import sharp from "sharp";
import {
  fitToLimit,
  imageFitCacheKey,
  cacheGet,
  cachePut,
  _resetImageFitCache,
} from "./image-fit.js";

beforeEach(() => {
  _resetImageFitCache();
});

// Build a PNG of pure noise: JPEG can't dedupe random bytes, so we
// can predict the compression ladder will actually move through
// quality steps and (with a small enough cap) reach the resize
// fallback.
function makeRng(seed: number): () => number {
  // mulberry32 — deterministic so tests don't flake.
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function noisyPng(width: number, height: number): Promise<Buffer> {
  const channels = 3;
  const buf = Buffer.alloc(width * height * channels);
  const rng = makeRng(width * 1000 + height);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = (rng() * 256) | 0;
  }
  return sharp(buf, { raw: { width, height, channels } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

describe("fitToLimit", () => {
  it("passes through when already under the limit", async () => {
    const small = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();
    const fit = await fitToLimit(small, "image/png", 1024 * 1024);
    expect(fit.passthrough).toBe(true);
    expect(fit.buf).toBe(small);
    expect(fit.mimeType).toBe("image/png");
  });

  it("transcodes to JPEG when bytes exceed the (base64) limit", async () => {
    // 800×800 of pure noise: ~2 MB raw PNG. Cap at 1 MB base64 —
    // raw ~750 KB — forces transcoding through the quality ladder
    // without needing to resize.
    const big = await noisyPng(800, 800);
    expect(big.length).toBeGreaterThan(1_000_000);
    const fit = await fitToLimit(big, "image/png", 1_000_000);
    expect(fit.passthrough).toBe(false);
    expect(fit.mimeType).toBe("image/jpeg");
    const encoded = Math.ceil(fit.buf.length / 3) * 4;
    expect(encoded).toBeLessThanOrEqual(1_000_000);
    expect([85, 75, 65, 55, 45, 35]).toContain(fit.quality);
  });

  it("falls back to resize when even q=35 can't fit", async () => {
    // 2048×2048 of pure noise: q=35 is well over 1 MB (JPEG can't
    // dedupe random pixels). A 1 MB cap is enough to require
    // resize to 1568px after the quality ladder gives up; the
    // resized 1568×1568 fits comfortably even at high quality.
    const big = await noisyPng(2048, 2048);
    const fit = await fitToLimit(big, "image/png", 1_000_000);
    expect(fit.buf.length).toBeLessThanOrEqual(1_000_000);
    expect(fit.resized).toBe(true);
    expect(fit.mimeType).toBe("image/jpeg");
  });

  it("compresses when raw bytes fit but base64 doesn't (regression)", async () => {
    // A 4 MB raw PNG fits a 5 MB raw cap but balloons to ~5.3 MB once
    // encoded as base64. Anthropic's 5 MB limit is on the encoded
    // bytes. fitToLimit should treat the budget as base64-bound.
    const big = await noisyPng(1200, 1200);
    expect(big.length).toBeGreaterThan(4_000_000);
    expect(big.length).toBeLessThan(5_242_880); // raw fits 5 MB
    const fit = await fitToLimit(big, "image/png", 5_242_880);
    expect(fit.passthrough).toBe(false);
    // Encoded payload must fit the cap.
    const encoded = Math.ceil(fit.buf.length / 3) * 4;
    expect(encoded).toBeLessThanOrEqual(5_242_880);
  });

  it("passes SVG through even if oversized (caller handles)", async () => {
    const svg = Buffer.from("<svg>" + "x".repeat(50000) + "</svg>", "utf8");
    const fit = await fitToLimit(svg, "image/svg+xml", 1024);
    expect(fit.passthrough).toBe(true);
    expect(fit.mimeType).toBe("image/svg+xml");
  });
});

describe("image-fit cache", () => {
  it("hits on the same key", () => {
    const key = imageFitCacheKey("/abs/x.png", 123, 5_000_000);
    cachePut(key, Buffer.from([1, 2, 3]), "image/jpeg");
    const hit = cacheGet(key);
    expect(hit).toBeDefined();
    expect(hit?.mimeType).toBe("image/jpeg");
    expect([...hit!.buf]).toEqual([1, 2, 3]);
  });

  it("differentiates by mtime", () => {
    const k1 = imageFitCacheKey("/abs/x.png", 100, 5_000_000);
    const k2 = imageFitCacheKey("/abs/x.png", 200, 5_000_000);
    expect(k1).not.toBe(k2);
  });

  it("differentiates by maxBytes (cache per model)", () => {
    const k1 = imageFitCacheKey("/abs/x.png", 100, 5_000_000);
    const k2 = imageFitCacheKey("/abs/x.png", 100, 20_000_000);
    expect(k1).not.toBe(k2);
  });
});
