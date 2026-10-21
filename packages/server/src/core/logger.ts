/**
 * Structured logger for tianshu server.
 *
 * Uses pino — JSON Lines output, child logger inheritance,
 * correlation ID propagation.
 *
 * Usage:
 *   import { createLogger } from "../core/logger.js";
 *   const log = createLogger("handler");
 *   const turnLog = log.child({ cid, userId, sessionId });
 *   turnLog.info("turn started");
 *   turnLog.info({ durationMs: 1200 }, "turn ended");
 *
 * Env:
 *   LOG_LEVEL   — trace/debug/info/warn/error/fatal (default: info)
 *   LOG_FORMAT  — "text" for pino-pretty, else JSON Lines
 */

import pino from "pino";

const level = process.env.LOG_LEVEL || "info";

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

export const rootLogger = pino({
  level,
  transport,
  timestamp: pino.stdTimeFunctions.isoTime,
  messageKey: "msg",
  // Strip noise fields — we don't need pid/hostname in a single-process app
  base: undefined,
});

/**
 * Create a module-scoped logger.
 *
 * ```ts
 * const log = createLogger("handler");
 * log.info("server started");
 * log.child({ cid: "cid_abc" }).info("turn started");
 * ```
 */
export function createLogger(mod: string): pino.Logger {
  return rootLogger.child({ mod });
}

export type Logger = pino.Logger;
