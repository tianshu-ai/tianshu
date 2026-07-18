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
  /** True when the sqlite-vec extension loaded on this connection, so
   *  `vec0` virtual tables are available. The host loads the extension
   *  once per connection; plugins branch on this and fall back to
   *  keyword search when false. */
  readonly vecAvailable?: boolean;
}

/**
 * Subset of ResolvedConfig that plugins are allowed to read. Kept
 * minimal — plugins should not depend on the full `@tianshu/server`
 * type. New surface gets exposed here on demand.
 */
export interface ResolvedConfigShape {
  defaultModel?: string;
  branding?: { name?: string; emoji?: string };
  /** Default reply language for agents (Settings → Models → Output
   *  language): "auto" | "en" | "zh". Absent/auto = match the user. */
  outputLanguage?: "auto" | "en" | "zh";
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
   * Chat-platform channel adapters (Feishu / Telegram / WeChat /
   * ...). Keys match the `module` strings declared in
   * `manifest.contributes.channels[]`. Each entry is a *factory*
   * — the host calls it once per configured binding (account
   * pair) so multiple instances of the same plugin can coexist
   * (e.g. two Feishu apps for two tenants). The factory returns
   * a `ChannelAdapter` the host wires into its channel hub.
   *
   * Plugins that don't contribute any channel adapter leave this
   * undefined.
   */
  channels?: Record<string, ChannelAdapterFactory>;
  /**
   * Per-task sandbox lifecycle manager (`sandbox.taskPool`
   * capability). The host registers it under that capability so
   * other plugins (today: workboard) can drive task acquire/
   * release/destroy.
   *
   * Distinct from `sandboxes[]` because a task pool is not a
   * single SandboxRunner; it is a manager that creates per-task
   * runners on demand. Plugins that don't manage per-task
   * sandboxes (the common case) leave this undefined.
   */
  taskSandboxPool?: TaskSandboxPool;
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
  /**
   * Generic capability values keyed by capability name, for
   * capabilities that aren't backed by one of the specialised
   * exports above (sandboxes / taskSandboxPool / browser.cdp). The
   * host registers each entry under its capability after activation,
   * so other code (host or plugins) can look it up via
   * `ctx.capabilities.get(name)`.
   *
   * Every key MUST appear in this plugin's `manifest.provides[]` and
   * be a name in the SDK's KNOWN_CAPABILITIES registry. Example: the
   * `wiki` plugin provides `wiki.ingest` here so the host's
   * compaction path can file segments into the vault.
   */
  capabilityProviders?: Record<string, unknown>;
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
    | {
        kind: "worker";
        workerKind: string;
        /** Worker's filesystem slug (matches the directory name
         *  under `_tenant/config/workers/<slug>/`). When unset the
         *  worker is running with no fs presence — falling back to
         *  the legacy DB-only path. Used by the tenant_config_*
         *  tools to scope writes to this worker's own bundle. */
        slug?: string;
      };
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
  /**
   * Channel-session tagging when the session this tool runs inside
   * is bound to a chat platform (wechat / telegram / ...). Tools that
   * only make sense inside a channel session — e.g. `channel_send_file`,
   * which delivers media through the platform's native upload path —
   * gate their `available()` on this so webchat sessions don't see
   * them at all.
   *
   * Set by the host (chat handler + worker agent-loop) by reading
   * `sessions.channel_binding_id / channel_id / channel_chat_id` for
   * the active session row. Absent when the session is plain webchat
   * or there's no session at all.
   *
   * Adapters that consume `OutboundChannelMessage.attachments`
   * receive the actual binding through channelHub; this field is
   * purely a hint for tool visibility + system-prompt awareness.
   */
  channelSession?: {
    /** Stable id of the channel binding (one wechat scan / telegram
     *  bot). Useful when a tool wants to dispatch outbound messages
     *  via channelHub.send(bindingId, ...). */
    bindingId: string;
    /** Channel id string ("wechat", "telegram", ...). */
    channelId: string;
    /** Channel-native chat id (a wechat ilink user id, a telegram
     *  chat id, etc.). */
    chatId: string;
  };
  /**
   * Workboard task id when this tool call is driven by a worker
   * pool run. Lets per-task tools scope their resources to a
   * single task lifecycle — e.g. microsandbox routes `exec` calls
   * for a worker session into a dedicated per-task sandbox that
   * gets stopped when the task terminates.
   *
   * Absent for chat sessions and ad-hoc tool invocations.
   */
  taskId?: string;
  /**
   * Project slug this task belongs to. Workboard tasks carry one
   * via `tasks.project_slug` (the user's per-project file tree on
   * disk lives at `users/<userId>/projects/<projectSlug>/`); the
   * host populates this from the same row when it builds the
   * tool context for a worker run.
   *
   * Optional for backwards compatibility: chat sessions, ad-hoc
   * tool invocations, and older host versions all set it to
   * undefined and plugins that don't care can ignore it.
   * Plugins that DO care (e.g. the openshell `sync_down` tool
   * which stages results under the project tree) should treat
   * missing as "caller must pass it explicitly".
   */
  projectSlug?: string;
  /**
   * Workboard task title at run start. Carried alongside `taskId`
   * so tools that surface results on disk can name folders with
   * something a human will recognise. Treat as best-effort: it's
   * an untrusted user-supplied string. Plugins that route it into
   * a filesystem path MUST slugify before use (e.g. via the helper
   * used by openshell's SyncDownTool).
   *
   * Optional for backwards compatibility, same reasoning as
   * `projectSlug`.
   */
  taskTitle?: string;
  /**
   * Cancellation signal for the current run. The host wires this
   * from the agent loop's inner abort controller, so a watchdog
   * timeout, an external `task_abort`, or any other reason the
   * loop unwinds will fire this signal. Tools that do long-running
   * work (`exec`, MCP calls, network fetches) SHOULD listen and
   * bail early; tools that are inherently quick can ignore it.
   *
   * Optional for backwards compatibility — plugins built against
   * older SDK versions never see this field, and the host
   * tolerates that.
   */
  signal?: AbortSignal;
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

  // ─── optional egress control ───────────────────────────────
  /**
   * Grant the sandbox network egress to a specific host:port.
   *
   * Some sandbox runtimes (openshell) run a deny-by-default network
   * policy, so an in-sandbox process (e.g. a headless OpenCode
   * agent) can't reach a host-side service (the OpenCode model
   * proxy) until egress to it is explicitly allowed. Runners that
   * sandbox the network implement this; runners with open network
   * access may leave it undefined (the caller treats undefined as
   * "already reachable"). Idempotent.
   */
  allowEgress?(endpoint: {
    host: string;
    port: number;
    /** Wire protocol hint, default "http". */
    protocol?: "http" | "https" | "tcp";
    /**
     * Absolute paths of the sandbox binaries authorized to use this
     * egress. Some runtimes (openshell) gate egress by BOTH the
     * host:port AND the requesting binary; without at least one
     * authorized binary the endpoint is registered but every
     * request is denied. Runners that don't gate by binary ignore
     * this. Include the agent's launcher + its runtime (e.g. the
     * opencode binary and node).
     */
    binaries?: string[];
  }): Promise<void>;

  // ─── optional host<->sandbox file staging ───────────────────
  /**
   * Copy files FROM the sandbox back to the host tenant workspace.
   * Some runtimes (openshell) don't bind-mount the workspace, so a
   * file an in-sandbox agent produced only exists inside the
   * container; callers that need the host to see it (e.g. to serve
   * a download link, or to hand results to another worker) must
   * stage it down. Accepts either plain sandbox-relative paths
   * (staged to the same host-relative path) or explicit
   * {sandbox, host} pairs when the two layouts differ. Runners that
   * already share the workspace with the host may leave this
   * undefined; the caller treats undefined as "already on host".
   */
  syncDown?(
    paths: string[] | { sandbox: string; host: string }[],
    opts?: { destBaseDir?: string },
  ): Promise<{
    downloaded: string[];
    skipped: { relPath: string; reason: string }[];
  }>;

  /**
   * Stage host files INTO the sandbox (inverse of syncDown). Inputs
   * are host-relative paths (relative to the runner's workspaceDir);
   * each is uploaded to /sandbox/workspace/<same rel path>. Runtimes
   * that already share the workspace with the host may leave this
   * undefined; the caller treats undefined as "already on sandbox".
   */
  syncUp?(hostRelPaths: string[]): Promise<{
    uploaded: string[];
    skipped: { relPath: string; reason: string }[];
  }>;

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
  /** Tenant-scoped user id whose context the command should run in.
   *  Runners use it to populate `$USER`, `$LOGNAME`, `$HOME` and an
   *  optional `$MSB_USER_ID` so shell scripts inside the guest see a
   *  proper user context even though the guest process itself runs
   *  as root (microsandbox has no user namespacing in v0). When
   *  omitted, the command runs with empty `$USER` and `$HOME=/root`,
   *  matching the SDK's default. */
  userId?: string;
  /** Workboard task id when this exec belongs to a per-task run.
   *  Routers (e.g. microsandbox) dispatch the call into the task's
   *  dedicated sandbox; absent calls go to the long-lived runner. */
  taskId?: string;
  /** Chat / worker session id. Routers fall back to this when
   *  `taskId` is absent so chat sessions linked to a task via
   *  `TaskSandboxPool.bindSession` still land in the right
   *  per-task sandbox. */
  sessionId?: string;
  /** Optional cancellation signal. Runners SHOULD watch this and
   *  abort the in-flight exec (best-effort SIGKILL of the guest
   *  process) so callers can interrupt a runaway command without
   *  waiting for the timeout. The host wires this from the agent
   *  loop's inner abort controller, so a `task_abort` (or any
   *  other source that aborts the run) propagates straight down
   *  to the guest. */
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Wall time in ms. */
  durationMs: number;
  /** True iff the command was killed by timeout. */
  timedOut: boolean;
  /** True iff the command was killed by the caller's abort signal
   *  rather than running to completion or hitting the timeout.
   *  Optional for backwards compatibility. */
  aborted?: boolean;
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

/**
 * Per-task sandbox lifecycle manager. Registered by the
 * microsandbox plugin under the `sandbox.taskPool` capability;
 * workboard's worker pool calls into it at task pickup / end /
 * delete to drive the per-task microVM lifecycle.
 *
 * The actual `exec` routing happens transparently inside the
 * SandboxRunner registered under `sandbox.shell`: when a tool
 * call carries `ctx.taskId`, the runner forwards it to the pool
 * which dispatches into the right per-task sandbox.
 */
export interface TaskSandboxPool {
  /**
   * Block until a sandbox exists for `taskId` and is ready to
   * receive `exec` calls. Idempotent — a no-op when the sandbox
   * is already running. When the sandbox was previously stopped
   * (e.g. an earlier attempt terminated), this resumes it so the
   * filesystem state from the prior run is preserved.
   */
  acquireTask(taskId: string, sessionId?: string): Promise<void>;
  /**
   * Stop (but do not remove) the sandbox bound to `taskId`. The
   * disk image is preserved so a follow-up `acquireTask` resumes
   * the same environment. Safe to call when the sandbox is
   * already stopped or doesn't exist.
   *
   * Implementations SHOULD return promptly; do the actual stop
   * out-of-band so the worker pool isn't blocked on next pickup.
   */
  releaseTask(taskId: string): Promise<void> | void;
  /**
   * Stop AND remove the sandbox bound to `taskId`. Called when a
   * task is permanently deleted; reclaims disk. Safe to call when
   * no such sandbox exists.
   */
  destroyTask(taskId: string): Promise<void>;
  /**
   * Bind a chat / worker session id to a `taskId` so the runner
   * can route `exec` calls keyed by `ctx.sessionId` back to the
   * task sandbox. Called from the worker's `onSessionStart` hook.
   */
  bindSession(sessionId: string, taskId: string): void;
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
  /**
   * Probe the browser stack and report whether it answers a CDP
   * discovery request right now. The implementation does
   * `GET http://127.0.0.1:<cdpHostPort>/json/version` with a
   * short timeout and translates the outcome into a single
   * status object the agent can act on:
   *
   *   - ok=true: chromium answered, latencyMs is the round-trip,
   *     `browser`/`webSocketDebuggerUrl` echoed for diagnostics.
   *   - ok=false: cdpHostPort isn't set (sidecar has no chromium),
   *     or the probe timed out / 5xx'd / connection-reset. The
   *     `error` and `suggestion` strings are agent-readable so
   *     the tool result can pass them through verbatim.
   *
   * Cheap (~1-5ms when healthy). Safe to call from a tool result
   * post-hook on every browser_* call without serious cost.
   */
  health(): Promise<BrowserSidecarHealth>;
}

export interface BrowserSidecarHealth {
  ok: boolean;
  latencyMs: number;
  /** Browser version string from /json/version when the probe
   *  succeeded; absent on failure. */
  browser?: string;
  /** Failure reason when ok=false; absent on success. */
  error?: string;
  /** Agent-actionable next step when ok=false. Examples:
   *    "call browser_restart to re-spawn chromium + Playwright MCP"
   *    "the sandbox itself is unhealthy; ask the orchestrator to reset_sandbox"
   *  Absent on success. */
  suggestion?: string;
  /** Host CDP port at probe time. Useful for diagnostics when
   *  the port forward itself moved (e.g. after reset_sandbox). */
  cdpHostPort?: number;
}

/** A server-side plugin module exports `activate` (required) and
 *  optional `deactivate`. */
export interface PluginServerModule {
  activate(ctx: PluginContext): Promise<PluginServerExports> | PluginServerExports;
  deactivate?(): Promise<void> | void;
}

// ─── Channel adapters ─────────────────────────────────────────────────
//
// A `ChannelAdapter` translates between an external chat platform
// (Feishu, Telegram, WeChat, Discord, Slack, ...) and tianshu's
// internal message bus. Plugins implement adapters and surface them
// through `manifest.contributes.channels[]` + `exports.channels`.
//
// Lifecycle:
//   1. The host loads each binding row from `channel_bindings`
//      (tenant + channel + account credentials).
//   2. For each binding, the host calls the plugin's channel
//      factory with a `ChannelAdapterContext`. The factory
//      returns an adapter instance.
//   3. Host calls `adapter.start()` to open the underlying
//      transport.
//   4. Inbound platform messages flow through
//      `adapter.onMessage(handler)` → host hub → agent router.
//   5. Agent replies route back via `adapter.send(outbound)`.
//   6. On binding removal / plugin deactivation the host calls
//      `adapter.stop()`.
//
// Adapters MUST be idempotent on start/stop and MUST drop the
// bot's own echo messages (the router double-checks senderId, but
// each platform has its own loopback semantics the adapter knows
// best). They SHOULD NOT crash on transient transport errors;
// surface them via `onError` so the hub can mark the binding as
// degraded without taking down the whole channel system.

/** Identifier of a chat platform. "webchat" is reserved for the
 *  host's built-in WebSocket transport; other plugins pick
 *  lowercase identifiers like "feishu" / "telegram" / "wechat". */
export type ChannelId = string;

/** A normalised inbound message. Adapters convert their native
 *  event shapes into this. Everything downstream operates on it. */
export interface InboundChannelMessage {
  /** Channel that produced this message (e.g. "feishu"). */
  channelId: ChannelId;
  /** Per-channel chat handle. For Feishu this is `chat_id` (group)
   *  or the sender's `open_id` (DM). Treat as opaque outside the
   *  adapter. */
  chatId: string;
  /** True when the chat is 1:1 with the bot. */
  isDirect: boolean;
  /** Stable identifier for the human/bot that sent the message,
   *  in the channel's native ID space. */
  senderId: string;
  /** Display name if the adapter could resolve one. */
  senderName?: string;
  /** Plain-text content. Adapters strip mentions / markup. */
  text: string;
  /** Native message id, used for replies + dedup. */
  messageId: string;
  /** When the channel says it was sent (ms epoch). */
  timestamp: number;
  /** Whether the bot itself was @-mentioned (groups only). */
  mentionsBot?: boolean;
  /** Original payload, for adapters that need extra context. */
  raw?: unknown;
}

/** Outbound message handed to the adapter for delivery. The
 *  adapter decides format (plain text vs card vs whatever the
 *  platform supports natively). */
/** A local file the channel adapter should deliver alongside (or
 *  instead of) the text body. The path must already exist on the
 *  host filesystem; channels that can't natively render the
 *  file kind (image / video / generic file) MAY fall back to a
 *  text mention. The optional `kind` is a hint — adapters that
 *  sniff MIME from extension themselves can ignore it. */
export interface OutboundAttachment {
  /** Absolute path on the host filesystem. */
  filePath: string;
  /** Display name for FILE-type messages (defaults to basename). */
  fileName?: string;
  /** Optional hint: "image" / "video" / "file". Adapter MAY use
   *  it instead of extension sniffing. */
  kind?: "image" | "video" | "file";
}

export interface OutboundChannelMessage {
  /** Target chat handle in the channel's native ID space. */
  target: string;
  /** Plain-text body. Adapters MAY apply minimal markdown if the
   *  platform supports it. */
  text: string;
  /** Reply to a specific message id when the channel supports
   *  threading. */
  replyTo?: string;
  /** Local-file attachments. Adapters that don't support media
   *  delivery MAY ignore this and just send `text` — callers
   *  should not rely on attachments getting through without
   *  checking adapter capabilities. */
  attachments?: OutboundAttachment[];
}

/** Semantic reactions the host emits to signal processing state
 *  to a remote chat ("received", "working", "done", "error").
 *  Each adapter maps these onto the platform's native reaction
 *  set; adapters that don't support reactions silently no-op. */
export type ChannelReactionKind = "received" | "working" | "done" | "error";

/** Context handed to a channel factory at binding instantiation. */
export interface ChannelAdapterContext {
  /** Binding row id — a stable key for this account's adapter
   *  instance. */
  bindingId: string;
  /** Tenant the binding belongs to. */
  tenantId: string;
  /** Per-binding configuration (account credentials, optional
   *  display name, etc.). Schema is plugin-defined and validated
   *  by the plugin before mapping to its internal config. */
  config: Record<string, unknown>;
  /** Plugin-scoped logger, same shape as the rest of the SDK. */
  log: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** State directory the adapter can persist tokens / sync
   *  buffers / etc. Created by the host before the factory runs. */
  stateDir: string;
}

/** Factory the plugin exports per channel module. The host calls
 *  it once per binding. The factory MAY do async work (loading
 *  cached tokens etc.); the host awaits it before `start()`. */
export type ChannelAdapterFactory = (
  ctx: ChannelAdapterContext,
) => Promise<ChannelAdapter> | ChannelAdapter;

/** The runtime interface every channel adapter implements. */
export interface ChannelAdapter {
  /** Channel identifier; must match `InboundChannelMessage.channelId`. */
  readonly id: ChannelId;
  /** Human-readable name for logs / UI. */
  readonly displayName: string;
  /** Establish whatever connection the channel needs.
   *  Idempotent. Resolves when messages can flow. */
  start(): Promise<void>;
  /** Tear down gracefully. Idempotent. */
  stop(): Promise<void>;
  /** Send a message to the channel. */
  send(message: OutboundChannelMessage): Promise<void>;
  /** Add a reaction to a remote message. Returns an opaque id
   *  the host can pass back to remove the reaction later, or
   *  `null` if the platform doesn't expose one. Adapters that
   *  don't support reactions return `null` and no-op. */
  addReaction?(
    messageId: string,
    kind: ChannelReactionKind,
  ): Promise<string | null>;
  /** Remove a reaction previously added via `addReaction`. */
  removeReaction?(messageId: string, reactionId: string): Promise<void>;
  /** Resolve a human-readable display name for a chat handle.
   *  Used by the host to label channel sessions in the sidebar
   *  so users see "张三" / "产品群" instead of opaque ids. */
  resolveDisplayName?(
    handle: string,
    kind: "user" | "chat",
  ): Promise<string | null>;
  /** Register the inbound-message listener. The hub calls this
   *  exactly once at startup; adapters MAY reject duplicates. */
  onMessage(handler: (msg: InboundChannelMessage) => void): void;
  /** Register an error listener. Hub logs into the binding row
   *  so admins can see auth failures / reconnect storms / etc.
   *  Adapters MUST NOT throw from these handlers — errors that
   *  reach the hub are best-effort signals, not transactions. */
  onError(handler: (err: Error) => void): void;
}
