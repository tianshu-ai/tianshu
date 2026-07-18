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
   * Embedding model for semantic search (currently: the LLM Wiki
   * plugin builds a per-user vector index and searches it). When
   * unset, features that would use it fall back to keyword search.
   * OpenAI-compatible `/v1/embeddings` endpoint (works with cloud
   * providers and local servers like llama.cpp / Ollama / LM Studio).
   */
  embedding?: EmbeddingConfig;
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
  /**
   * User authentication. GLOBAL-ONLY — a tenant must not disable the
   * auth wall or add itself as admin. Absent / `enabled:false` keeps
   * the current dev behaviour (no login wall). See AuthConfig.
   */
  auth?: AuthConfig;
  /**
   * Disabled tenants. GLOBAL-ONLY, super-admin-managed. A tenant id in
   * this list is treated as unavailable: logins can't enter it and
   * in-flight requests targeting it are rejected — but the on-disk data
   * is left untouched (this is a soft off-switch, NOT a delete). To
   * really remove a tenant, an admin deletes its directory by hand.
   * Managed via the admin Auth page or by hand-editing this array.
   */
  disabledTenants?: string[];
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

export interface EmbeddingConfig {
  /** OpenAI-compatible base URL, e.g. "https://api.openai.com/v1" or
   *  a local "http://127.0.0.1:8080/v1". The plugin POSTs
   *  `<baseUrl>/embeddings`. */
  baseUrl?: string;
  /** Model id, e.g. "text-embedding-3-small" or a local model name. */
  model?: string;
  /** API key; supports `${VAR}` placeholders resolved at request time. */
  apiKey?: string;
  /** Optional expected dimensions (some providers accept a
   *  `dimensions` param; also used to sanity-check returned vectors). */
  dimensions?: number;
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

/**
 * A single OAuth2 / OIDC login provider. GENERIC + config-driven — the
 * runtime hardcodes NO provider (no github/google/lark enum). Every
 * provider goes through the same authorization-code + PKCE flow. The
 * operator declares whatever they use by endpoint or OIDC issuer.
 *
 * Declare a provider one of two ways:
 *   (a) OIDC discovery — set `issuer`; we fetch
 *       `<issuer>/.well-known/openid-configuration` for the
 *       authorize/token/userinfo endpoints.
 *   (b) explicit endpoints — set authorizeUrl/tokenUrl/userInfoUrl
 *       directly (for plain OAuth2 without discovery, e.g. GitHub).
 */
export interface OAuthProviderConfig {
  /** Stable id, used in the callback URL `/api/auth/<id>/callback`.
   *  Lowercase letters, digits, dashes. */
  id: string;
  /** Button label on the login page. Defaults to `id`. */
  displayName?: string;
  clientId: string;
  /** May contain `${VAR}` placeholders (resolved at use time). */
  clientSecret: string;
  /** OAuth scopes. Defaults to `["openid","email","profile"]`. */
  scopes?: string[];

  // ── endpoint source: issuer (a) OR explicit URLs (b) ──
  /** OIDC issuer for discovery. Mutually exclusive with the explicit
   *  *Url fields; if both are set, explicit URLs win. */
  issuer?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;

  /** Map the provider's userinfo JSON → tianshu identity. Dot paths
   *  into the userinfo response. Defaults suit OIDC
   *  (`sub`/`email`/`name`); override for providers that differ
   *  (GitHub nests email, Lark uses open_id/en_name, …). */
  claims?: {
    subject?: string;
    email?: string;
    name?: string;
  };
}

/**
 * User-authentication config. GLOBAL-ONLY (never in TENANT_WHITELIST):
 * a tenant must not be able to disable the auth wall or add itself as
 * admin. Default `enabled:false` ⇒ zero behaviour change (dev chain).
 */
export interface AuthConfig {
  /** Master switch. false (default) keeps the dev resolver chain
   *  (cookie → env → default-dev, no login wall). true arms the
   *  session resolver and 401s unauthenticated /api requests. */
  enabled?: boolean;
  /** Session cookie signing secret. `${VAR}` placeholder resolved at
   *  use time. REQUIRED when enabled=true. */
  sessionSecret?: string;
  /** Super-admins declared by OAuth email. A login whose email is in
   *  this list is a GLOBAL admin — all permissions across ALL tenants,
   *  overriding any per-tenant role in auth.db. Config-file-declared
   *  (not editable in the DB). */
  admins?: string[];
  /** Super-admin LOCAL accounts (username + password). These are the
   *  bootstrap / global admins: the first user(s), password configured
   *  here. On boot they're hashed into auth.db (idempotent). Like
   *  `admins`, they hold all permissions across all tenants. `password`
   *  supports `${VAR}` placeholders so the plaintext need not live in
   *  the file. */
  superAdmins?: Array<{ username: string; password: string; email?: string }>;
  /** Configured OAuth/OIDC login providers. */
  providers?: OAuthProviderConfig[];
  /** Whether local password users may self-register. Default false —
   *  only super-admins + admin-created users exist. When true, the
   *  login page exposes a register form; the first-ever registrant is
   *  irrelevant here since the bootstrap admin comes from superAdmins. */
  allowRegistration?: boolean;
  /** Session lifetime in seconds. Default 7 days. */
  sessionTtlSec?: number;
}

// NOTE: there is deliberately NO global "tenant strategy". In the tianshu
// model a tenant is one agent+workers (an instance); a user is a session
// inside it. Which tenant(s) a login can enter is decided by MEMBERSHIP
// (auth.db tenant_roles), not a process-wide rule — see tenantsForUser().

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

// ─── mtime-invalidated read cache ─────────────────────────────────────
//
// Config is read on the HOT PATH: buildTenantContext → resolveTenantConfig
// runs `loadGlobalConfig` + `loadTenantConfig` on EVERY request, and the
// auth resolver chain reads global config per request too. Doing a
// readFileSync + JSON.parse each time is a blocking syscall + parse on
// the request path.
//
// We cache the parsed object keyed by path, invalidated by the file's
// (mtimeMs, size). Each call still does ONE `statSync` — but stat on a
// hot file hits the OS inode cache and is ~an order of magnitude cheaper
// than read+parse. When mtime/size are unchanged we return the cached
// parse (deep-cloned so callers can't mutate the shared object).
//
// Crucially this PRESERVES the "hand-edit config.json → takes effect on
// the next request, no restart" property: an external edit bumps mtime,
// so the very next stat sees the change and re-reads. writeGlobalConfig /
// writeTenantConfig additionally punch the cache entry to avoid a
// same-millisecond-mtime race after our own writes.
interface CacheEntry {
  mtimeMs: number;
  size: number;
  parsed: Record<string, unknown>;
}
const configCache = new Map<string, CacheEntry>();

/** Drop a cached entry (called after our own writes). */
function invalidateConfigCache(filepath: string): void {
  configCache.delete(filepath);
}

/** Test/ops hook: clear the whole cache. */
export function clearConfigCache(): void {
  configCache.clear();
}

function deepClone<T>(v: T): T {
  // structuredClone is available on Node 17+; config objects are plain
  // JSON so it's exact. Cloning stops a caller from mutating the cached
  // parse and poisoning every subsequent reader.
  return structuredClone(v);
}

function readJsonOrEmpty(filepath: string): Record<string, unknown> {
  let st: fs.Stats;
  try {
    st = fs.statSync(filepath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      configCache.delete(filepath);
      return {};
    }
    throw new Error(
      `failed to stat config ${filepath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const hit = configCache.get(filepath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return deepClone(hit.parsed);
  }

  try {
    const buf = fs.readFileSync(filepath, "utf8");
    const parsed = JSON.parse(buf);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`expected JSON object, got ${typeof parsed}`);
    }
    configCache.set(filepath, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      parsed: parsed as Record<string, unknown>,
    });
    return deepClone(parsed as Record<string, unknown>);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Raced with a delete between stat and read.
      configCache.delete(filepath);
      return {};
    }
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
    auth: global.auth,
    disabledTenants: global.disabledTenants,

    // overridable — tenant wins
    defaultModel,
    models,
    worker: { ...global.worker, ...tenant.worker },
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
  // Punch the cache: a write within the same millisecond as the last
  // read would otherwise keep serving the stale parse (mtimeMs unchanged).
  invalidateConfigCache(target);
}

export function writeGlobalConfig(cfg: GlobalConfig, home: string = getTianshuHome()): void {
  const target = getGlobalConfigPath(home);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, target);
  invalidateConfigCache(target);
}

/**
 * `${VAR}` and `${VAR:-fallback}` → process.env[VAR] | fallback | "".
 * Shared placeholder resolver for config secrets (auth session secret,
 * OAuth client secrets). Mirrors the apiKey resolution in llm.ts so
 * every secret in config.json expands the same way. Returns undefined
 * for undefined input; never throws.
 */
export function expandEnvPlaceholders(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_m, name, fallback) => {
    return process.env[name] ?? fallback ?? "";
  });
}

/** Is a tenant currently disabled (soft off-switch in global config)? */
export function isTenantDisabled(
  tenantId: string,
  home: string = getTianshuHome(),
): boolean {
  const list = loadGlobalConfig(home).disabledTenants ?? [];
  return list.includes(tenantId);
}
