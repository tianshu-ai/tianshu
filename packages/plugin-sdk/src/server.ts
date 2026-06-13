// Server-side plugin runtime contract (ADR-0003 §6, ADR-0004 §2/§8).

import type { Request, Response } from "express";
import type { WebSocket } from "ws";
import type { CapabilityName } from "./capabilities.js";
import type { SandboxKind } from "./manifest.js";
import type { ToolsetProvider } from "./mcp-toolset.js";

/** Tenant-scoped context handed to every plugin's `activate(ctx)`. */
export interface PluginContext {
  pluginId: string;
  tenantId: string;
  /**
   * The opened tenant SQLite handle. Same instance the core uses, so
   * plugins must not call `close()` on it.
   */
  db: TenantDbHandle;
  /** Resolved + merged tenant config (subset). */
  tenantConfig: ResolvedConfigShape;
  /** @deprecated Use `tenantConfig`. Removed in a future SDK version. */
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
  /**
   * Agent tools the plugin contributes. Keys must match the
   * `module` strings declared in `manifest.contributes.tools[]`.
   * The host collects every active plugin's tools each agent turn
   * and merges them with the core tool set (fs read/write/etc.).
   *
   * A tool's `available()` (if present) gates registration on a
   * per-turn basis — use this for status-aware tools whose backing
   * runner may not be ready yet.
   */
  tools?: Record<string, AgentTool>;
  /**
   * Dynamic tool *providers* whose tool list can change at runtime.
   * Today's only built-in implementation is `McpToolset`, which
   * reflects an upstream MCP server's `tools/list` into AgentTools
   * on each refresh — see `mcp-toolset.ts`. Keys must match the
   * `module` strings declared in `manifest.contributes.toolsets[]`.
   *
   * The host calls `provider.listTools()` every time it builds the
   * per-turn tool list, so the surface area can grow / shrink as
   * MCP servers come and go without the plugin having to re-run
   * `activate()`. Failures inside a provider are visible through
   * the global MCP admin page (powered by `provider.snapshot?.()`).
   */
  toolsetProviders?: Record<string, ToolsetProvider>;
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

// ─── Agent tools (ADR-0004 §10) ───────────────────────────────

/**
 * Per-call context handed to an agent tool's `execute()`. Lets the
 * tool reach back into the tenant capability registry, the user's
 * home dir, and a small log surface without re-deriving them. Host
 * fills this in on every tool invocation.
 */
export interface AgentToolContext {
  pluginId: string;
  tenantId: string;
  userId: string;
  /** Read-only capability lookup. Subset of CapabilityHandle
   *  (no event subscription) because tool execution is
   *  request-scoped — if a capability flips during a turn, the
   *  agent loop will pick that up next turn via toolsForTenant. */
  capabilities: ReadOnlyCapabilityHandle;
  /** Per-user workspace dir on the host filesystem. */
  userHomeDir: string;
  /** Tenant root dir (host filesystem). Plugins that need to write
   *  to `<tenant>/_tenant/config/...` use this; most tools don't. */
  tenantHomeDir: string;
  /**
   * Agent identity inside the tenant.
   *
   *   - { kind: "main" }
   *     The chat-shell agent the user is talking to. Default if a
   *     plugin tool is invoked outside any agent loop (e.g. from a
   *     route handler).
   *   - { kind: "worker", workerKind: "<id>" }
   *     A worker pool run; `workerKind` is the worker_agent kind
   *     id (e.g. "llm", "echo").
   *
   * Tools that touch shared tenant config (skills, future SOUL/
   * MEMORY surfaces) use this to enforce a write boundary: main
   * may write to `_tenant/config/main/...` and `_tenant/config/`;
   * workers may only write to `_tenant/config/workers/<kind>/...`.
   * Reads are not gated by this field.
   *
   * Optional for backwards compatibility — missing means "main".
   */
  agentScope?:
    | { kind: "main" }
    | { kind: "worker"; workerKind: string };
  log: PluginLogger;
  /**
   * Id of the chat / worker session the LLM that called this tool
   * is running in. Plugins use it to attribute side-effects back
   * to the asking session (e.g. workboard's task_create stamps
   * `tasks.parent_session_id` so the worker pool can later notify
   * this session when the task finishes).
   *
   * Optional: tools invoked outside an LLM session (e.g. internal
   * scheduled jobs) won't have one.
   */
  sessionId?: string;
}

/** Lookup-only subset of CapabilityHandle (no `on()`). */
export interface ReadOnlyCapabilityHandle {
  get<T = unknown>(name: CapabilityName): T | undefined;
  has(name: CapabilityName): boolean;
}

/**
 * Canonical result shape an agent tool should return. Two extra
 * fields beyond `{ ok, text }` are recognised:
 * - `data`: structured payload the host JSON-encodes into the chat
 *   log alongside `text`, so the agent sees both the human-readable
 *   summary and the structured details.
 * - any other field: passed through verbatim for plugins that want
 *   to attach custom metadata (e.g. `exit_code`, `duration_ms`).
 *
 * Tools MAY return arbitrary JSON-serialisable values; the host
 * normalises them to `{ ok, text }` before they reach the LLM.
 * Returning this canonical shape directly is preferred because
 * the agent sees a consistent surface across plugins.
 *
 * Use the {@link okResult} / {@link errorResult} helpers in
 * `tools/result.js` (or hand-roll) to build these.
 */
export interface ToolResult {
  /** True iff the tool semantically succeeded. The host renders the
   *  tool-call chip green when ok, red when not. */
  ok: boolean;
  /** Human-readable summary the agent sees. Keep it short — model
   *  context is precious. Long output should go to a file via
   *  another tool, not into `text`. */
  text: string;
  /** Optional structured payload preserved verbatim. */
  data?: unknown;
  /** Plugin-defined extras. Allowed but discouraged. */
  [key: string]: unknown;
}

/**
 * A schema + executor pair that becomes an agent tool. The host
 * collects these from every active plugin via
 * `exports.tools[<module-key>]`, gates each one through
 * `available()`, then registers the surviving schemas with the
 * agent loop.
 *
 * Prefer returning a {@link ToolResult} from `execute()`. If you
 * return any other JSON-serialisable value, the host JSON-encodes
 * it into `text` and best-effort-derives `ok`.
 */
export interface AgentTool {
  /** pi-ai Tool schema. Name is what the model sees. */
  schema: import("@earendil-works/pi-ai").Tool;
  /** Optional per-turn gate. Return false to hide the tool this
   *  turn (e.g. when the backing capability is in `state: error`).
   *  Default true. */
  available?(ctx: AgentToolContext): boolean | Promise<boolean>;
  /** Run the tool with the model-supplied args. */
  execute(
    args: Record<string, unknown>,
    ctx: AgentToolContext,
  ): ToolResult | unknown | Promise<ToolResult | unknown>;
}

/** Build an `ok=true` ToolResult. Optional `data` payload preserved. */
export function okResult(text: string, data?: unknown): ToolResult {
  return data === undefined ? { ok: true, text } : { ok: true, text, data };
}

/** Build an `ok=false` ToolResult. Optional `data` payload preserved. */
export function errorResult(text: string, data?: unknown): ToolResult {
  return data === undefined ? { ok: false, text } : { ok: false, text, data };
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
