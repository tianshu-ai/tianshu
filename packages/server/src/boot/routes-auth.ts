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
  tenantsForUser,
  isSuperAdmin,
  resolveTenantRole,
} from "../core/auth/identity.js";
import { getUserStore, type TenantRole } from "../core/auth/user-store.js";
import { expandEnvPlaceholders as expandEnv, isTenantDisabled } from "../core/config.js";

/** Short-lived cookie carrying PKCE state between /start and /callback. */
const PKCE_COOKIE = "tianshu_oauth_pkce";

interface RoutesAuthDeps {
  /** How the browser reaches this server (for redirect_uri). */
  publicUrl: () => string;
  /** All existing tenant ids (super-admins may enter any of them). */
  listTenants: () => string[];
  /** Create a new tenant (dirs + db + workspace seed). Throws on
   *  invalid/duplicate id. Super-admin only. */
  createTenant?: (tenantId: string) => void;
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
    // Local password login is available when auth is on (super-admins
    // and/or admin-created users can always sign in). Register form is
    // gated on allowRegistration.
    res.json({
      enabled: !!cfg.enabled,
      providers: cfg.enabled ? publicProviders(cfg) : [],
      localLogin: !!cfg.enabled,
      allowRegistration: !!cfg.enabled && !!cfg.allowRegistration,
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
      const tenants = tenantsForUser(
        cfg,
        getUserStore(),
        { userId, email: identity.email, username: null },
        deps.listTenants,
        isTenantDisabled,
      );
      if (tenants.length === 0) {
        res.setHeader("Set-Cookie", clearPkceCookie(secure));
        res.status(403).json({
          error: "no_tenant_access",
          detail: "this account is not a member of any tenant — an admin must grant access",
        });
        return;
      }
      // 1 → enter it; N → enter the first (the SPA can offer a switcher).
      const tenantId = tenants[0]!;
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

  // Local password login. Verifies against auth.db (or a config
  // super-admin), mints the same stateless session cookie as OAuth.
  app.post("/api/auth/login", (req: Request, res: Response) => {
    const cfg = currentAuth();
    if (!cfg.enabled) {
      res.status(404).json({ error: "auth_disabled" });
      return;
    }
    const body = req.body as { username?: string; password?: string };
    const username = (body.username ?? "").trim();
    const password = body.password ?? "";
    if (!username || !password) {
      res.status(400).json({ error: "missing_credentials" });
      return;
    }

    const store = getUserStore();
    const user = store.authenticate(username, password);
    if (!user) {
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }

    const tenants = tenantsForUser(
      cfg,
      store,
      { userId: user.id, email: user.email, username: user.username },
      deps.listTenants,
      isTenantDisabled,
    );
    if (tenants.length === 0) {
      res.status(403).json({
        error: "no_tenant_access",
        detail: "this account is not a member of any tenant — an admin must grant access",
      });
      return;
    }
    const tenantId = tenants[0]!;
    const secret = expandEnv(cfg.sessionSecret) ?? "";
    const ttlSec = cfg.sessionTtlSec ?? 60 * 60 * 24 * 7;
    const token = mintSession(
      {
        sub: user.id,
        tenant: tenantId,
        email: user.email ?? `${username}@local`,
        name: user.username,
        provider: "local",
      },
      secret,
      ttlSec,
    );
    res.setHeader("Set-Cookie", buildSessionCookie(token, ttlSec, isSecureUrl(deps.publicUrl())));
    // Return the full tenant list so the SPA can offer a switcher when N>1.
    res.json({ ok: true, userId: user.id, tenantId, tenants });
  });

  // Self-registration (only when auth.allowRegistration=true).
  app.post("/api/auth/register", (req: Request, res: Response) => {
    const cfg = currentAuth();
    if (!cfg.enabled) {
      res.status(404).json({ error: "auth_disabled" });
      return;
    }
    if (!cfg.allowRegistration) {
      res.status(403).json({ error: "registration_closed" });
      return;
    }
    const body = req.body as { username?: string; password?: string; email?: string };
    const username = (body.username ?? "").trim();
    const password = body.password ?? "";
    if (username.length < 2 || password.length < 6) {
      res.status(400).json({ error: "weak_credentials", detail: "username ≥2, password ≥6" });
      return;
    }
    const store = getUserStore();
    if (store.getByUsername(username)) {
      res.status(409).json({ error: "username_taken" });
      return;
    }
    const user = store.createUser(username, password, body.email);
    res.json({ ok: true, userId: user.id });
  });

  // Logout: clear the session cookie. Safe to call even when disabled.
  app.post("/api/auth/logout", (_req: Request, res: Response) => {
    res.setHeader("Set-Cookie", buildClearCookie(true));
    res.json({ ok: true });
  });
}

/**
 * Boot step: hash + upsert every configured super-admin local account
 * into auth.db (idempotent). Called once at startup when auth.enabled.
 * Passwords support `${VAR}` placeholders.
 */
export function bootstrapSuperAdmins(cfg: AuthConfig): void {
  if (!cfg.enabled || !cfg.superAdmins?.length) return;
  const store = getUserStore();
  for (const sa of cfg.superAdmins) {
    const username = sa.username?.trim();
    const password = expandEnv(sa.password) ?? "";
    if (!username || !password) {
      console.warn(`[auth] skipping super-admin with empty username/password: ${username || "(blank)"}`);
      continue;
    }
    store.ensureUser(username, password, sa.email);
  }
}

/**
 * requireAdmin guard. Admin = config super-admin (email/username) OR
 * tenant-admin (auth.db role) for the CURRENT tenant. In dev mode (auth
 * disabled) the dev user is de-facto admin so the local UI works.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const cfg = currentAuth();
  if (!cfg.enabled) {
    next(); // dev mode: no wall, dev user is de-facto admin
    return;
  }
  const ctx = req.ctx;
  if (!ctx) {
    res.status(500).json({ error: "no_ctx" });
    return;
  }
  const meta = ctx.identityMeta ?? {};
  const role = resolveTenantRole(cfg, getUserStore(), {
    userId: ctx.userId,
    tenantId: ctx.tenant.tenantId,
    email: meta.email,
    username: meta.provider === "local" ? meta.name : undefined,
  });
  if (role !== "admin") {
    res.status(403).json({ error: "admin_only" });
    return;
  }
  next();
}

/**
 * requireSuperAdmin guard — STRICTER than requireAdmin. Only a config
 * super-admin (auth.admins email / auth.superAdmins username) passes;
 * a mere tenant-admin does NOT. Used for platform-level operations like
 * creating/disabling tenants. In dev mode (auth disabled) the dev user
 * passes so local dev keeps working.
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  const cfg = currentAuth();
  if (!cfg.enabled) {
    next();
    return;
  }
  const ctx = req.ctx;
  if (!ctx) {
    res.status(500).json({ error: "no_ctx" });
    return;
  }
  const meta = ctx.identityMeta ?? {};
  const ok = isSuperAdmin(cfg, {
    email: meta.email,
    username: meta.provider === "local" ? meta.name : undefined,
  });
  if (!ok) {
    res.status(403).json({ error: "super_admin_only" });
    return;
  }
  next();
}

/** Mount the ADMIN auth routes (after the tenant wall). */
export function mountAdminAuthRoutes(app: Express, deps: RoutesAuthDeps): void {
  // Read current auth config (secrets redacted).
  app.get("/api/admin/auth", requireAdmin, (req: Request, res: Response) => {
    const cfg = currentAuth();
    // Is the CURRENT viewer a config super-admin? Drives whether the
    // tenant-management section (super-admin-only) is shown.
    const meta = req.ctx?.identityMeta ?? {};
    const viewerIsSuperAdmin = !cfg.enabled
      ? true // dev mode: de-facto super-admin
      : isSuperAdmin(cfg, {
          email: meta.email,
          username: meta.provider === "local" ? meta.name : undefined,
        });
    res.json({
      enabled: !!cfg.enabled,
      allowRegistration: !!cfg.allowRegistration,
      viewerIsSuperAdmin,
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
      ...(typeof body.allowRegistration === "boolean" ? { allowRegistration: body.allowRegistration } : {}),
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

  // ── Tenant management (super-admin only) ──
  // List existing tenants + their disabled state. requireAdmin (not
  // super) so the role-assignment picker can read it; mutations below
  // are super-admin only.
  app.get("/api/admin/tenants", requireAdmin, (_req: Request, res: Response) => {
    const disabled = new Set(loadGlobalConfig().disabledTenants ?? []);
    const ids = deps.listTenants();
    res.json({
      tenants: ids,
      detail: ids.map((id) => ({ id, disabled: disabled.has(id) })),
    });
  });

  // Create a tenant (= a new agent+workers instance). Super-admin only.
  app.post("/api/admin/tenants", requireSuperAdmin, (req: Request, res: Response) => {
    const id = (req.body as { id?: string }).id?.trim() ?? "";
    if (!id) {
      res.status(400).json({ error: "missing_tenant_id" });
      return;
    }
    if (!deps.createTenant) {
      res.status(501).json({ error: "create_not_supported" });
      return;
    }
    try {
      deps.createTenant(id);
      res.json({ ok: true, id });
    } catch (err) {
      res.status(400).json({
        error: "create_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Enable / disable a tenant (soft off-switch — data untouched).
  // Super-admin only. Writes disabledTenants[] in global config.
  app.patch("/api/admin/tenants/:id", requireSuperAdmin, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const disabled = (req.body as { disabled?: boolean }).disabled;
    if (typeof disabled !== "boolean") {
      res.status(400).json({ error: "missing_disabled_flag" });
      return;
    }
    if (!deps.listTenants().includes(id)) {
      res.status(404).json({ error: "tenant_not_found", id });
      return;
    }
    const global = loadGlobalConfig();
    const set = new Set(global.disabledTenants ?? []);
    if (disabled) set.add(id);
    else set.delete(id);
    try {
      writeGlobalConfig({ ...global, disabledTenants: [...set] });
      res.json({ ok: true, id, disabled });
    } catch (err) {
      res.status(500).json({
        error: "write_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // List local users with their per-tenant roles.
  app.get("/api/admin/users", requireAdmin, (_req: Request, res: Response) => {
    const cfg = currentAuth();
    const store = getUserStore();
    const users = store.list().map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      createdAt: u.createdAt,
      roles: store.rolesForUser(u.id),
      // Super-admins (config-declared by username or email) have all
      // permissions across ALL tenants, so their empty tenant_roles is
      // expected — flag it so the UI doesn't say "no tenant roles".
      superAdmin: isSuperAdmin(cfg, { username: u.username, email: u.email }),
    }));
    res.json({ users });
  });

  // Create a local user.
  app.post("/api/admin/users", requireAdmin, (req: Request, res: Response) => {
    const body = req.body as { username?: string; password?: string; email?: string };
    const username = (body.username ?? "").trim();
    const password = body.password ?? "";
    if (username.length < 2 || password.length < 6) {
      res.status(400).json({ error: "weak_credentials", detail: "username ≥2, password ≥6" });
      return;
    }
    const store = getUserStore();
    if (store.getByUsername(username)) {
      res.status(409).json({ error: "username_taken" });
      return;
    }
    const user = store.createUser(username, password, body.email);
    res.json({ ok: true, id: user.id });
  });

  // Reset a user's password.
  app.patch("/api/admin/users/:id/password", requireAdmin, (req: Request, res: Response) => {
    const password = (req.body as { password?: string }).password ?? "";
    if (password.length < 6) {
      res.status(400).json({ error: "weak_password" });
      return;
    }
    const store = getUserStore();
    if (!store.getById(String(req.params.id))) {
      res.status(404).json({ error: "user_not_found" });
      return;
    }
    store.setPassword(String(req.params.id), password);
    res.json({ ok: true });
  });

  // Delete a user.
  app.delete("/api/admin/users/:id", requireAdmin, (req: Request, res: Response) => {
    getUserStore().deleteUser(String(req.params.id));
    res.json({ ok: true });
  });

  // Set / remove a user's role in a tenant.
  app.put("/api/admin/users/:id/roles/:tenantId", requireAdmin, (req: Request, res: Response) => {
    const role = (req.body as { role?: string }).role;
    const store = getUserStore();
    if (!store.getById(String(req.params.id))) {
      res.status(404).json({ error: "user_not_found" });
      return;
    }
    if (role !== "admin" && role !== "member") {
      res.status(400).json({ error: "invalid_role" });
      return;
    }
    store.setRole(String(req.params.id), String(req.params.tenantId), role as TenantRole);
    res.json({ ok: true });
  });

  app.delete("/api/admin/users/:id/roles/:tenantId", requireAdmin, (req: Request, res: Response) => {
    getUserStore().removeRole(String(req.params.id), String(req.params.tenantId));
    res.json({ ok: true });
  });
}
