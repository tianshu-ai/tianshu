// Centralised leveled logger for tianshu server.
//
// Motivation (Yu, 2026-09-14 09:03): "bridge 和 tianshu 的日志都没有
// 时间戳，另外对于工具调用的记录也不够细节，加个 debug 或者 trace
// level 的日志打开开关，这样能看到详细日志".
//
// Design goals:
//   1. Zero-config for existing `console.log` calls — they still
//      work exactly like before. This module doesn't monkey-patch
//      console; it's opt-in for callers that want leveled output.
//   2. A single knob (TIANSHU_LOG_LEVEL) to gate volume. Default
//      "info" keeps the log signal-to-noise ratio high; setting
//      "debug" or "trace" unlocks tool-call and heartbeat detail
//      for a specific debugging session.
//   3. Emit through the same stdout/stderr the log-tee already
//      captures, so file rotation and heartbeat interleaving
//      keep working. No new file paths.
//   4. Optional per-key dedup — the "bridge registered" line
//      currently fires every 20s per device and drowns real
//      events. `.dedup(key, ttlMs).info(msg)` collapses repeats
//      within the window down to one line.
//
// Non-goals:
//   * Structured JSON output. Yu reads these files by eye; ISO
//     timestamps + human-readable text is what fits that workflow.
//   * Replacing every existing console.log in one shot. This
//     module lands alongside them and callers migrate at the
//     pace real debugging demands.

import { hrtime } from "node:process";

/** Levels are ordered least → most verbose. */
export const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

function resolveLevel(): LogLevel {
  const raw = String(process.env.TIANSHU_LOG_LEVEL ?? "info").toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(raw)
    ? (raw as LogLevel)
    : "info";
}

/** Mutable module-level cache; refreshed on demand. */
let currentLevel: LogLevel = resolveLevel();
/**
 * Bump the level at runtime (tests, admin endpoints). Prefer the
 * env var for normal use — mutation here is not persistent.
 */
export function setLogLevel(next: LogLevel): void {
  currentLevel = next;
}
export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] <= LEVEL_RANK[currentLevel];
}

/** ISO-8601 with ms precision, e.g. 2026-09-14T01:23:45.678Z. */
function timestamp(): string {
  return new Date().toISOString();
}

/** Per-key dedup state — 1 entry per unique key. */
const dedupState = new Map<string, number>();

/**
 * Args to log methods. Mirrors console.log's signature so
 * callers can migrate `console.log("foo", { a: 1 })` to
 * `log.info("foo", { a: 1 })` verbatim.
 */
type LogArgs = readonly unknown[];

/** Format extra args as a trailing " " + JSON, elided if empty. */
function formatExtras(extras: LogArgs): string {
  if (extras.length === 0) return "";
  try {
    return " " + extras.map((v) => (typeof v === "string" ? v : safeJson(v))).join(" ");
  } catch {
    return " [unserializable extras]";
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Emit one line at `level` if enabled. */
function emit(level: LogLevel, prefix: string, msg: string, extras: LogArgs): void {
  if (!shouldLog(level)) return;
  const line = `[${timestamp()}] [${level}] ${prefix}${msg}${formatExtras(extras)}`;
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

/**
 * Sub-logger with a stable prefix (e.g. "[handler] " or "[plugin:xxx] ").
 * Prefix is included in every emitted line and lets callers keep
 * the shorthand call-sites `log.info("started")` while readers
 * still see which subsystem spoke.
 */
export interface Logger {
  error(msg: string, ...extras: unknown[]): void;
  warn(msg: string, ...extras: unknown[]): void;
  info(msg: string, ...extras: unknown[]): void;
  debug(msg: string, ...extras: unknown[]): void;
  trace(msg: string, ...extras: unknown[]): void;
  /**
   * Return a facade that emits at the given level only if `key`
   * hasn't been seen within `ttlMs`. Used for "bridge registered"
   * type heartbeats where the same message repeats every N seconds
   * per device — collapsing keeps the raw event visible but
   * silences the flood.
   *
   * The dedup window is per-Logger-instance; two loggers sharing
   * the same key still dedupe against each other because the map
   * is module-global. That's intentional — you almost always want
   * heartbeat dedup to be global.
   */
  dedup(key: string, ttlMs: number): Logger;
  /** Create a child logger with an additional prefix segment. */
  child(prefix: string): Logger;
}

function makeLogger(prefix: string, dedupKey?: { key: string; ttlMs: number }): Logger {
  const gate = (level: LogLevel): boolean => {
    if (!dedupKey) return true;
    const now = Date.now();
    const seen = dedupState.get(dedupKey.key);
    if (seen != null && now - seen < dedupKey.ttlMs) return false;
    dedupState.set(dedupKey.key, now);
    // Best-effort cleanup: if the map grows past ~10k entries,
    // drop the oldest half. Keeps memory bounded on long-running
    // servers.
    if (dedupState.size > 10_000) {
      const entries = [...dedupState.entries()].sort((a, b) => a[1] - b[1]);
      for (const [k] of entries.slice(0, 5_000)) dedupState.delete(k);
    }
    void level;
    return true;
  };
  return {
    error(msg, ...extras) {
      if (!gate("error")) return;
      emit("error", prefix, msg, extras);
    },
    warn(msg, ...extras) {
      if (!gate("warn")) return;
      emit("warn", prefix, msg, extras);
    },
    info(msg, ...extras) {
      if (!gate("info")) return;
      emit("info", prefix, msg, extras);
    },
    debug(msg, ...extras) {
      if (!gate("debug")) return;
      emit("debug", prefix, msg, extras);
    },
    trace(msg, ...extras) {
      if (!gate("trace")) return;
      emit("trace", prefix, msg, extras);
    },
    dedup(key, ttlMs) {
      return makeLogger(prefix, { key, ttlMs });
    },
    child(childPrefix) {
      return makeLogger(prefix + childPrefix);
    },
  };
}

/** Root logger with no prefix. Prefer named children via createLogger(). */
export const rootLog: Logger = makeLogger("");

/**
 * Create a namespaced logger. `name` becomes `[name] ` in every
 * emitted line. Convention: match the existing prefix strings in
 * this repo — e.g. "handler", "storage", "plugin:reverse-mcp".
 */
export function createLogger(name: string): Logger {
  return makeLogger(`[${name}] `);
}

/**
 * Millisecond duration since a monotonic start. Callers who want
 * to log "took X ms" pass `startedAt = hrtime.bigint()` at start
 * and `elapsedMs(startedAt)` at end.
 */
export function elapsedMs(startedAt: bigint): number {
  const delta = hrtime.bigint() - startedAt;
  return Number(delta / 1_000_000n);
}

/**
 * Render tool-call args as a bounded JSON string for logs. Long
 * inputs (file bodies, big cmd stdout etc.) get truncated so a
 * single tool_start line stays scannable. Never throws — an
 * unserialisable arg becomes a placeholder.
 *
 * Kept in logger.ts (not handler.ts) so any other tool executor
 * plumbing can reuse the same summarisation and produce
 * comparable log lines.
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
 * Rough byte size of a tool-result payload. Used only for logging
 * — we want to see "result_bytes=45000" to know when a bridge
 * tool returned a huge file, but we don't want to serialise the
 * whole thing every call. Falls back gracefully on non-JSON values.
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
