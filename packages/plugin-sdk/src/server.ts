// Server-side plugin runtime contract (ADR-0003 §6, ADR-0004 §2/§8).

import type { Request, Response } from "express";
import type { WebSocket } from "ws";
import type { CapabilityName } from "./capabilities.js";
import type { SandboxKind } from "./manifest.js";

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
  /** Absolute path to a user's per-tenant home, i.e.
   *  `<tenant>/workspace/users/<userId>`. Plugins resolve this at
   *  request time using `req.ctx.userId` (set by host middleware). */
  userHomeDir(userId: string): string;
  /** Send a WS message to every socket currently connected for this tenant. */
  broadcast(type: string, payload: unknown): void;
  /**
   * Capability registry handle (ADR-0004 §8). Lets a plugin look up
   * other plugins' provided capabilities. By the time `activate()` is
   * called, every capability listed in this plugin's `requires[]` is
   * already registered. Capabilities this plugin itself provides are
   * **not** yet registered — see ADR-0004 §8 (single-phase activation).
   */
  capabilities: CapabilityHandle;
  /**
   * Per-plugin opaque config from `<tenant>/config.json` →
   * `plugins[<id>].config`. Host does not interpret it; plugins
   * cast/parse as needed. Empty object if not configured.
   */
  pluginConfig: Record<string, unknown>;
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
  /**
   * Ready-to-use sandbox runners keyed by the `module` string used
   * in `manifest.contributes.sandboxes[].module`. The plugin's
   * `activate(ctx)` is responsible for constructing each runner
   * (typically in a small "facade" that picks between a real
   * runtime and a nullable fallback) and exposing it here. The host
   * picks the runner up by key and registers it under the matching
   * `sandbox.<kind>` capability.
   *
   * The `SandboxModule` type below is exported for plugins that
   * want to factor their runner construction into a `start(ctx) =>
   * SandboxRunner` shape, but the host never invokes `start()`
   * itself — plugins do that inside `activate()`.
   */
  sandboxes?: Record<string, SandboxRunner>;
}

// ─── Capability registry ────────────────────────────────────────

export interface CapabilityHandle {
  /** Get a registered capability's value, or undefined if no provider. */
  get<T = unknown>(name: CapabilityName): T | undefined;
  /** Cheaper than `get()` when the caller doesn't need the value. */
  has(name: CapabilityName): boolean;
  /**
   * Subscribe to lifecycle events for one capability. Useful when a
   * plugin or the agent loop wants to react when a provider comes or
   * goes mid-process (registry invalidation, plugin re-enabled, ...).
   * Returns an unsubscribe function.
   */
  on(
    name: CapabilityName,
    ev: "registered" | "unregistered",
    fn: () => void,
  ): () => void;
}

// ─── Sandbox surface (ADR-0004 §2) ─────────────────────────────

/**
 * Optional convenience interface for plugins that want to factor
 * runner construction out of `activate()`. The host does not call
 * `start()` itself — plugins call it from inside `activate()` and
 * expose the returned runner via `exports.sandboxes[<key>]`.
 */
export interface SandboxModule {
  start(ctx: PluginContext): Promise<SandboxRunner>;
}

export interface SandboxRunner {
  /** Stable id; equals `<plugin-id>.<contribution-id>`. */
  readonly id: string;
  readonly kind: SandboxKind;

  // ─── shell execution ─────────────────────────────────
  exec(req: ExecRequest): Promise<ExecResult>;

  // ─── workspace I/O ──────────────────────────────────
  readFile(relPath: string): Promise<string>;
  writeFile(relPath: string, content: string): Promise<void>;
  /** Host-side absolute path to this tenant's workspace dir. */
  workspacePath(): string;

  // ─── lifecycle ───────────────────────────────────────
  /** Drop in-memory state and re-init. Triggered only by an admin
   *  Reset action or by the agent's `reset_sandbox` tool. The host
   *  never auto-resets. */
  reset(): Promise<void>;
  /** Tear down. Called on tenant DB pool eviction or plugin
   *  deactivation. Must be idempotent. */
  shutdown(): Promise<void>;
  /** Snapshot for the status panel + `GET /api/p/<id>/status`. */
  status(): Promise<SandboxStatus>;

  // ─── optional browser sidecar (§2) ─────────────────────────
  /** If this runner's plugin also provides `browser.cdp`, the
   *  sidecar is exposed here so the host can register it under the
   *  capability without a second module entry. Otherwise undefined. */
  readonly browser?: BrowserSidecar;
}

export interface ExecRequest {
  /** Shell command. Equivalent to `bash -c <command>` in the guest. */
  command: string;
  /** Working directory inside the guest. Default: `/workspace`. */
  workdir?: string;
  /** Override timeout in ms. Default plugin-defined; the host caps
   *  this at 30 min when wiring up the agent's `exec` tool. */
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Wall time in ms. */
  durationMs: number;
  /** True iff the command was killed by timeout. */
  timedOut: boolean;
}

export type SandboxState = "starting" | "ready" | "running" | "error" | "stopped";

export interface SandboxStatus {
  state: SandboxState;
  /** Wall time the runner has been in its current incarnation. */
  uptimeMs: number;
  lastError?: string;
  /** Plugin-specific extras (image, idle countdown, sidecar status, …). */
  meta?: Record<string, unknown>;
}

export interface BrowserSidecar {
  /** Host port forwarded to chromium CDP (9222 inside guest). */
  cdpHostPort(): number | undefined;
  /** Host port forwarded to Playwright MCP (3200 inside guest). */
  mcpHostPort(): number | undefined;
  /** Host port forwarded to noVNC (6080 inside guest). */
  vncHostPort(): number | undefined;
  /** Set by the BrowserPanel ResizeObserver; read by the agent's
   *  browser tool to re-apply page.setViewportSize() after navigation. */
  setLastViewport(v: { width: number; height: number }): void;
  getLastViewport(): { width: number; height: number } | undefined;
  /** Restart chromium + playwright-mcp without rebuilding the whole
   *  sandbox. Returns true on success. */
  restart(): Promise<boolean>;
}

/** A server-side plugin module exports `activate` (required) and
 *  optional `deactivate`. */
export interface PluginServerModule {
  activate(ctx: PluginContext): Promise<PluginServerExports> | PluginServerExports;
  deactivate?(): Promise<void> | void;
}
