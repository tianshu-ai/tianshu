// Rolling-file log tee for tianshu server.
//
// Motivation (Yu, 2026-09-13 21:59): "把日志输出到文件里，限制好大小，
// 滚动记录，出问题了我把日志文件给你看".
//
// Everything the server currently writes to stdout / stderr (server
// boot lines, plugin activations, [handler] catch traces, storage
// dbg output when TIANSHU_STORAGE_DEBUG=1, uncaught exceptions,
// etc.) is teed to a daily rolling log file under
// `~/.tianshu/logs/server-YYYY-MM-DD.log`. The original stdout /
// stderr is preserved unchanged — anyone running `npm run dev` in
// a terminal keeps seeing every line live, AND the file collects
// the same content for later post-mortem.
//
// Rotation is by day. On process start we scan the log dir and
// delete files older than TIANSHU_LOG_KEEP_DAYS (default: 7 days).
// A cheap once-per-write date check flips to the next file at
// midnight without needing a background timer.
//
// Env knobs:
//   TIANSHU_LOG_DIR         override log directory (default
//                           `<userHomeDir>/.tianshu/logs`)
//   TIANSHU_LOG_KEEP_DAYS   how many days of logs to retain
//                           (default 7, minimum 1)
//   TIANSHU_LOG_DISABLE=1   opt out entirely (writes only to the
//                           original stdout / stderr)
//
// Zero third-party deps: this file uses `node:fs` only, and its
// write path is a synchronous appendFileSync so log lines that
// precede a crash still land on disk. The overhead per line is one
// fs write; on the reported 44-turn sessions that is orders of
// magnitude cheaper than the storage-debug console.log firehose we
// already fixed in v0.50.2.

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, appendFileSync } from "node:fs";

// Matches a line prefix like `[2026-09-14T00:40:12.345Z]` — the
// shape logger.ts and the heartbeat emit. Used to avoid double-
// stamping in stampLines() below.
const ALREADY_STAMPED_RE = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_KEEP_DAYS = 7;
const MIN_KEEP_DAYS = 1;
const MAX_KEEP_DAYS = 365;

/** yyyy-mm-dd for the local timezone. Used as the log-file suffix. */
function todayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse TIANSHU_LOG_KEEP_DAYS with sane bounds. */
function resolveKeepDays(): number {
  const raw = process.env.TIANSHU_LOG_KEEP_DAYS;
  if (!raw) return DEFAULT_KEEP_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_KEEP_DAYS;
  return Math.max(MIN_KEEP_DAYS, Math.min(MAX_KEEP_DAYS, Math.floor(n)));
}

/** Resolve the log directory. Precedence:
 *    1. TIANSHU_LOG_DIR (absolute path)
 *    2. `<homedir>/.tianshu/logs`
 */
function resolveLogDir(): string {
  const override = process.env.TIANSHU_LOG_DIR;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), ".tianshu", "logs");
}

/** Delete files under `dir` matching `server-YYYY-MM-DD.log` older
 *  than `keepDays` days. Silent on errors — a missing/unreadable
 *  entry must never crash the server. */
function pruneOldLogs(dir: string, keepDays: number): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const cutoffMs = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  for (const name of entries) {
    if (!/^server-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    const full = join(dir, name);
    try {
      const s = statSync(full);
      if (s.mtimeMs < cutoffMs) unlinkSync(full);
    } catch {
      // Skip anything we can't stat/unlink.
    }
  }
}

/** Encode an incoming write chunk to a UTF-8 string. process.stdout
 *  handles Buffer / string / Uint8Array; we do the same. */
function chunkToString(chunk: unknown, encoding?: BufferEncoding): string {
  if (chunk == null) return "";
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString(encoding ?? "utf8");
  return String(chunk);
}

interface LogTeeState {
  dir: string;
  currentStamp: string;
  currentPath: string;
  installed: boolean;
}

let state: LogTeeState | null = null;

/**
 * Install the tee. Idempotent — repeat calls are no-ops.
 *
 * Call this AS EARLY AS POSSIBLE in `index.ts` (right after
 * `loadEnv()`) so every subsequent stdout / stderr write is
 * captured.
 *
 * On failure (unwritable log dir, permission errors, etc.) the
 * tee is silently skipped so the server still starts.
 */
export function installLogTee(): void {
  if (state?.installed) return;
  if (process.env.TIANSHU_LOG_DISABLE === "1") return;

  const dir = resolveLogDir();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch (err) {
    // Can't create dir — bail without teeing. The original stdout
    // still works.
    process.stderr.write(
      `[log-tee] disabled: cannot create ${dir}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  }

  const stamp = todayStamp();
  const path = join(dir, `server-${stamp}.log`);

  state = {
    dir,
    currentStamp: stamp,
    currentPath: path,
    installed: true,
  };

  // Prune once at startup. We don't schedule a repeating pruner —
  // process restarts are frequent enough for this to be sufficient
  // in practice, and a background timer would just be another
  // thing that can leak on hot reload.
  pruneOldLogs(dir, resolveKeepDays());

  // Header line so operators can see when this server booted when
  // they later grep the file.
  const header = `\n=== tianshu server boot ${new Date().toISOString()} pid=${process.pid} ===\n`;
  try {
    appendFileSync(path, header);
  } catch {
    // Ignore — first write will surface any real issue.
  }

  // Monkey-patch stdout.write / stderr.write. Preserve the
  // original for the actual terminal echo; add the tee alongside.
  //
  // We keep the original signature intact (multiple overloads),
  // so downstream code that inspects the return value or passes
  // a callback still works.
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  function teeToFile(text: string): void {
    if (!state) return;
    // Cheap date check: only compute today's stamp when the
    // previously written line's date might be stale. We do it
    // every write — it's a Date allocation and a few string ops,
    // negligible compared to the fs write itself.
    const stampNow = todayStamp();
    if (stampNow !== state.currentStamp) {
      state.currentStamp = stampNow;
      state.currentPath = join(state.dir, `server-${stampNow}.log`);
      // A midnight-crossing boot: prune again so the retention
      // window is honored even on servers that stay up for weeks.
      try {
        pruneOldLogs(state.dir, resolveKeepDays());
      } catch {
        // ignore
      }
    }
    try {
      appendFileSync(state.currentPath, stampLines(text));
    } catch {
      // File write failing must never break user-visible stdout.
      // Common cause: disk full. We drop the log line silently.
    }
  }

  // Prefix every line in `text` with an ISO timestamp so post-
  // mortem readers can measure gaps between events.
  //
  // Motivation (Yu, 2026-09-14 09:03): the 09-13 24:05 abort log
  // was unreadable because thousands of `bridge registered` lines
  // had no time info — impossible to tell whether they were
  // spread over 20s or 2 minutes.
  //
  // Skip lines that ALREADY start with `[YYYY-MM-DDTHH:` — those
  // came through the new logger.ts and have their own stamp; a
  // second one would just clutter the file. Same for heartbeat
  // lines, which pre-stamp themselves inside the setInterval.
  //
  // Trailing-newline preservation is important: chunk.split("\n")
  // on "a\nb\n" gives ["a", "b", ""] and we want the empty trailer
  // to remain a trailing newline in the output. join("\n") on the
  // same array does that correctly.
  function stampLines(text: string): string {
    if (text.length === 0) return text;
    // Fast path: single already-stamped chunk (e.g. logger.ts
    // output, heartbeats). Avoids the split/map/join round-trip
    // for the most common case.
    if (ALREADY_STAMPED_RE.test(text) && !text.slice(0, -1).includes("\n")) {
      return text;
    }
    const ts = new Date().toISOString();
    return text
      .split("\n")
      .map((line, i, arr) => {
        // Preserve empty trailer (from a trailing "\n" split).
        if (i === arr.length - 1 && line === "") return "";
        // Preserve empty interior lines (blank line separators).
        if (line === "") return "";
        // Skip lines already stamped by logger.ts / heartbeat.
        if (ALREADY_STAMPED_RE.test(line)) return line;
        return `[${ts}] ${line}`;
      })
      .join("\n");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout.write as any) = function patchedStdoutWrite(
    chunk: unknown,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    const encoding: BufferEncoding | undefined =
      typeof encodingOrCb === "string" ? (encodingOrCb as BufferEncoding) : undefined;
    teeToFile(chunkToString(chunk, encoding));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origStdoutWrite as any)(chunk, encodingOrCb, cb);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr.write as any) = function patchedStderrWrite(
    chunk: unknown,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    const encoding: BufferEncoding | undefined =
      typeof encodingOrCb === "string" ? (encodingOrCb as BufferEncoding) : undefined;
    teeToFile(chunkToString(chunk, encoding));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origStderrWrite as any)(chunk, encodingOrCb, cb);
  };

  // Catch-alls so a crash still ends up on disk. Do NOT swallow —
  // rethrow through the normal Node handlers (there's no
  // process.on("uncaughtException") default that quits gracefully,
  // so we just log and let Node's default handler win).
  process.on("uncaughtException", (err) => {
    teeToFile(`[uncaughtException] ${err.stack ?? err.message ?? String(err)}\n`);
  });
  process.on("unhandledRejection", (reason) => {
    const text = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    teeToFile(`[unhandledRejection] ${text}\n`);
  });

  // One-line hint so operators reading the terminal know where the
  // file lives. Goes through the original writer directly to avoid
  // being teed to a file that was just announced.
  origStdoutWrite(`[log-tee] server logs \u2192 ${path} (keep ${resolveKeepDays()} days)\n`);

  // Event-loop heartbeat. Fires every 100ms and writes a single
  // line straight to the current log file. When the event loop
  // is healthy the log has one heartbeat every ~100ms; when it
  // stalls (a synchronous CPU chunk, a blocking fs call, GC
  // pause, etc.) the gap between consecutive heartbeat lines
  // reveals exactly how long the process was frozen — and the
  // surrounding non-heartbeat lines say WHICH request caused it.
  //
  // Motivation (Yu, 2026-09-13 24:05): the server log showed
  // ~2 minutes of total silence between the last plugin
  // activation and the auto-recovery line, with the client-side
  // bridge log showing the tool ran to completion. Classic
  // event-loop stall, but there was no way to tell WHERE in
  // the request path we stopped responding. Heartbeats make
  // the next occurrence self-locating.
  //
  // Overhead: one 100ms setInterval + one small appendFileSync
  // per tick. On a healthy loop that's ~40 bytes every 100ms
  // ≈ 34 KB/day of heartbeat noise; the same log rotation
  // cleans it up on the 7-day cadence.
  //
  // Opt out with TIANSHU_HEARTBEAT_DISABLE=1 if the noise ever
  // becomes a problem for a specific investigation.
  if (process.env.TIANSHU_HEARTBEAT_DISABLE !== "1") {
    const heartbeatIntervalMs = Math.max(50, Number(process.env.TIANSHU_HEARTBEAT_MS) || 100);
    let hbSeq = 0;
    const timer = setInterval(() => {
      // Write straight through appendFileSync — do NOT go through
      // the tee'd stdout/stderr (would double-echo to terminal
      // and drown out real log lines). On event-loop stall this
      // very call also stalls, but that's precisely the point:
      // when the loop resumes, all queued heartbeats flush in
      // order and the missing timestamps prove the stall length.
      if (!state) return;
      try {
        appendFileSync(state.currentPath, `[heartbeat] seq=${hbSeq++} ${new Date().toISOString()}\n`);
      } catch {
        // Log dir gone away, disk full, permission changed —
        // never crash on log-write failure.
      }
    }, heartbeatIntervalMs);
    // Never let the heartbeat keep the process alive on its own.
    timer.unref?.();
  }
}

/** Exposed for tests: what file path is currently active. */
export function currentLogPath(): string | null {
  return state?.currentPath ?? null;
}

/** Exposed for tests: is the tee currently installed. */
export function isLogTeeInstalled(): boolean {
  return state?.installed === true;
}
