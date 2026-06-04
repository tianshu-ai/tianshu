// Server-side plugin runtime contract (ADR-0003 §6).

import type { Request, Response } from "express";
import type { WebSocket } from "ws";

/** Tenant-scoped context handed to every plugin's `activate(ctx)`. */
export interface PluginContext {
  pluginId: string;
  tenantId: string;
  /**
   * The opened tenant SQLite handle. Same instance the core uses, so
   * plugins must not call `close()` on it.
   */
  db: TenantDbHandle;
  /** Resolved + merged tenant config. */
  config: ResolvedConfigShape;
  /** Bound logger: prefixes [plugin:<id>] [tenant:<id>]. */
  log: PluginLogger;
  /** Absolute path to `<tenant>/workspace`. */
  workspaceDir: string;
  /** Send a WS message to every socket currently connected for this tenant. */
  broadcast(type: string, payload: unknown): void;
}

/**
 * Minimal shape we need from a `better-sqlite3` Database, declared
 * structurally so the SDK doesn't have to depend on better-sqlite3.
 */
export interface TenantDbHandle {
  prepare<P extends unknown[] = unknown[], R = unknown>(
    sql: string,
  ): {
    run(...params: P): unknown;
    get(...params: P): R | undefined;
    all(...params: P): R[];
  };
  exec(sql: string): unknown;
}

/**
 * Subset of ResolvedConfig that plugins are allowed to read. Kept
 * minimal — plugins should not depend on the full `@tianshu/server`
 * type. New surface gets exposed here on demand.
 */
export interface ResolvedConfigShape {
  defaultModel?: string;
  branding?: { name?: string; emoji?: string };
}

export interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export type PluginRouteHandler = (req: Request, res: Response) => void | Promise<void>;

export type PluginWsHandler = (
  msg: { type: string } & Record<string, unknown>,
  socket: WebSocket,
  ctx: PluginContext,
) => void | Promise<void>;

export interface PluginServerExports {
  routes?: Record<string, PluginRouteHandler>;
  wsHandlers?: Record<string, PluginWsHandler>;
}

/** A server-side plugin module exports `activate` (required) and
 *  optional `deactivate`. */
export interface PluginServerModule {
  activate(ctx: PluginContext): Promise<PluginServerExports> | PluginServerExports;
  deactivate?(): Promise<void> | void;
}
