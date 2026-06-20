// Express middleware that attaches a TenantContext (and optional userId)
// to every request as `req.ctx`.
//
// Identity story (today, dev-only):
//
// Default → `tenantId=default, userId=dev` (the dev tenant + dev
//           user that bootstrapDevTenantIfNeeded creates on first
//           boot).
//
// Override → set the `tianshu_identity` cookie to `<tenantId>/<userId>`
//            and that request is served as the named identity. The
//            web UI sets the cookie when you load
//            `http://localhost:5183/?tenant=<id>&user=<id>` (see
//            packages/web/src/dev-identity.ts) and re-uses it for
//            subsequent requests automatically (cookies are
//            same-origin by default).
//
//            The cookie is **dev-mode-only**: anyone with network
//            access to a tianshu instance can forge it and
//            impersonate any tenant/user. Real JWT auth lands
//            later; the {tenantId, userId} → req.ctx contract
//            stays the same when it does.

import type { NextFunction, Request, Response } from "express";
import { GlobalOps, TenantNotFoundError } from "./global-ops.js";
import type { TenantContext } from "./tenant-context.js";
import { DEV_TENANT_ID, DEV_USER_ID } from "./dev-mode.js";

export interface RequestCtx {
  tenant: TenantContext;
  userId: string;
}

declare module "express-serve-static-core" {
  interface Request {
    ctx?: RequestCtx;
  }
}

export interface TenantMiddlewareOpts {
  ops: GlobalOps;
  /**
   * Resolve {tenantId, userId} for an incoming request. Default returns
   * the dev tenant + dev user. Replace this in JWT mode.
   */
  resolveIdentity?: (req: Request) => { tenantId: string; userId: string };
}

export function tenantMiddleware(opts: TenantMiddlewareOpts) {
  const resolve = opts.resolveIdentity ?? defaultDevResolver;
  return function tenantMiddlewareHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    let id: { tenantId: string; userId: string };
    try {
      id = resolve(req);
    } catch (err) {
      next(err);
      return;
    }
    let tenant: TenantContext;
    try {
      tenant = opts.ops.open(id.tenantId);
    } catch (err) {
      if (err instanceof TenantNotFoundError) {
        // Fall back to the default dev tenant when the cookie /
        // env points at a tenant that doesn't exist yet (very
        // common: user typo'd ?tenant=foo, or removed the tenant
        // dir without clearing the cookie). Surface the original
        // request via a response header so the UI can show a
        // "reset identity" hint instead of leaving the user stuck.
        try {
          tenant = opts.ops.open(DEV_TENANT_ID);
          res.setHeader(
            "X-Tianshu-Identity-Fallback",
            `requested=${id.tenantId};reason=tenant_not_found`,
          );
          req.ctx = { tenant, userId: DEV_USER_ID };
          next();
          return;
        } catch {
          // Default tenant doesn't exist either — stay 404.
          res
            .status(404)
            .json({ error: "tenant_not_found", tenantId: id.tenantId });
          return;
        }
      }
      next(err);
      return;
    }
    req.ctx = { tenant, userId: id.userId };
    next();
  };
}

/**
 * Cookie-based dev identity. Read `tianshu_identity=<tenant>/<user>`;
 * fall back to env vars (TIANSHU_DEV_TENANT / TIANSHU_DEV_USER) for
 * server-side / curl scenarios; finally fall back to default/dev.
 *
 * The cookie format is intentionally one string (`tenant/user`) so the
 * web app can write it as a single document.cookie statement and the
 * server can parse without a `cookie-parser` dep.
 */
export const DEV_IDENTITY_COOKIE = "tianshu_identity";

export function defaultDevResolver(req: Request): {
  tenantId: string;
  userId: string;
} {
  const fromCookie = parseIdentityCookie(req.headers.cookie ?? "");
  if (fromCookie) return fromCookie;
  const envTenant = process.env.TIANSHU_DEV_TENANT?.trim();
  const envUser = process.env.TIANSHU_DEV_USER?.trim();
  if (envTenant || envUser) {
    return {
      tenantId: envTenant || DEV_TENANT_ID,
      userId: envUser || DEV_USER_ID,
    };
  }
  return { tenantId: DEV_TENANT_ID, userId: DEV_USER_ID };
}

/**
 * Parse a tenantId/userId pair out of a `Cookie:` header.
 * Returns `null` when the cookie is absent / malformed; the caller
 * falls back to env / default.
 */
export function parseIdentityCookie(
  cookieHeader: string,
): { tenantId: string; userId: string } | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== DEV_IDENTITY_COOKIE) continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    const slash = value.indexOf("/");
    if (slash <= 0 || slash === value.length - 1) continue;
    const tenantId = value.slice(0, slash);
    const userId = value.slice(slash + 1);
    if (!isSafeId(tenantId) || !isSafeId(userId)) continue;
    return { tenantId, userId };
  }
  return null;
}

/** Reject anything that's not a-z A-Z 0-9 _ - . The middleware
 *  later runs `ops.open(tenantId)` which validates the id
 *  shape too; this is a belt-and-braces parse-time guard so a
 *  garbled cookie never reaches the open path. */
function isSafeId(s: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(s) && s.length <= 64;
}
