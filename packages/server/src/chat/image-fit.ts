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
// IMPORTANT — the budget here is the *base64-encoded* byte count
// because that's what providers actually measure. Anthropic's "5 MB
// per image" is 5 MB of base64 string, which corresponds to ~3.75 MB
// of raw bytes. We fold the 4/3 expansion into every comparison so
// callers can keep talking in raw bytes.
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
//
// Note on the type: sharp >= 0.35 dropped the dual `module is
// callable AND a namespace` shape it had on 0.34. The CJS / ESM
// re-export now exposes the namespace at the top level, with the
// callable factory living under `default`. Typing
// `typeof import("sharp")` no longer satisfies
// `(buf) => Sharp`, so we pin the module type to the default
// export's type instead.
type SharpFactory = typeof import("sharp").default;
let sharpInstance: SharpFactory | null = null;
async function loadSharp(): Promise<SharpFactory> {
  if (sharpInstance) return sharpInstance;
  const m = await import("sharp");
  // `m.default` on 0.35; older releases exposed the callable at
  // the top-level so we keep the fallback for forward+back compat.
  sharpInstance = (m.default ?? (m as unknown as SharpFactory));
  return sharpInstance;
}

// Ladder of JPEG qualities tried before falling back to resize. Ordered
// high-to-low; we stop on the first that fits.
const QUALITY_LADDER = [85, 75, 65, 55, 45, 35] as const;

// Long edge to clamp to when quality alone can't shrink the file.
// Anthropic's docs recommend 1568px; same value works fine for
// Gemini / OpenAI vision.
const RESIZE_LONG_EDGE = 1568;

// Anthropic rejects images where ANY dimension exceeds 8000px.
// Browser full-page screenshots regularly hit 10000–20000px tall.
// We must resize these BEFORE the byte-budget check, otherwise a
// small-enough-in-bytes but too-tall image passes through and the
// provider returns 400.
const MAX_DIMENSION = 8000;

// Mime types we never transcode.
const PASSTHROUGH_MIMES = new Set(["image/svg+xml", "image/gif"]);

/** base64 expansion factor. Three input bytes encode to four output
 *  bytes; we round up so the budget check stays conservative. */
function encodedSize(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

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
  if (PASSTHROUGH_MIMES.has(mimeType)) {
    return { buf, mimeType, passthrough: true };
  }

  const sharp = await loadSharp();

  // Pass 0: clamp oversized dimensions. Anthropic rejects any image
  // where width or height > 8000px, regardless of byte size. Browser
  // full-page screenshots are the main offender.
  //
  // Read metadata first; if that fails (truncated/corrupt buffer) and
  // the image is within byte budget, pass through and let the provider
  // decide — crashing here would degrade a valid small image that sharp
  // can't parse (e.g. exotic format or partial PNG header in tests).
  let meta: { width?: number; height?: number } | null = null;
  try {
    meta = await sharp(buf).metadata();
  } catch {
    // sharp can't decode — if within budget, pass through as-is.
    if (encodedSize(buf.length) <= maxBytes) {
      return { buf, mimeType, passthrough: true };
    }
    // Over budget AND unreadable — nothing we can do.
    throw new Error(
      `image unreadable by sharp and exceeds byte budget: ` +
      `${buf.length} raw bytes (${encodedSize(buf.length)} base64) > ${maxBytes}`,
    );
  }

  let didResize = false;
  if ((meta.width && meta.width > MAX_DIMENSION) || (meta.height && meta.height > MAX_DIMENSION)) {
    // Transcode to JPEG during resize — keeps byte size predictable
    // and avoids returning a PNG buffer with mimeType "image/jpeg".
    buf = await sharp(buf)
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer();
    mimeType = "image/jpeg";
    didResize = true;
  }

  if (encodedSize(buf.length) <= maxBytes) {
    return { buf, mimeType, passthrough: !didResize, resized: didResize };
  }

  // Pass 1: quality ladder on the (possibly resized) pixels.
  for (const q of QUALITY_LADDER) {
    const out = await sharp(buf).jpeg({ quality: q }).toBuffer();
    if (encodedSize(out.length) <= maxBytes) {
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
    if (encodedSize(out.length) <= maxBytes) {
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
      `${resized.length} raw bytes (${encodedSize(resized.length)} base64) > ${maxBytes}`,
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
  // Always run through fitToLimit — it checks BOTH byte budget AND
  // pixel dimensions (Pass 0 clamps >8000px). Skipping on bytes
  // alone missed oversized screenshots that were small in bytes
  // but too tall/wide for the provider.
  const fitted = await fitToLimit(buf, ic.mimeType, maxBytes);
  if (fitted.passthrough) return ic;
  return {
    type: "image",
    data: fitted.buf.toString("base64"),
    mimeType: fitted.mimeType,
  };
}
