// OpenCode model proxy — transparent passthrough (scheme "A").
//
// Purpose: let an external agent process (OpenCode, running headless
// in a task sandbox) drive ANY model from tianshu's own model list,
// WITHOUT ever handing the sandbox a real provider key, baseUrl, or
// provider parameters. The sandbox only ever sees:
//   - this proxy's address, and
//   - a short-lived, single-model, single-tenant opaque token.
// The real LLM connection info (key + baseUrl) never leaves the host
// process into config files or the sandbox.
//
// This is a passthrough proxy: it does NOT translate protocols.
// OpenCode speaks whatever wire protocol the chosen model already
// uses (anthropic-messages / openai-completions / google-
// generative-ai) — the same protocols tianshu's own upstream
// serves. The proxy only:
//   1. authenticates by opaque token,
//   2. resolves the token → (tenant, allowed model),
//   3. rewrites the target URL to the model's real baseUrl,
//   4. injects the model's real auth header (resolved in-process),
//   5. OVERWRITES the request body's `model` field with the grant's
//      native model id — so a tampered sandbox cannot use the token
//      to reach a different (more expensive / disallowed) model,
//   6. streams the response straight back.
//
// Multi-tenant: every token is bound to exactly one tenantId and one
// model id. A sandbox holding token T can only reach that one model,
// in that one tenant. Tokens carry a TTL and are revoked explicitly
// on task end. Registry is in-memory only.

import { randomBytes } from "node:crypto";
import type { Request, Response, Express } from "express";
import {
  findModel,
  resolveApiKey,
  type ResolvedModelInfo,
} from "../core/llm.js";
import { resolveTenantConfig } from "../core/config.js";
import { getTianshuHome } from "../core/paths.js";

export interface ProxyGrant {
  token: string;
  tenantId: string;
  /** Full model id, e.g. "anthropic/claude-opus-4-7". */
  modelId: string;
  /** ms epoch after which the grant is dead. */
  expiresAt: number;
}

export interface OpenCodeProxyOptions {
  /** Grant lifetime. Default 6h. */
  ttlMs?: number;
  /** Mount prefix. Default "/opencode-proxy". */
  prefix?: string;
  /**
   * Base origin a SANDBOX uses to reach this proxy, e.g.
   * "http://host.openshell.internal:8779" (openshell) or the
   * microsandbox host-gateway address. Combined with the mount
   * prefix + token to form each grant's `baseUrl`. Defaults to
   * `http://127.0.0.1:<serverPort>` style only when the sandbox
   * shares the host loopback (rare); phase-2 sets this per
   * sandbox runtime. */
  sandboxReachableOrigin?: string;
}

/** Capability-shaped grant (what `host.opencodeProxy` hands out).
 *  Same token, plus the sandbox-reachable baseUrl. */
export interface OpenCodeProxyGrantView {
  token: string;
  modelId: string;
  /** Wire protocol the model speaks (protocol shape, not secret). */
  api: string;
  baseUrl: string;
  expiresAt: number;
}

// Upstream endpoint suffixes the sandbox is allowed to hit through
// the proxy. Anything else is rejected so the token can't be used
// as a general open proxy. Matched against the request tail with an
// OPTIONAL leading `v1/` (or `v1beta/`) — the model's baseUrl may or
// may not already include the version segment (e.g. openai baseUrl
// is `.../v1`, so the AI SDK sends the tail as `chat/completions`;
// anthropic baseUrl has no version, so the tail is `v1/messages`).
const ALLOWED_ENDPOINT_SUFFIXES = [
  "messages", // anthropic-messages
  "chat/completions", // openai-completions
  "completions", // openai (legacy)
  "models", // model-list probes
  "generateContent", // google (path carries model:generateContent)
  "streamGenerateContent", // google streaming
];

/** How the proxy injects auth for each wire protocol. */
function authHeadersFor(api: string, apiKey: string): Record<string, string> {
  switch (api) {
    case "anthropic-messages":
      return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    case "google-generative-ai":
      return { "x-goog-api-key": apiKey };
    case "openai-completions":
    case "openai-responses":
    default:
      return { authorization: `Bearer ${apiKey}` };
  }
}

function pathAllowed(tail: string): boolean {
  // Normalise: drop leading slashes, a leading version segment, and
  // any query string, then check the remaining endpoint against the
  // allowlist. For google the model id is embedded in the path
  // (`v1beta/models/<m>:generateContent`) so we match on the method
  // suffix after the last `:` / `/`.
  let p = tail.replace(/^\/+/, "");
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q);
  p = p.replace(/^v1beta\//, "").replace(/^v1\//, "");
  return ALLOWED_ENDPOINT_SUFFIXES.some((suf) => {
    if (p === suf || p.endsWith(`/${suf}`)) return true;
    // google: `.../models/<model>:generateContent`
    if (p.endsWith(`:${suf}`)) return true;
    // exact list endpoints like `models`
    if (p === suf) return true;
    return false;
  });
}

/** The version prefix each protocol's endpoints live under. */
function versionForApi(api: string): string {
  switch (api) {
    case "anthropic-messages":
    case "openai-completions":
    case "openai-responses":
      return "v1";
    case "google-generative-ai":
      return "v1beta";
    default:
      return "v1";
  }
}

/** Normalise the upstream request path.
 *
 *  AI SDK providers are inconsistent about where the API version
 *  lives: some assume the baseURL is already at `/v1` and send a
 *  bare endpoint (`messages`), others carry it in the path. Meanwhile
 *  tianshu's per-provider baseUrl may or may not already include the
 *  version (anthropic `localhost:3031` has none; openai
 *  `localhost:3031/v1` has it).
 *
 *  Rule: strip any leading version segment the client sent, then
 *  prepend the protocol's version ONLY IF the baseUrl doesn't already
 *  end with it. Result: exactly one version segment, always correct.
 */
export function resolveUpstreamPath(
  api: string,
  base: string,
  tail: string,
): string {
  const version = versionForApi(api);
  // Strip a leading version the client may have prepended.
  let p = tail.replace(/^\/+/, "");
  p = p.replace(/^v1beta\//, "").replace(/^v1\//, "");
  // Does the baseUrl already terminate in this version segment?
  const baseHasVersion = new RegExp(`/${version}$`).test(
    base.replace(/\/+$/, ""),
  );
  return baseHasVersion ? p : `${version}/${p}`;
}

export class OpenCodeProxy {
  private grants = new Map<string, ProxyGrant>();
  private readonly ttlMs: number;
  private readonly prefix: string;

  private readonly sandboxReachableOrigin?: string;

  constructor(opts: OpenCodeProxyOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 6 * 60 * 60 * 1000;
    this.prefix = opts.prefix ?? "/opencode-proxy";
    this.sandboxReachableOrigin = opts.sandboxReachableOrigin;
  }

  /** The base URL a sandbox appends the protocol tail to, for a
   *  given token. Requires `sandboxReachableOrigin` to be set. */
  baseUrlFor(token: string, origin = this.sandboxReachableOrigin): string {
    if (!origin) {
      throw new Error(
        "OpenCodeProxy: sandboxReachableOrigin not configured; " +
          "cannot build a sandbox-reachable baseUrl",
      );
    }
    return `${origin.replace(/\/+$/, "")}${this.prefix}/${token}`;
  }

  /** Mint a grant in the capability shape (token + reachable
   *  baseUrl). `origin` overrides the default reachable origin
   *  (phase-2 passes the per-runtime sandbox origin here). */
  grantView(
    tenantId: string,
    modelId: string,
    origin?: string,
  ): OpenCodeProxyGrantView {
    const g = this.grant(tenantId, modelId);
    // Resolve the model's wire protocol so the caller can pick the
    // matching OpenCode provider npm. Non-fatal if it can't resolve
    // (bad model id surfaces later at request time); default to the
    // openai-compatible shape.
    let api = "openai-completions";
    try {
      api = this.resolveModel(g).info.api;
    } catch {
      /* leave default */
    }
    return {
      token: g.token,
      modelId: g.modelId,
      api,
      baseUrl: this.baseUrlFor(g.token, origin),
      expiresAt: g.expiresAt,
    };
  }

  /** Register a grant for one (tenant, model). Returns the token to
   *  hand to the sandbox as its proxy credential. One token = one
   *  model; to use a different model, grant a new token. */
  grant(tenantId: string, modelId: string): ProxyGrant {
    const token = randomBytes(24).toString("base64url");
    const g: ProxyGrant = {
      token,
      tenantId,
      modelId,
      expiresAt: Date.now() + this.ttlMs,
    };
    this.grants.set(token, g);
    return g;
  }

  revoke(token: string): void {
    this.grants.delete(token);
  }

  /** Test/introspection helper: current live grant count. */
  size(): number {
    // Opportunistically drop expired entries.
    const now = Date.now();
    for (const [t, g] of this.grants) {
      if (now > g.expiresAt) this.grants.delete(t);
    }
    return this.grants.size;
  }

  private lookup(token: string): ProxyGrant | null {
    const g = this.grants.get(token);
    if (!g) return null;
    if (Date.now() > g.expiresAt) {
      this.grants.delete(token);
      return null;
    }
    return g;
  }

  /** Resolve a grant to concrete model connection info + real key,
   *  entirely in-process. Throws on any miss. */
  private resolveModel(g: ProxyGrant): {
    info: ResolvedModelInfo;
    apiKey: string;
  } {
    const config = resolveTenantConfig(g.tenantId, getTianshuHome());
    const info = findModel(config, g.modelId);
    if (!info) {
      throw new Error(
        `model "${g.modelId}" not found for tenant "${g.tenantId}"`,
      );
    }
    const apiKey = resolveApiKey(info);
    return { info, apiKey };
  }

  /** Express handler. Mounted at `<prefix>/:token/*splat`. */
  handler = async (req: Request, res: Response): Promise<void> => {
    // Only chat-style methods.
    if (req.method !== "POST" && req.method !== "GET") {
      res.status(405).json({ error: "method not allowed" });
      return;
    }

    const rawToken = (req.params as Record<string, unknown>).token;
    const token = typeof rawToken === "string" ? rawToken : "";
    const g = token ? this.lookup(token) : null;
    // DIAG (2026-07-07): trace where an opencode Unauthorized comes
    // from — proxy-level (token invalid/expired) vs upstream 401.
    console.log(
      `[opencode-proxy] recv ${req.method} tail=${String(
        (req.params as Record<string, unknown>).splat ?? "",
      )} tokenPrefix=${token.slice(0, 6)} lookup=${
        g ? `ok(model=${g.modelId})` : "MISS"
      }`,
    );
    if (!g) {
      res.status(401).json({ error: "invalid or expired proxy token" });
      return;
    }

    // Express 5 names the wildcard `splat` (string or string[]).
    const rawSplat = (req.params as Record<string, unknown>).splat;
    const tail = (
      Array.isArray(rawSplat)
        ? rawSplat.join("/")
        : typeof rawSplat === "string"
          ? rawSplat
          : ""
    ).replace(/^\/+/, "");

    if (!pathAllowed(tail)) {
      res.status(403).json({ error: `path not allowed: /${tail}` });
      return;
    }

    let info: ResolvedModelInfo;
    let apiKey: string;
    try {
      ({ info, apiKey } = this.resolveModel(g));
    } catch (err) {
      res.status(502).json({
        error: "model resolution failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Build the upstream URL from the model's real baseUrl + tail,
    // normalising the version segment per protocol (see
    // resolveUpstreamPath). AI SDK providers disagree on whether the
    // version lives in the baseURL or the path: @ai-sdk/anthropic
    // sends `messages` (expects baseURL to already be at /v1), while
    // tianshu's anthropic baseUrl is bare (`localhost:3031`), so we
    // must re-insert /v1. openai's baseUrl already carries /v1.
    const base = info.baseUrl.replace(/\/+$/, "");
    const qIdx = req.originalUrl.indexOf("?");
    const qs = qIdx >= 0 ? req.originalUrl.slice(qIdx) : "";
    const upstreamPath = resolveUpstreamPath(info.api, base, tail);
    const upstreamUrl = `${base}/${upstreamPath}${qs}`;

    // Copy inbound headers, strip hop-by-hop + any auth the sandbox
    // tried to set, then inject the real auth for this protocol.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v !== "string") continue;
      const lk = k.toLowerCase();
      if (
        lk === "host" ||
        lk === "authorization" ||
        lk === "x-api-key" ||
        lk === "x-goog-api-key" ||
        lk === "content-length" ||
        lk === "connection" ||
        lk === "accept-encoding" // let fetch negotiate; avoids double-gzip
      ) {
        continue;
      }
      headers[k] = v;
    }
    Object.assign(headers, authHeadersFor(info.api, apiKey));

    // Body: express already parsed JSON. OVERWRITE `model` with the
    // grant's native model id so a tampered sandbox can't reach a
    // different model with this token. Then re-serialize.
    const hasBody = req.method === "POST";
    let body: string | undefined;
    if (hasBody) {
      const parsed =
        req.body && typeof req.body === "object"
          ? (req.body as Record<string, unknown>)
          : {};
      if ("model" in parsed || info.api !== "google-generative-ai") {
        // Google puts the model in the URL path, not the body; only
        // force the body field for the protocols that carry it.
        if (info.api !== "google-generative-ai") {
          parsed.model = info.modelId;
        }
      }
      body = JSON.stringify(parsed);
      headers["content-type"] = "application/json";
    }

    console.log(
      `[opencode-proxy] forward model=${info.modelId} api=${info.api} ` +
        `-> ${upstreamUrl} apiKeyPrefix=${apiKey.slice(0, 6)}`,
    );
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body,
      });
    } catch (err) {
      res.status(502).json({
        error: "upstream fetch failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Mirror status + relevant headers; stream body straight back.
    if (upstream.status >= 400) {
      console.log(
        `[opencode-proxy] upstream ${upstream.status} model=${info.modelId} ` +
          `url=${upstreamUrl}`,
      );
    }
    res.status(upstream.status);
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);
    const cc = upstream.headers.get("cache-control");
    if (cc) res.setHeader("cache-control", cc);

    if (!upstream.body) {
      res.end();
      return;
    }
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) res.write(Buffer.from(value));
      }
    } catch {
      // Client hung up or upstream broke mid-stream; just end.
    } finally {
      res.end();
    }
  };

  /** Mount at the configured prefix. Kept OUTSIDE tenant middleware
   *  — the token is the auth, not a tenant cookie. */
  mount(app: Express): void {
    app.all(`${this.prefix}/:token/*splat`, (req, res) => {
      void this.handler(req, res);
    });
  }
}
