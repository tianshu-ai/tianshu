// Resilience wrapper for LLM stream calls.
//
// Why this exists
// ───────────────
// Model calls fail transiently all the time: provider rate limits
// (429), gateway hiccups (502/503/504), dropped sockets / DNS blips,
// and — in tianshu's SAP-proxy / tenant deployments — short-lived JWTs
// that expire between turns (401/403). Without a retry policy a single
// blip surfaces to the user as an empty assistant bubble + "stream
// ended with stopReason=error" (see handler.ts:1120). The underlying
// pi-ai SDKs do a *little* client-side retrying (maxRetries, default 2)
// but (a) it doesn't re-resolve auth, so an expired token never
// recovers, and (b) it's per-provider and not uniformly applied.
//
// This module wraps the api-registry `stream`/`streamSimple` functions
// at the single chokepoint in core/pi-models.ts, so every LLM call —
// chat handler, worker agent-loop, and compact() — inherits the same
// policy. We also set the SDK's own `maxRetries` to 0 per attempt so
// retry logic lives in exactly one place: two competing layers would
// double the backoff and hide 429s from our rate-limit handling.
//
// Rate limits specifically
// ────────────────────────
// On a 429 / rate-limit we try hard to extract the server's requested
// wait time (Retry-After header, x-ratelimit-reset* headers in
// seconds/ms/duration/epoch/RFC3339, Gemini's structured `retryDelay`,
// or a "try again in Xs" hint in the message) and wait AT LEAST that
// long (+ small jitter, never less). If the server gives no explicit
// time, we fall back to a conservative floor (rateLimitFloorMs, default
// 5s) instead of the short exponential schedule — hammering a tripped
// limit with 500ms retries just keeps it tripped.
//
// Safety: retry only before any content streams out
// ─────────────────────────────────────────────────
// A stream can fail two ways:
//   1. Before emitting any assistant content (start/text/thinking/
//      toolcall delta). Safe to retry the whole call — the user has
//      seen nothing yet.
//   2. Mid-stream, after tokens have already been forwarded. Retrying
//      would duplicate/garble output, so we DO NOT retry — we forward
//      the error as-is. This is the conservative choice; a mid-stream
//      429 is rare (the provider has already committed to the response)
//      and salvaging it correctly needs resumable streaming the API
//      doesn't offer.
//
// pi-ai encodes failures two ways depending on the provider/path:
//   * a thrown error from the stream function or during iteration, or
//   * a terminal `{ type: "error", error: AssistantMessage }` event
//     with `stopReason: "error"` and an `errorMessage`.
// We handle both.

import type {
  AssistantMessageEventStream,
  AssistantMessageEvent,
  Context,
  Model,
  Api,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ModelResilienceConfig } from "./config.js";

/** A pi-ai api-registry stream function (untyped dispatch shape). */
export type StreamFn = (
  model: Model<Api>,
  context: Context,
  options?: Record<string, unknown>,
) => AssistantMessageEventStream;

export interface ResolvedResilience {
  enabled: boolean;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: number;
  respectRetryAfter: boolean;
  maxRetryAfterMs: number;
  rateLimitFloorMs: number;
  retryAfterContent: boolean;
}

const DEFAULTS: ResolvedResilience = {
  enabled: true,
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  jitter: 0.25,
  respectRetryAfter: true,
  maxRetryAfterMs: 60_000,
  // When a 429/rate-limit gives us NO explicit wait time, don't hammer
  // it with the short exponential schedule (which starts at baseDelayMs
  // = 500ms) — that just keeps the limit tripped. Start no lower than
  // this floor and still grow/jitter from there. Capped by maxDelayMs.
  rateLimitFloorMs: 5_000,
  // Retry mid-stream failures (connection dropped after some tokens
  // already streamed) by re-running the whole call and rebuilding the
  // message; the client resets its in-progress bubble first.
  retryAfterContent: true,
};

export function resolveResilience(
  cfg: ModelResilienceConfig | undefined,
): ResolvedResilience {
  if (!cfg) return { ...DEFAULTS };
  const clampInt = (v: unknown, min: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= min
      ? Math.floor(v)
      : fallback;
  const clampNum = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.min(max, Math.max(min, v))
      : fallback;
  return {
    enabled: cfg.enabled ?? DEFAULTS.enabled,
    maxAttempts: clampInt(cfg.maxAttempts, 1, DEFAULTS.maxAttempts),
    baseDelayMs: clampInt(cfg.baseDelayMs, 0, DEFAULTS.baseDelayMs),
    maxDelayMs: clampInt(cfg.maxDelayMs, 0, DEFAULTS.maxDelayMs),
    jitter: clampNum(cfg.jitter, 0, 1, DEFAULTS.jitter),
    respectRetryAfter: cfg.respectRetryAfter ?? DEFAULTS.respectRetryAfter,
    maxRetryAfterMs: clampInt(
      cfg.maxRetryAfterMs,
      0,
      DEFAULTS.maxRetryAfterMs,
    ),
    rateLimitFloorMs: clampInt(
      cfg.rateLimitFloorMs,
      0,
      DEFAULTS.rateLimitFloorMs,
    ),
    retryAfterContent: cfg.retryAfterContent ?? DEFAULTS.retryAfterContent,
  };
}

// ─── error classification ─────────────────────────────────────────

export interface RetryClassification {
  retriable: boolean;
  /** True for auth failures (401/403) — caller re-resolves the apiKey
   *  (refreshed JWT) before the next attempt. */
  authFailure: boolean;
  /** True when the failure is a rate limit (429 or rate-limit phrasing).
   *  Drives a more conservative backoff floor when the server did NOT
   *  give us an explicit wait time — hammering a rate limit with short
   *  exponential delays just keeps it tripped. */
  rateLimited: boolean;
  /** Server-requested wait in ms, if we could parse one. When present
   *  it MUST take precedence over local backoff (respectRetryAfter). */
  retryAfterMs?: number;
  /** Short label for logging. */
  kind: string;
}

const RETRIABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const AUTH_STATUS = new Set([401, 403]);

/** Best-effort extraction of an HTTP status from a thrown error or an
 *  error AssistantMessage's errorMessage string. */
function extractStatus(err: unknown, text: string): number | undefined {
  // Structured SDK errors commonly carry .status / .statusCode / .code.
  if (err && typeof err === "object") {
    const anyErr = err as Record<string, unknown>;
    for (const key of ["status", "statusCode"]) {
      const v = anyErr[key];
      if (typeof v === "number" && v >= 100 && v < 600) return v;
    }
    const resp = anyErr["response"];
    if (resp && typeof resp === "object") {
      const rs = (resp as Record<string, unknown>)["status"];
      if (typeof rs === "number") return rs;
    }
  }
  // Fall back to scraping the message text ("... 429 ...", "status 503").
  const m = text.match(/\b(4\d\d|5\d\d)\b/);
  if (m) return Number(m[1]);
  return undefined;
}

// Header names that carry an explicit wait, in priority order. Values
// are either seconds / an HTTP-date (Retry-After), milliseconds
// (*-ms suffix), or an epoch reset time (x-ratelimit-reset*).
const RETRY_AFTER_HEADERS_SECONDS_OR_DATE = [
  "retry-after",
  "retry_after",
];
const RETRY_AFTER_HEADERS_MS = [
  "retry-after-ms",
  "x-ratelimit-reset-requests-ms",
  "x-ratelimit-reset-tokens-ms",
];
// OpenAI/Anthropic style: a duration string like "20ms" / "1.5s" / "2m",
// or (Anthropic) an RFC3339 reset timestamp.
const RETRY_AFTER_HEADERS_DURATION_OR_RESET = [
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "x-ratelimit-reset",
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-tokens-reset",
  "anthropic-ratelimit-input-tokens-reset",
  "anthropic-ratelimit-output-tokens-reset",
];

/** Parse "20s" / "1500ms" / "1.5s" / "2m" / "90" (bare = seconds) into ms. */
function parseDurationToMs(raw: string): number | undefined {
  const s = raw.trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  switch ((m[2] ?? "s").toLowerCase()) {
    case "ms":
      return Math.round(n);
    case "s":
      return Math.round(n * 1000);
    case "m":
      return Math.round(n * 60_000);
    case "h":
      return Math.round(n * 3_600_000);
    default:
      return Math.round(n * 1000);
  }
}

/** Interpret a value as an epoch reset time (seconds or ms since epoch)
 *  and return the delay from now, or undefined if it doesn't look like
 *  a plausible near-future epoch. */
function epochResetToDelayMs(raw: string): number | undefined {
  if (!/^\d+(?:\.\d+)?$/.test(raw.trim())) return undefined;
  const num = Number(raw);
  const now = Date.now();
  // Heuristic: seconds-epoch if ~10 digits, ms-epoch if ~13.
  const asMs = num > 1e12 ? num : num * 1000;
  const delta = asMs - now;
  // Only trust it if it's a sane forward-looking wait (< 1h).
  if (delta > 0 && delta <= 3_600_000) return delta;
  return undefined;
}

function headerValue(
  headers: Record<string, unknown>,
  name: string,
): string | number | undefined {
  // Case-insensitive lookup.
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct !== undefined) return direct as string | number;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) return v as string | number;
  }
  return undefined;
}

/** Parse a server-provided wait time from headers, structured error
 *  fields, or the message text, into milliseconds. Covers the common
 *  OpenAI / Anthropic / Google shapes.
 *
 *  Priority: explicit Retry-After header > vendor reset headers >
 *  structured body fields (Gemini retryDelay) > message-text hints.
 *  We take the FIRST plausible signal in that order rather than a max,
 *  because the most authoritative source is the standard header. */
function extractRetryAfterMs(err: unknown, text: string): number | undefined {
  const fromSecondsOrDate = (h: unknown): number | undefined => {
    if (typeof h === "number" && Number.isFinite(h)) return h * 1000;
    if (typeof h === "string") {
      const s = h.trim();
      if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
      const date = Date.parse(s);
      if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    }
    return undefined;
  };
  const fromMs = (h: unknown): number | undefined => {
    if (typeof h === "number" && Number.isFinite(h)) return Math.round(h);
    if (typeof h === "string" && /^\d+(?:\.\d+)?$/.test(h.trim()))
      return Math.round(Number(h));
    return undefined;
  };
  const fromDurationOrReset = (h: unknown): number | undefined => {
    if (typeof h === "number" && Number.isFinite(h)) {
      // Could be an epoch reset; try that, else treat as seconds.
      return epochResetToDelayMs(String(h)) ?? Math.round(h * 1000);
    }
    if (typeof h === "string") {
      const s = h.trim();
      // RFC3339 / HTTP-date reset timestamp.
      const date = Date.parse(s);
      if (!Number.isNaN(date) && /[a-z:]/i.test(s)) {
        return Math.max(0, date - Date.now());
      }
      return epochResetToDelayMs(s) ?? parseDurationToMs(s);
    }
    return undefined;
  };

  if (err && typeof err === "object") {
    const anyErr = err as Record<string, unknown>;
    // Top-level convenience fields some SDKs attach.
    const direct =
      fromSecondsOrDate(anyErr["retryAfter"]) ??
      fromSecondsOrDate(anyErr["retry_after"]) ??
      fromMs(anyErr["retryAfterMs"]);
    if (direct !== undefined) return direct;

    const headers = anyErr["headers"];
    if (headers && typeof headers === "object") {
      const h = headers as Record<string, unknown>;
      for (const name of RETRY_AFTER_HEADERS_SECONDS_OR_DATE) {
        const v = fromSecondsOrDate(headerValue(h, name));
        if (v !== undefined) return v;
      }
      for (const name of RETRY_AFTER_HEADERS_MS) {
        const v = fromMs(headerValue(h, name));
        if (v !== undefined) return v;
      }
      for (const name of RETRY_AFTER_HEADERS_DURATION_OR_RESET) {
        const v = fromDurationOrReset(headerValue(h, name));
        if (v !== undefined) return v;
      }
    }

    // Google/Gemini put it in the structured body:
    //   error.details[].retryDelay = "17s"
    const bodyDelay = findRetryDelayField(err);
    if (bodyDelay !== undefined) return bodyDelay;
  }

  // Message-text hints (also covers pi-ai's maxRetryDelayMs cap, which
  // surfaces the server's requested delay in the message string):
  //   OpenAI    "Please try again in 20s." / "try again in 1.5s"
  //   generic   "retry after 30s" / "please retry in 12000ms"
  //   Gemini    'retryDelay": "17s"' / "retry in 17 seconds"
  const patterns: RegExp[] = [
    /retry(?:delay)?["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)\s*ms/i,
    /(?:try again|retry)(?:\s+after|\s+in)?\s+(\d+)\s*ms/i,
    /(?:try again|retry)(?:\s+after|\s+in)?\s+(\d+(?:\.\d+)?)\s*(?:s\b|sec|second)/i,
    /retry(?:delay)?["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)\s*s/i,
    /(?:try again|retry)(?:\s+after|\s+in)?\s+(\d+(?:\.\d+)?)\s*(?:m\b|min|minute)/i,
  ];
  const msPat = text.match(patterns[0]) ?? text.match(patterns[1]);
  if (msPat) return Math.round(Number(msPat[1]));
  const secPat = text.match(patterns[2]) ?? text.match(patterns[3]);
  if (secPat) return Math.round(Number(secPat[1]) * 1000);
  const minPat = text.match(patterns[4]);
  if (minPat) return Math.round(Number(minPat[1]) * 60_000);
  return undefined;
}

/** Recursively look for a `retryDelay` field (Google/Gemini style)
 *  anywhere in a structured error object, up to a small depth. */
function findRetryDelayField(obj: unknown, depth = 0): number | undefined {
  if (depth > 5 || !obj || typeof obj !== "object") return undefined;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const v = findRetryDelayField(item, depth + 1);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  const rec = obj as Record<string, unknown>;
  for (const key of ["retryDelay", "retry_delay"]) {
    const raw = rec[key];
    if (typeof raw === "string") {
      const ms = parseDurationToMs(raw);
      if (ms !== undefined) return ms;
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      return Math.round(raw * 1000);
    }
  }
  for (const v of Object.values(rec)) {
    const found = findRetryDelayField(v, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

const NETWORK_HINTS = [
  "econnreset",
  "econnrefused",
  "etimedout",
  "enotfound",
  "eai_again",
  "epipe",
  "socket hang up",
  "network",
  "fetch failed",
  "timeout",
  "timed out",
  "aborted", // transport abort, not user abort (guarded by caller signal)
  "stream closed",
  "premature close",
];

export function classifyError(err: unknown): RetryClassification {
  const text = errText(err).toLowerCase();
  const status = extractStatus(err, text);
  const retryAfterMs = extractRetryAfterMs(err, text);

  if (status !== undefined) {
    if (status === 429) {
      return {
        retriable: true,
        authFailure: false,
        rateLimited: true,
        retryAfterMs,
        kind: "http-429",
      };
    }
    if (AUTH_STATUS.has(status)) {
      // Expired/rotated JWT is the common cause in tenant deployments.
      // Retriable AFTER re-resolving the apiKey. A genuinely wrong key
      // will just fail again and exhaust attempts — acceptable.
      return { retriable: true, authFailure: true, rateLimited: false, retryAfterMs, kind: `http-${status}` };
    }
    if (RETRIABLE_STATUS.has(status)) {
      return { retriable: true, authFailure: false, rateLimited: false, retryAfterMs, kind: `http-${status}` };
    }
    // Other 4xx (400 bad request, 404, 422, …) are deterministic —
    // retrying won't help and wastes tokens/time.
    return { retriable: false, authFailure: false, rateLimited: false, kind: `http-${status}` };
  }

  // Rate-limit phrasing without an explicit code. Check BEFORE the
  // generic network hints so an "overloaded"/"rate limit" message that
  // also mentions a timeout is treated as rate-limited (conservative
  // backoff) rather than a plain network blip.
  if (
    text.includes("rate limit") ||
    text.includes("ratelimit") ||
    text.includes("rate_limit") ||
    text.includes("overloaded") ||
    text.includes("too many requests") ||
    text.includes("quota") ||
    text.includes("resource_exhausted") ||
    text.includes("resource exhausted") ||
    text.includes("429")
  ) {
    return { retriable: true, authFailure: false, rateLimited: true, retryAfterMs, kind: "rate-limit" };
  }

  if (NETWORK_HINTS.some((h) => text.includes(h))) {
    return { retriable: true, authFailure: false, rateLimited: false, retryAfterMs, kind: "network" };
  }
  return { retriable: false, authFailure: false, rateLimited: false, retryAfterMs, kind: "unknown" };
}

function errText(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) return `${err.message}`;
  if (typeof err === "object") {
    const anyErr = err as Record<string, unknown>;
    if (typeof anyErr["errorMessage"] === "string") return anyErr["errorMessage"] as string;
    if (typeof anyErr["message"] === "string") return anyErr["message"] as string;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/** True once an event means content has begun streaming to the user. */
function isContentEvent(ev: AssistantMessageEvent): boolean {
  switch (ev.type) {
    case "text_start":
    case "text_delta":
    case "text_end":
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end":
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      return true;
    default:
      // "start" is a lifecycle marker with an empty partial — not user
      // content, so a failure right after it is still safe to retry.
      return false;
  }
}

export function backoffDelayMs(
  attempt: number, // 1-based attempt that just failed
  cls: RetryClassification,
  r: ResolvedResilience,
): number {
  // 1) Server told us exactly how long to wait — that's authoritative.
  //    Honour it (capped), regardless of error kind. This is the single
  //    most important lever for not prolonging a rate limit.
  if (r.respectRetryAfter && cls.retryAfterMs !== undefined) {
    // Never wait LESS than the server asked; add a small jitter on top
    // so a fleet of clients releasing at the same reset instant don't
    // stampede and immediately re-trip the limit.
    const base = Math.min(cls.retryAfterMs, r.maxRetryAfterMs);
    const jitterSpan = base * Math.min(r.jitter, 0.25);
    return Math.round(base + Math.random() * jitterSpan);
  }

  // 2) Rate limited but NO explicit wait time. Using the normal short
  //    exponential (500ms, 1s, 2s…) would keep hammering a tripped
  //    limit. Start from a conservative floor and grow from there.
  const floor =
    cls.rateLimited && r.rateLimitFloorMs > 0 ? r.rateLimitFloorMs : 0;
  const exp = r.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(Math.max(exp, floor), r.maxDelayMs);
  const jitterSpan = capped * r.jitter;
  const delta = (Math.random() * 2 - 1) * jitterSpan;
  return Math.max(0, Math.round(capped + delta));
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        return reject(new DOMException("Aborted", "AbortError"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

export interface WrapStreamDeps {
  resilience: ResolvedResilience;
  /** Re-resolve the apiKey for the next attempt. Called before an
   *  auth-failure retry so a refreshed JWT is picked up. Returning the
   *  key lets the caller thread it into the api call however it wires
   *  auth (options.apiKey, provider closure, …). */
  reResolveApiKey?: () => string;
  /** Where to log retry activity. Defaults to console. */
  log?: {
    warn: (msg: string) => void;
    info?: (msg: string) => void;
  };
  /** Label for logs (model id). */
  label?: string;
  /** Called once per retry, BEFORE the backoff sleep, so callers can
   *  surface a UI notification ("retrying in Ns…"). Must not throw. */
  onRetry?: (notice: RetryNotice) => void;
}

/** Structured retry notification for logs + UI. */
export interface RetryNotice {
  /** 1-based attempt that just failed (the retry will be attempt+1). */
  attempt: number;
  maxAttempts: number;
  /** Short label: "http-429" / "network" / "rate-limit" / "http-401". */
  kind: string;
  /** Backoff before the next attempt, in ms. */
  delayMs: number;
  rateLimited: boolean;
  authFailure: boolean;
  /** True when partial content had already streamed before the failure
   *  — the retry rebuilds the message, so the client should reset its
   *  in-progress bubble to avoid duplicated text. */
  contentStreamed: boolean;
  /** Model label (provider/id). */
  label: string;
  /** Human-readable one-liner. */
  message: string;
}

/** Build the standard human-readable retry line, reused by log + UI. */
function retryMessage(n: RetryNotice): string {
  const secs = (n.delayMs / 1000).toFixed(n.delayMs < 1000 ? 2 : 1);
  const why = n.rateLimited
    ? "rate limited"
    : n.authFailure
      ? "auth expired"
      : n.kind;
  return `${n.label}: ${why} (${n.kind}), retrying in ${secs}s (attempt ${n.attempt}/${n.maxAttempts})`;
}

/** Log the retry and fire the (optional) UI callback. `notice.message`
 *  is filled in from `retryMessage()` here so both channels share one
 *  wording. The onRetry callback is guarded — a throwing UI handler
 *  must never derail the retry loop. */
function emitRetry(
  deps: WrapStreamDeps,
  log: { warn: (msg: string) => void },
  notice: RetryNotice,
): void {
  notice.message = retryMessage(notice);
  log.warn(`[model-retry] ${notice.message}`);
  if (deps.onRetry) {
    try {
      deps.onRetry(notice);
    } catch (err) {
      log.warn(
        `[model-retry] onRetry callback threw: ${errText(err)}`,
      );
    }
  }
}

/**
 * Wrap a raw stream function with the retry policy. The returned
 * function has the same signature; on a pre-content transient failure
 * it transparently re-invokes `fn` after a backoff, up to
 * `maxAttempts`. Once content has streamed, or the error is
 * non-retriable, it forwards the terminal error unchanged.
 *
 * `signal` (from options) aborts both the in-flight stream and any
 * pending backoff — a user cancel / watchdog timeout stops retries.
 */
export function wrapStreamFn(fn: StreamFn, deps: WrapStreamDeps): StreamFn {
  const r = deps.resilience;
  const log = deps.log ?? { warn: (m: string) => console.warn(m) };
  const label = deps.label ?? "model";
  if (!r.enabled || r.maxAttempts <= 1) return fn;

  return (model, context, options) => {
    const out = createAssistantMessageEventStream();
    const signal = (options as { signal?: AbortSignal } | undefined)?.signal;

    void (async () => {
      let attempt = 0;
      // Working copy of options we can refresh auth into.
      //
      // Disable the underlying SDK's own client-side retries
      // (maxRetries default 2): retry policy lives HERE, in one place
      // that (a) re-resolves auth on 401 and (b) honours rate-limit
      // wait times. Two competing retry layers would double the
      // backoff and hide 429s from our rate-limit handling. We keep
      // the caller's value if they explicitly set one.
      let opts: Record<string, unknown> = {
        maxRetries: 0,
        ...(options ?? {}),
      };

      // Whether ANY prior attempt had already streamed content. When
      // true, a replay attempt suppresses its `start` event so the
      // downstream harness keeps a single message slot and each event's
      // full `partial` overwrites the failed half (rather than pushing
      // a second assistant message). The client is separately told to
      // reset its in-progress bubble via the retry notice.
      let replayingAfterContent = false;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        attempt += 1;
        let sawContent = false;
        try {
          const src = fn(model, context, opts);
          for await (const ev of src) {
            if (isContentEvent(ev)) sawContent = true;
            // On a post-content replay, swallow the fresh `start`: the
            // harness already has a message slot from the first run and
            // a second `start` would append a duplicate assistant
            // message. Subsequent events carry the full `partial`, so
            // the slot is overwritten cleanly.
            if (ev.type === "start" && replayingAfterContent) {
              continue;
            }
            // A terminal error event: treat like a thrown error so the
            // retry decision is centralised.
            if (ev.type === "error") {
              if (ev.reason === "aborted") {
                out.push(ev);
                out.end(ev.error);
                return;
              }
              throw ev.error; // carries errorMessage / stopReason=error
            }
            out.push(ev);
            if (ev.type === "done") {
              out.end(ev.message);
              return;
            }
          }
          // Stream ended without an explicit done/error terminal.
          // Nothing more to do; close the passthrough.
          out.end();
          return;
        } catch (err) {
          if (signal?.aborted) {
            failStream(out, err);
            return;
          }
          const cls = classifyError(err);
          // Retry after content only when explicitly allowed. Rebuilding
          // the whole message is correct (the harness overwrites via
          // `partial`, the client resets its bubble), but it re-spends
          // tokens and briefly flashes the answer, so it's gated.
          const contentBlocks = sawContent && !r.retryAfterContent;
          const canRetry =
            cls.retriable && !contentBlocks && attempt < r.maxAttempts;
          if (!canRetry) {
            if (sawContent && cls.retriable && !r.retryAfterContent) {
              log.warn(
                `[model-retry] ${label}: transient error after content already streamed (${cls.kind}); retryAfterContent disabled, not retrying`,
              );
            }
            failStream(out, err);
            return;
          }
          // Remember if this (or any prior) attempt streamed content, so
          // the next attempt suppresses its `start` and the client is
          // told to reset.
          if (sawContent) replayingAfterContent = true;

          if (cls.authFailure && deps.reResolveApiKey) {
            try {
              const fresh = deps.reResolveApiKey();
              opts = { ...opts, apiKey: fresh };
            } catch (reErr) {
              log.warn(
                `[model-retry] ${label}: apiKey re-resolve failed: ${errText(reErr)}`,
              );
            }
          }

          const delay = backoffDelayMs(attempt, cls, r);
          emitRetry(deps, log, {
            attempt,
            maxAttempts: r.maxAttempts,
            kind: cls.kind,
            delayMs: delay,
            rateLimited: cls.rateLimited,
            authFailure: cls.authFailure,
            contentStreamed: replayingAfterContent,
            label,
            message: "",
          });
          try {
            await sleep(delay, signal);
          } catch {
            // Aborted during backoff.
            failStream(out, err);
            return;
          }
        }
      }
    })();

    return out;
  };
}

/**
 * Retry wrapper for a non-streaming completion promise (e.g. pi-ai's
 * `completeSimple`, used by compact()). Since there's no partial output
 * to worry about, every retriable failure is safe to retry.
 *
 * `run(apiKey)` performs one attempt with the given key; on an auth
 * failure the caller-supplied `reResolveApiKey` (if any) refreshes the
 * key before the next attempt.
 */
export async function retryCompletion<T>(
  run: (apiKey: string) => Promise<T>,
  initialApiKey: string,
  deps: WrapStreamDeps,
): Promise<T> {
  const r = deps.resilience;
  const log = deps.log ?? { warn: (m: string) => console.warn(m) };
  const label = deps.label ?? "model";
  let apiKey = initialApiKey;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    try {
      return await run(apiKey);
    } catch (err) {
      const cls = classifyError(err);
      if (!r.enabled || !cls.retriable || attempt >= r.maxAttempts) {
        throw err;
      }
      if (cls.authFailure && deps.reResolveApiKey) {
        try {
          apiKey = deps.reResolveApiKey();
        } catch (reErr) {
          log.warn(
            `[model-retry] ${label}: apiKey re-resolve failed: ${errText(reErr)}`,
          );
        }
      }
      const delay = backoffDelayMs(attempt, cls, r);
      emitRetry(deps, log, {
        attempt,
        maxAttempts: r.maxAttempts,
        kind: cls.kind,
        delayMs: delay,
        rateLimited: cls.rateLimited,
        authFailure: cls.authFailure,
        contentStreamed: false,
        label,
        message: "",
      });
      await sleep(delay);
    }
  }
}

/** Emit a terminal error event on the passthrough stream mirroring
 *  pi-ai's own error shape, so downstream consumers (handler.ts's
 *  agent_end introspection) behave identically to a native failure. */
function failStream(out: AssistantMessageEventStream, err: unknown): void {
  // If the thrown value is already an error AssistantMessage, reuse it;
  // otherwise synthesise a minimal one.
  const asMsg = err as { role?: string; stopReason?: string } | undefined;
  if (asMsg && asMsg.role === "assistant" && asMsg.stopReason === "error") {
    const msg = err as import("@earendil-works/pi-ai").AssistantMessage;
    out.push({ type: "error", reason: "error", error: msg });
    out.end(msg);
    return;
  }
  const synthetic = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: errText(err),
  } as unknown as import("@earendil-works/pi-ai").AssistantMessage;
  out.push({ type: "error", reason: "error", error: synthetic });
  out.end(synthetic);
}
