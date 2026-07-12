// Auth routes.
//
// Two groups:
//   1. PUBLIC (mounted BEFORE the tenant wall) — you can't require login
//      to log in. `/api/auth/config`, `/api/auth/:id/start`,
//      `/api/auth/:id/callback`, `/api/auth/logout`.
//   2. ADMIN (mounted AFTER the wall) — `/api/admin/auth` GET/PATCH,
//      guarded by requireAdmin.
//
// Everything is dark unless `auth.enabled=true`. When disabled the
// public routes short-circuit with 404 so we don't advertise a login
// surface that does nothing.

import type { Express, Request, Response, NextFunction } from "express";
import {
  loadGlobalConfig,
  writeGlobalConfig,
  expandEnvPlaceholders,
  type AuthConfig,
  type OAuthProviderConfig,
} from "../core/config.js";
import {
  resolveEndpoints,
  newPkceState,
  buildAuthorizeUrl,
  exchangeCode,
  fetchIdentity,
} from "../core/auth/oauth.js";
import {
  mintSession,
  buildSessionCookie,
  buildClearCookie,
} from "../core/auth/session.js";
import {
  deriveUserId,
  deriveTenantId,
  roleForEmail,
} from "../core/auth/identity.js";

/** Short-lived cookie carrying PKCE state between /start and /callback. */
const PKCE_COOKIE = "tianshu_oauth_pkce";

interface RoutesAuthDeps {
  /** How the browser reaches this server (for redirect_uri). */
  publicUrl: () => string;
  /** Called after config mutation so the running server re-arms the
   *  resolver chain without a restart where possible. */
  onAuthConfigChanged?: () => void;
}

function currentAuth(): AuthConfig {
  return loadGlobalConfig().auth ?? {};
}

function isSecureUrl(u: string): boolean {
  return u.startsWith("https://");
}

/** Public provider view (no secrets). */
function publicProviders(cfg: AuthConfig): Array<{ id: string; displayName: string }> {
  return (cfg.providers ?? []).map((p) => ({
    id: p.id,
    displayName: p.displayName ?? p.id,
  }));
}

function findProvider(cfg: AuthConfig, id: string): OAuthProviderConfig | undefined {
  return (cfg.providers ?? []).find((p) => p.id === id);
}

function readPkceCookie(req: Request): { id: string; state: string; codeVerifier: string } | null {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0 || part.slice(0, eq).trim() !== PKCE_COOKIE) continue;
    try {
      return JSON.parse(decodeURIComponent(part.slice(eq + 1).trim()));
    } catch {
      return null;
    }
  }
  return null;
}

function buildPkceCookie(payload: object, secure: boolean): string {
  const v = encodeURIComponent(JSON.stringify(payload));
  const attrs = [`${PKCE_COOKIE}=${v}`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=600"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

function clearPkceCookie(secure: boolean): string {
  const attrs = [`${PKCE_COOKIE}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Mount the PUBLIC auth routes (before the tenant wall). */
export function mountPublicAuthRoutes(app: Express, deps: RoutesAuthDeps): void {
  // Public auth config — the login page reads this to render buttons.
  // Always available (even when disabled) so the SPA can decide whether
  // to show a login wall at all.
  app.get("/api/auth/config", (_req: Request, res: Response) => {
    const cfg = currentAuth();
    res.json({
      enabled: !!cfg.enabled,
      providers: cfg.enabled ? publicProviders(cfg) : [],
    });
  });

  // Begin login: 302 to the provider authorize URL.
  app.get("/api/auth/:id/start", async (req: Request, res: Response) => {
    const cfg = currentAuth();
    if (!cfg.enabled) {
      res.status(404).json({ error: "auth_disabled" });
      return;
    }
    const providerId = String(req.params.id ?? "");
    const provider = findProvider(cfg, providerId);
    if (!provider) {
      res.status(404).json({ error: "unknown_provider", id: providerId });
      return;
    }
    try {
      const endpoints = await resolveEndpoints(provider);
      const pkce = newPkceState();
      const redirectUri = `${deps.publicUrl().replace(/\/$/, "")}/api/auth/${provider.id}/callback`;
      const authorizeUrl = buildAuthorizeUrl(provider, endpoints, redirectUri, pkce);
      res.setHeader(
        "Set-Cookie",
        buildPkceCookie({ id: provider.id, ...pkce }, isSecureUrl(redirectUri)),
      );
      res.redirect(authorizeUrl);
    } catch (err) {
      res.status(502).json({
        error: "oauth_start_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // OAuth callback: exchange code → identity → mint session cookie.
  app.get("/api/auth/:id/callback", async (req: Request, res: Response) => {
    const cfg = currentAuth();
    if (!cfg.enabled) {
      res.status(404).json({ error: "auth_disabled" });
      return;
    }
    const providerId = String(req.params.id ?? "");
    const provider = findProvider(cfg, providerId);
    if (!provider) {
      res.status(404).json({ error: "unknown_provider", id: providerId });
      return;
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const pkce = readPkceCookie(req);
    const redirectUri = `${deps.publicUrl().replace(/\/$/, "")}/api/auth/${provider.id}/callback`;
    const secure = isSecureUrl(redirectUri);

    if (!code || !pkce || pkce.id !== provider.id || pkce.state !== state) {
      res.setHeader("Set-Cookie", clearPkceCookie(secure));
      res.status(400).json({ error: "invalid_oauth_callback" });
      return;
    }

    try {
      const endpoints = await resolveEndpoints(provider);
      const token = await exchangeCode(provider, endpoints, code, redirectUri, pkce.codeVerifier);
      const identity = await fetchIdentity(provider, endpoints, token);

      const userId = deriveUserId(provider.id, identity.subject);
      const tenantId = deriveTenantId(identity, cfg);
      const secret = expandEnvPlaceholders(cfg.sessionSecret) ?? "";
      const ttlSec = cfg.sessionTtlSec ?? 60 * 60 * 24 * 7;
      const sessionToken = mintSession(
        {
          sub: userId,
          tenant: tenantId,
          email: identity.email,
          name: identity.name,
          provider: provider.id,
        },
        secret,
        ttlSec,
      );

      res.setHeader("Set-Cookie", [
        clearPkceCookie(secure),
        buildSessionCookie(sessionToken, ttlSec, secure),
      ]);
      // Land back on the SPA root; the SPA re-fetches /api/me.
      res.redirect("/");
    } catch (err) {
      res.setHeader("Set-Cookie", clearPkceCookie(secure));
      res.status(502).json({
        error: "oauth_callback_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Logout: clear the session cookie. Safe to call even when disabled.
  app.post("/api/auth/logout", (_req: Request, res: Response) => {
    res.setHeader("Set-Cookie", buildClearCookie(true));
    res.json({ ok: true });
  });
}

/**
 * requireAdmin guard. Role is derived from `auth.admins` against the
 * email carried in the identity source meta (set by sessionResolver).
 * In dev mode (auth disabled) the dev user is treated as admin so the
 * admin UI is usable locally.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const cfg = currentAuth();
  if (!cfg.enabled) {
    next(); // dev mode: no wall, dev user is de-facto admin
    return;
  }
  const email = (req.ctx as { identityMeta?: Record<string, string> } | undefined)?.identityMeta
    ?.email;
  if (!email || roleForEmail(email, cfg) !== "admin") {
    res.status(403).json({ error: "admin_only" });
    return;
  }
  next();
}

/** Mount the ADMIN auth routes (after the tenant wall). */
export function mountAdminAuthRoutes(app: Express, deps: RoutesAuthDeps): void {
  // Read current auth config (secrets redacted).
  app.get("/api/admin/auth", requireAdmin, (_req: Request, res: Response) => {
    const cfg = currentAuth();
    res.json({
      enabled: !!cfg.enabled,
      tenantStrategy: cfg.tenantStrategy ?? "single",
      singleTenant: cfg.singleTenant ?? "default",
      admins: cfg.admins ?? [],
      sessionSecretSet: !!(expandEnvPlaceholders(cfg.sessionSecret) ?? ""),
      providers: (cfg.providers ?? []).map((p) => ({
        id: p.id,
        displayName: p.displayName ?? p.id,
        issuer: p.issuer ?? null,
        authorizeUrl: p.authorizeUrl ?? null,
        tokenUrl: p.tokenUrl ?? null,
        userInfoUrl: p.userInfoUrl ?? null,
        clientId: p.clientId,
        clientSecretSet: !!(expandEnvPlaceholders(p.clientSecret) ?? ""),
        scopes: p.scopes ?? null,
        claims: p.claims ?? null,
      })),
    });
  });

  // Patch auth config. Accepts a partial: enabled, providers, admins,
  // tenantStrategy, singleTenant, sessionSecret. Writes config.json
  // (mode 0600 via writeGlobalConfig) then re-arms the chain.
  app.patch("/api/admin/auth", requireAdmin, (req: Request, res: Response) => {
    const global = loadGlobalConfig();
    const prev = global.auth ?? {};
    const body = req.body as Partial<AuthConfig>;

    const nextAuth: AuthConfig = {
      ...prev,
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(typeof body.sessionSecret === "string" ? { sessionSecret: body.sessionSecret } : {}),
      ...(Array.isArray(body.admins) ? { admins: body.admins } : {}),
      ...(Array.isArray(body.providers) ? { providers: body.providers } : {}),
      ...(body.tenantStrategy ? { tenantStrategy: body.tenantStrategy } : {}),
      ...(typeof body.singleTenant === "string" ? { singleTenant: body.singleTenant } : {}),
      ...(typeof body.sessionTtlSec === "number" ? { sessionTtlSec: body.sessionTtlSec } : {}),
    };

    try {
      writeGlobalConfig({ ...global, auth: nextAuth });
      deps.onAuthConfigChanged?.();
      res.json({ ok: true, enabled: !!nextAuth.enabled });
    } catch (err) {
      res.status(500).json({
        error: "write_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
