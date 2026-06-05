// Image attachment compression — squeeze a buffer down to fit a
// per-model byte limit before we hand it to the LLM.
//
// Strategy: quality-first.
//   1. Already small enough → passthrough (no transcode).
//   2. Try JPEG quality 85, 75, 65, 55, 45, 35 in sequence.
//   3. Still over budget → resize the long edge to 1568px and rerun
//      step 2.
//   4. Still over budget → throw. The chat layer falls back to a
//      "[Attached image (too large to attach): name]" text note.
//
// Why quality-first (per Yu, 2026-06-05):
//   - Picture stays interpretable to the model even at q=35.
//   - Resizing throws away information that's harder to recover.
//   - Most over-limit cases are 5–10 MB phone photos that compress
//     under 5 MB at q=75 without resizing.
//
// SVG / GIF are passed through unchanged: SVG is text and tiny,
// GIF transcoding to JPEG would lose animation. If they exceed the
// limit we let the provider reject and surface that as an error.

import type { ImageContent } from "@earendil-works/pi-ai";

// sharp is heavy (native libvips). Lazy-load so unit tests that
// never touch image content don't pay startup cost.
type SharpModule = typeof import("sharp");
let sharpInstance: SharpModule | null = null;
async function loadSharp(): Promise<SharpModule> {
  if (sharpInstance) return sharpInstance;
  const m = await import("sharp");
  sharpInstance = (m.default ?? m) as SharpModule;
  return sharpInstance;
}

// Ladder of JPEG qualities tried before falling back to resize. Ordered
// high-to-low; we stop on the first that fits.
const QUALITY_LADDER = [85, 75, 65, 55, 45, 35] as const;

// Long edge to clamp to when quality alone can't shrink the file.
// Anthropic's docs recommend 1568px; same value works fine for
// Gemini / OpenAI vision.
const RESIZE_LONG_EDGE = 1568;

// Mime types we never transcode.
const PASSTHROUGH_MIMES = new Set(["image/svg+xml", "image/gif"]);

export interface FitResult {
  /** Possibly-compressed bytes. */
  buf: Buffer;
  /** Final mime type. May differ from input if we transcoded to JPEG. */
  mimeType: string;
  /** True when no transcoding happened (input was already small / unsupported). */
  passthrough: boolean;
  /** When transcoded, the JPEG quality we settled on. */
  quality?: number;
  /** True when we resized in addition to transcoding. */
  resized?: boolean;
}

/**
 * Squeeze `buf` to ≤ `maxBytes`. Throws when even q=35 + resize
 * can't make it. Mutates nothing.
 */
export async function fitToLimit(
  buf: Buffer,
  mimeType: string,
  maxBytes: number,
): Promise<FitResult> {
  if (buf.length <= maxBytes) {
    return { buf, mimeType, passthrough: true };
  }
  if (PASSTHROUGH_MIMES.has(mimeType)) {
    // Caller decides what to do — usually log & let the provider
    // reject. We don't try to compress SVG/GIF.
    return { buf, mimeType, passthrough: true };
  }

  const sharp = await loadSharp();

  // Pass 1: quality ladder on the original pixels.
  for (const q of QUALITY_LADDER) {
    const out = await sharp(buf).jpeg({ quality: q }).toBuffer();
    if (out.length <= maxBytes) {
      return { buf: out, mimeType: "image/jpeg", passthrough: false, quality: q };
    }
  }

  // Pass 2: resize the long edge, then rerun the quality ladder.
  const resized = await sharp(buf)
    .resize({
      width: RESIZE_LONG_EDGE,
      height: RESIZE_LONG_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .toBuffer();
  for (const q of QUALITY_LADDER) {
    const out = await sharp(resized).jpeg({ quality: q }).toBuffer();
    if (out.length <= maxBytes) {
      return {
        buf: out,
        mimeType: "image/jpeg",
        passthrough: false,
        quality: q,
        resized: true,
      };
    }
  }

  throw new Error(
    `image too large after q=35 + resize to ${RESIZE_LONG_EDGE}px: ` +
      `${resized.length} bytes > ${maxBytes}`,
  );
}

// ─── per-process LRU cache ─────────────────────────────────────────
//
// Same image will get inlined into base64 every turn of a long
// conversation. Compressing each time is wasteful; cache the result
// keyed by file path + mtime + target byte limit.
//
// Cap is conservative: 100 entries / 200 MB resident.

interface CacheEntry {
  key: string;
  buf: Buffer;
  mimeType: string;
}

const CACHE_MAX_ENTRIES = 100;
const CACHE_MAX_BYTES = 200 * 1024 * 1024;

const cacheMap = new Map<string, CacheEntry>(); // insertion order = LRU
let cacheBytes = 0;

export function imageFitCacheKey(
  absPath: string,
  mtimeMs: number,
  maxBytes: number,
): string {
  return `${absPath}|${mtimeMs}|${maxBytes}`;
}

export function cacheGet(key: string): CacheEntry | undefined {
  const hit = cacheMap.get(key);
  if (!hit) return undefined;
  // Re-insert to bump LRU recency.
  cacheMap.delete(key);
  cacheMap.set(key, hit);
  return hit;
}

export function cachePut(
  key: string,
  buf: Buffer,
  mimeType: string,
): void {
  // Already present: overwrite (re-insert to bump).
  const existing = cacheMap.get(key);
  if (existing) {
    cacheBytes -= existing.buf.length;
    cacheMap.delete(key);
  }
  cacheMap.set(key, { key, buf, mimeType });
  cacheBytes += buf.length;
  evictUntilUnderCap();
}

function evictUntilUnderCap(): void {
  while (
    (cacheMap.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) &&
    cacheMap.size > 0
  ) {
    const oldestKey = cacheMap.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const entry = cacheMap.get(oldestKey);
    if (!entry) break;
    cacheBytes -= entry.buf.length;
    cacheMap.delete(oldestKey);
  }
}

/** For tests. */
export function _resetImageFitCache(): void {
  cacheMap.clear();
  cacheBytes = 0;
}

/** Convert an ImageContent (already inlined to base64) into one that
 *  fits the limit. Useful when a caller has the bytes inline rather
 *  than on disk. */
export async function fitImageContent(
  ic: ImageContent,
  maxBytes: number,
): Promise<ImageContent> {
  const buf = Buffer.from(ic.data, "base64");
  if (buf.length <= maxBytes) return ic;
  const fitted = await fitToLimit(buf, ic.mimeType, maxBytes);
  if (fitted.passthrough) return ic;
  return {
    type: "image",
    data: fitted.buf.toString("base64"),
    mimeType: fitted.mimeType,
  };
}
