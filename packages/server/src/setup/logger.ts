// Centralised leveled logger for tianshu server.
//
// Uses pino for structured JSON Lines output. The Logger interface
// stays compatible with existing call-sites: info(msg, ...extras).
// pino handles serialisation, levels, and timestamps.
//
// Env:
//   LOG_LEVEL      — trace/debug/info/warn/error/fatal (default: info)
//   LOG_FORMAT     — "text" for pino-pretty human-readable output
//   TIANSHU_LOG_LEVEL — legacy alias for LOG_LEVEL

import pino from "pino";
import { hrtime } from "node:process";

// ─── pino root ─────────────────────────────────────────────

const level =
  process.env.LOG_LEVEL ??
  process.env.TIANSHU_LOG_LEVEL ??
  "info";

const transport =
  process.env.LOG_FORMAT === "text"
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      }
    : undefined;

const pinoRoot = pino({
  level,
  transport,
  timestamp: pino.stdTimeFunctions.isoTime,
  messageKey: "msg",
  base: undefined, // strip pid/hostname noise
});

// ─── public Logger interface (compatible with existing call-sites) ──

export const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function setLogLevel(next: LogLevel): void {
  pinoRoot.level = next;
}
export function getLogLevel(): LogLevel {
  return pinoRoot.level as LogLevel;
}

/**
 * Logger with pino backend. Call-site compatible with existing code:
 *   log.info("message")
 *   log.info("message", { key: "val" })
 *   log.info("message", extraArg1, extraArg2)
 */
export interface Logger {
  error(msg: string, ...extras: unknown[]): void;
  warn(msg: string, ...extras: unknown[]): void;
  info(msg: string, ...extras: unknown[]): void;
  debug(msg: string, ...extras: unknown[]): void;
  trace(msg: string, ...extras: unknown[]): void;
  /** Dedup: emit at most once per `ttlMs` for a given key. */
  dedup(key: string, ttlMs: number): Logger;
  /** Create a child logger with additional context fields. */
  child(prefix: string): Logger;
  /** Create a child logger with structured context (pino-native). */
  childWith(bindings: Record<string, unknown>): Logger;
  /** Access the underlying pino logger for advanced use. */
  pino: pino.Logger;
}

/** Per-key dedup state. */
const dedupState = new Map<string, number>();

/** Merge extras into a pino mergingObject.
 *  - Single object extra → merge directly
 *  - Multiple / non-object extras → { extras: [...] }
 */
function mergeExtras(extras: unknown[]): Record<string, unknown> | undefined {
  if (extras.length === 0) return undefined;
  if (extras.length === 1 && typeof extras[0] === "object" && extras[0] !== null && !Array.isArray(extras[0])) {
    return extras[0] as Record<string, unknown>;
  }
  return { extras };
}

function makeLogger(
  pinoInst: pino.Logger,
  dedupKey?: { key: string; ttlMs: number },
): Logger {
  const gate = (): boolean => {
    if (!dedupKey) return true;
    const now = Date.now();
    const seen = dedupState.get(dedupKey.key);
    if (seen != null && now - seen < dedupKey.ttlMs) return false;
    dedupState.set(dedupKey.key, now);
    if (dedupState.size > 10_000) {
      const entries = [...dedupState.entries()].sort((a, b) => a[1] - b[1]);
      for (const [k] of entries.slice(0, 5_000)) dedupState.delete(k);
    }
    return true;
  };

  const emit = (level: LogLevel, msg: string, extras: unknown[]): void => {
    if (!gate()) return;
    const merged = mergeExtras(extras);
    if (merged) pinoInst[level](merged, msg);
    else pinoInst[level](msg);
  };

  return {
    error(msg, ...extras) { emit("error", msg, extras); },
    warn(msg, ...extras) { emit("warn", msg, extras); },
    info(msg, ...extras) { emit("info", msg, extras); },
    debug(msg, ...extras) { emit("debug", msg, extras); },
    trace(msg, ...extras) { emit("trace", msg, extras); },
    dedup(key, ttlMs) {
      return makeLogger(pinoInst, { key, ttlMs });
    },
    child(prefix) {
      return makeLogger(pinoInst.child({ mod: prefix }), dedupKey);
    },
    childWith(bindings) {
      return makeLogger(pinoInst.child(bindings), dedupKey);
    },
    pino: pinoInst,
  };
}

/** Root logger with no prefix. */
export const rootLog: Logger = makeLogger(pinoRoot);

/**
 * Create a namespaced logger.
 *
 * ```ts
 * const log = createLogger("handler");
 * log.info("turn started");
 * log.childWith({ cid, userId }).info("processing");
 * ```
 */
export function createLogger(name: string): Logger {
  return makeLogger(pinoRoot.child({ mod: name }));
}

// ─── utility exports (used by handler.ts etc.) ─────────────

/**
 * Millisecond duration since a monotonic start.
 * `startedAt = hrtime.bigint()` → `elapsedMs(startedAt)` at end.
 */
export function elapsedMs(startedAt: bigint): number {
  const delta = hrtime.bigint() - startedAt;
  return Number(delta / 1_000_000n);
}

/**
 * Render tool-call args as a bounded JSON string for logs.
 */
export function summarizeToolArgs(args: unknown, maxLen = 300): string {
  if (args === undefined || args === null) return "{}";
  let s: string;
  try {
    s = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    return "[unserializable]";
  }
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `…(+${s.length - maxLen}b)`;
}

/**
 * Rough byte size of a tool-result payload for logging.
 */
export function estimateToolResultBytes(result: unknown): number {
  if (result === undefined || result === null) return 0;
  if (typeof result === "string") return result.length;
  try {
    return JSON.stringify(result).length;
  } catch {
    return -1;
  }
}
