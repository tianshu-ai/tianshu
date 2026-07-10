// Two-layer configuration: ~/.tianshu/config.json (global)
// + ~/.tianshu/tenants/<id>/config.json (tenant override).
//
// Tenant config can only override fields on a whitelist (ADR-0001 §7).
// Server-process knobs (port, log path) are global-only — a tenant must
// not be able to flip the listener port.
//
// We DO NOT use a heavy schema library for v0; a hand-written validator
// keeps the dependency footprint small and the behaviour obvious. As the
// config grows, swap to typebox.

import fs from "node:fs";
import path from "node:path";
import {
  getGlobalConfigPath,
  getTenantConfigPath,
  getTianshuHome,
} from "./paths.js";

// ─── Types ────────────────────────────────────────────────────────────

/** Plugin enable/disable map (per ADR-0003 §4). Keys are plugin ids. */
export type PluginsConfig = Record<
  string,
  {
    enabled?: boolean;
    /** Opaque per-plugin config; the host doesn't interpret it. */
    config?: Record<string, unknown>;
  }
>;

/** Fields that BOTH global and tenant configs can set. Tenant wins on conflict. */
export interface OverridableConfig {
  defaultModel?: string;
  /** Per-plugin enable/disable. Listed-but-disabled and not-listed are
   *  distinct: not listed = invisible everywhere. See ADR-0003 §4. */
  plugins?: PluginsConfig;
  /**
   * Provider catalog. Mirrors the closed-source `tianshu.models.json`
   * format so existing config files transplant cleanly. The shape is
   * `{ providers: { <providerId>: ProviderEntry } }`.
   *
   * `apiKey` strings support `${VAR}` and `${VAR:-fallback}` placeholders
   * that we resolve at request time (not at config-load time, so secrets
   * never sit in memory longer than necessary).
   */
  models?: ModelsCatalog;
  /**
   * @deprecated 2026-06-21 — never wired up in the open-source
   *   repo. The three sub-keys (count / pollMs / model) had no
   *   runtime consumers: workboard sizes its pool from the
   *   agent-seeds bundle (one worker per enabled agent.json),
   *   there is no polling (task ready queue is SQLite-driven),
   *   and model selection is per-worker via agent.json's
   *   `modelId` (falling back to the resolved tenant
   *   defaultModel). Field kept in the type for backwards
   *   compat (so config files that already set it don't fail to
   *   parse), but doctor flags it as ignored and cli-agent
   *   refuses to write it. If/when an actual cross-cutting
   *   worker config is needed, wire the consumers first and
   *   then resurrect with a real shape.
   */
  worker?: WorkerSettings;
  oauth?: OAuthProviderConfig[];
  branding?: BrandingConfig;
  apiKeys?: Record<string, string>; // provider name → key
  /**
   * User-managed MCP servers (additional to whatever active plugins
   * contribute). Each entry becomes a `McpToolset` instance owned
   * by the host's `McpManager`, so reflected tools land in the
   * agent's tool list alongside plugin-contributed toolsets.
   *
   * Stored on the tenant config so per-tenant servers don't leak
   * across tenants and so `tianshu/.config.json` survives a server
   * restart. The host writes this surface through the `/api/mcp`
   * routes; users can also hand-edit — we re-read on every config
   * cycle.
   */
  mcp?: McpUserConfig;
}

export interface McpUserConfig {
  servers?: McpServerEntry[];
}

export interface McpServerEntry {
  /** Local id used in URLs + logs. Lowercase letters, digits, dashes. */
  id: string;
  /** Display name in the admin UI. Defaults to `id`. */
  displayName?: string;
  /** Tool name prefix. Defaults to `<id>_`. Pass `""` to disable. */
  prefix?: string;
  /** Streamable HTTP MCP endpoint URL (must include `/mcp` path). */
  url: string;
  /** Optional Host header override (when fronting an upstream that
   *  validates Host — e.g. Playwright MCP behind a port forward). */
  upstreamHost?: string;
  /** Whether the server is currently active. Stored on the entry
   *  rather than as a separate map so `mcp.servers[]` is a single
   *  source of truth. Default true. */
  enabled?: boolean;
}

/** Fields that ONLY the global config controls. Tenant config attempting these is rejected. */
export interface GlobalOnlyConfig {
  /**
   * `publicUrl` is the operator-declared URL users open in a
   * browser — e.g. a Cloudflare tunnel hostname. Write this
   * by hand (or via wizard) when you want a stable public
   * URL; nothing inside the server overrides it.
   *
   * `effectivePublicUrl` is auto-written by the running
   * server on each boot to record "this is the localhost
   * URL I'm actually serving the SPA from" (server port in
   * prod / TIANSHU_WEB_DIST mode, web port in dev / vite
   * mode). CLI commands like `tianshu tenant list` read it
   * when the operator hasn't set publicUrl, so they print a
   * URL that actually opens regardless of which install
   * shape is active.
   *
   * Order of preference for "what URL do I print to a human?"
   *   TIANSHU_WEB_URL env  >  server.publicUrl  >
   *   server.effectivePublicUrl  >  hard fallback to localhost:port.
   */
  server?: {
    port?: number;
    corsOrigin?: string;
    publicUrl?: string;
    effectivePublicUrl?: string;
  };
  /**
   * OpenCode worker model proxy. Lets a sandboxed OpenCode agent
   * reach a tianshu model without seeing the real key/baseUrl.
   *
   * `sandboxReachableOrigin` is the origin a SANDBOX uses to reach
   * this server's proxy route — NOT the host's own localhost. For
   * Docker-based sandboxes (openshell) this is typically
   * `http://host.docker.internal:<serverPort>`. For microsandbox
   * it's the host-group gateway address. When unset, the proxy
   * defaults to `http://host.docker.internal:<server.port>` (the
   * common Docker-desktop case); override here for other setups.
   */
  opencodeProxy?: {
    sandboxReachableOrigin?: string;
    /** Grant TTL in ms. Default 6h. */
    ttlMs?: number;
  };
  logging?: {
    level?: "debug" | "info" | "warn" | "error";
    /**
     * When true, every assembled system prompt (main chat agent +
     * worker agents) is dumped to
     * `<tenantHomeDir>/logs/system-prompt-<role>-<userId>.txt`,
     * overwriting on each run. Off by default; debug-only switch
     * for inspecting plugin fragment / SOUL / skill stitching
     * without booting tracing infrastructure.
     *
     * Global-only because it writes to disk and the tenant
     * shouldn't be able to silently turn host-side logging on.
     */
    dumpSystemPrompt?: boolean;
  };
  /** Auto-create a `default` tenant if no tenants exist on first boot. */
  autoCreateDefault?: boolean;
  /** Override builtinConfig directory (handy for tests / Docker). */
  builtinConfigDir?: string;
}

export interface ModelsCatalog {
  providers: Record<string, ProviderEntry>;
  /** Optional explicit default model id. Mirrors the closed-source
   *  tianshu.models.json field; the Settings Models page reads/writes
   *  it. */
  defaultModelId?: string;
  /** Cross-provider retry policy for transient LLM call failures
   *  (network, 429 rate-limit, 5xx, expired JWT/401). Applied at the
   *  single stream chokepoint in core/pi-models.ts, so it covers the
   *  chat handler, worker agent-loop, and compact() uniformly. */
  resilience?: ModelResilienceConfig;
}

export interface ModelResilienceConfig {
  /** Master switch. Default: true. */
  enabled?: boolean;
  /** Max attempts including the first try. Default: 4 (=> 3 retries). */
  maxAttempts?: number;
  /** Base backoff in ms for the exponential schedule. Default: 500. */
  baseDelayMs?: number;
  /** Ceiling for a single backoff wait in ms. Default: 20000. */
  maxDelayMs?: number;
  /** Jitter fraction [0..1] applied to each backoff. Default: 0.25. */
  jitter?: number;
  /** Honour a server-provided Retry-After header/hint when present.
   *  Default: true. Capped by maxRetryAfterMs. */
  respectRetryAfter?: boolean;
  /** Upper bound on an honoured Retry-After wait in ms. Default: 60000. */
  maxRetryAfterMs?: number;
  /** Minimum backoff for a rate-limit (429) failure that carries NO
   *  explicit server wait time. Prevents the short exponential schedule
   *  from re-tripping the limit. Default: 5000. Capped by maxDelayMs. */
  rateLimitFloorMs?: number;
  /** Retry even after partial content has already streamed to the
   *  client (e.g. the connection dropped mid-response). On retry the
   *  whole call is re-run and the assistant message is rebuilt from
   *  scratch — the client is told to reset the in-progress bubble
   *  first (see the `stream_reset` WS event) so text isn't duplicated.
   *  Only applies to non-abort transient failures. Default: true. */
  retryAfterContent?: boolean;
}

export interface ProviderEntry {
  baseUrl?: string;
  api?: "anthropic-messages" | "openai-completions" | "google-generative-ai" | string;
  apiKey?: string;     // may contain ${VAR} placeholders
  group?: string;      // "Cloud" | "Local" | … (just a UI hint)
  models?: ModelEntry[];
}

export interface ModelEntry {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  supportsImages?: boolean;
  /** Per-image byte cap before we hand it to the provider. Defaults
   *  by provider when omitted (see resolveImageMaxBytes). Override
   *  for self-hosted gateways with custom limits. */
  imageMaxBytes?: number;
  mode?: "chat" | "image-gen" | string;
  /** Free-form provider-specific compat flags. */
  compat?: Record<string, unknown>;
}

export interface WorkerSettings {
  count?: number;
  pollMs?: number;
  model?: string;
}

export interface OAuthProviderConfig {
  id: string; // e.g. "github", "google"
  type: "github" | "google" | "oidc" | "lark";
  clientId?: string;
  clientSecret?: string; // typically lives in secrets/, not config.json
  issuer?: string; // for generic OIDC
  scopes?: string[];
}

export interface BrandingConfig {
  name?: string;
  emoji?: string;
}

export type GlobalConfig = OverridableConfig & GlobalOnlyConfig;
export type TenantConfig = OverridableConfig;

/** Result of merging global ⊕ tenant. */
export interface ResolvedConfig extends OverridableConfig, GlobalOnlyConfig {}

// ─── Defaults ─────────────────────────────────────────────────────────

export const DEFAULTS: Required<Pick<GlobalOnlyConfig, "autoCreateDefault">> &
  Pick<GlobalOnlyConfig, "server" | "logging"> = {
  autoCreateDefault: true,
  server: { port: 3110, corsOrigin: "http://localhost:5183" },
  logging: { level: "info" },
};

// ─── Whitelist enforcement ────────────────────────────────────────────

/** Field names a tenant config is allowed to set. Reject any others. */
const TENANT_WHITELIST = new Set<keyof OverridableConfig>([
  "defaultModel",
  "models",
  "worker",
  "oauth",
  "branding",
  "apiKeys",
  "plugins",
  "mcp",
]);

export class TenantConfigForbiddenFieldError extends Error {
  readonly code = "TENANT_CONFIG_FORBIDDEN_FIELD" as const;
  constructor(public readonly tenantId: string, public readonly field: string) {
    super(
      `tenant "${tenantId}" config.json sets "${field}", which is not in the override whitelist`,
    );
    this.name = "TenantConfigForbiddenFieldError";
  }
}

function assertOnlyOverridable(tenantId: string, raw: Record<string, unknown>): void {
  for (const key of Object.keys(raw)) {
    if (!TENANT_WHITELIST.has(key as keyof OverridableConfig)) {
      throw new TenantConfigForbiddenFieldError(tenantId, key);
    }
  }
}

// ─── Read / merge ─────────────────────────────────────────────────────

function readJsonOrEmpty(filepath: string): Record<string, unknown> {
  try {
    const buf = fs.readFileSync(filepath, "utf8");
    const parsed = JSON.parse(buf);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`expected JSON object, got ${typeof parsed}`);
    }
    return parsed as Record<string, unknown>;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(
      `failed to read config ${filepath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function loadGlobalConfig(home: string = getTianshuHome()): GlobalConfig {
  const raw = readJsonOrEmpty(getGlobalConfigPath(home));
  return raw as GlobalConfig;
}

export function loadTenantConfig(tenantId: string, home: string = getTianshuHome()): TenantConfig {
  const raw = readJsonOrEmpty(getTenantConfigPath(tenantId, home));
  assertOnlyOverridable(tenantId, raw);
  return raw as TenantConfig;
}

/** Compute the effective config for a tenant. */
export function resolveTenantConfig(tenantId: string, home: string = getTianshuHome()): ResolvedConfig {
  const global = loadGlobalConfig(home);
  const tenant = loadTenantConfig(tenantId, home);
  return mergeConfigs(global, tenant);
}

/**
 * Merge global and tenant configs. Tenant wins on overridable fields.
 *
 * - Scalars and arrays: tenant replaces global wholesale.
 * - Objects (worker, branding, apiKeys): shallow-merge so tenant can override
 *   single keys without restating the whole object.
 */
export function mergeConfigs(global: GlobalConfig, tenant: TenantConfig): ResolvedConfig {
  // models is wholesale-replace, not deep-merge: tenants typically
  // bring their own provider catalog (different SAP gateway, qwen
  // dashscope, etc.) and don't want to inherit global's anthropic /
  // openai entries that almost certainly use a different key. So
  // when tenant.models is set, it replaces global.models entirely.
  const models = tenant.models ?? global.models;

  // defaultModel needs to follow models. If the tenant supplies its
  // own catalog and DOESN'T set defaultModel, falling back to
  // global.defaultModel points at a provider that no longer exists
  // in the resolved catalog — every chat request then 500s with
  // "unknown provider". Mismatch caught 2026-06-21 on a tenant
  // that defined `qwen` only; defaultModel inherited as
  // 'anthropic/claude-sonnet-4-6' from global.
  //
  // Resolution rule:
  //   1. tenant.defaultModel wins outright if set
  //   2. else, if tenant brought its own models, pick the first
  //      provider/model in that catalog (deterministic: tenant
  //      author has full control by ordering)
  //   3. else, inherit global.defaultModel (the original behaviour
  //      for tenants that don't override models)
  let defaultModel = tenant.defaultModel ?? global.defaultModel;
  if (!tenant.defaultModel && tenant.models && models?.providers) {
    const firstProviderId = Object.keys(models.providers)[0];
    const firstProvider = firstProviderId
      ? models.providers[firstProviderId]
      : undefined;
    const firstModelId = firstProvider?.models?.[0]?.id;
    if (firstProviderId && firstModelId) {
      defaultModel = `${firstProviderId}/${firstModelId}`;
    }
  }

  return {
    // global-only — never touched by tenant
    server: global.server,
    logging: global.logging,
    autoCreateDefault: global.autoCreateDefault ?? DEFAULTS.autoCreateDefault,
    builtinConfigDir: global.builtinConfigDir,

    // overridable — tenant wins
    defaultModel,
    models,
    worker: { ...global.worker, ...tenant.worker },
    oauth: tenant.oauth ?? global.oauth,
    branding: { ...global.branding, ...tenant.branding },
    apiKeys: { ...global.apiKeys, ...tenant.apiKeys },
    plugins: { ...global.plugins, ...tenant.plugins },
    mcp: tenant.mcp ?? global.mcp,
  };
}

/** Atomic write. Writes to a temp file first, then rename. */
export function writeTenantConfig(
  tenantId: string,
  cfg: TenantConfig,
  home: string = getTianshuHome(),
): void {
  // Validate before writing so callers can't sneak forbidden fields in.
  assertOnlyOverridable(tenantId, cfg as Record<string, unknown>);
  const target = getTenantConfigPath(tenantId, home);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function writeGlobalConfig(cfg: GlobalConfig, home: string = getTianshuHome()): void {
  const target = getGlobalConfigPath(home);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, target);
}
