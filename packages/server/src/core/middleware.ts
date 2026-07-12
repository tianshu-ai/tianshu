// Express middleware that attaches a TenantContext (and userId)
// to every request as `req.ctx`.
//
// Identity resolution is delegated to a chain of `IdentityResolver`
// strategies (see ./identity-resolvers.ts). Each resolver inspects
// the request and either claims it, defers, or rejects. The
// middleware itself is dumb — it just runs the chain in order, hands
// the winner's tenant/user to ops.open(), and exposes the source
// via `X-Tianshu-Identity-Source` for debugging.
//
// Today's chain (DEV_RESOLVER_CHAIN):
//   cookie → env → default-dev
//
// To add a new source (subdomain, JWT, x-api-key, OAuth callback)
// you write a resolver and prepend / append it. The middleware
// contract — `req.ctx = { tenant, userId }` — never changes; that
// stability is what lets us swap dev mode for real auth without
// rippling through every route.
//
// SECURITY: the *default* chain is dev-only — cookie + env + always-
// fallback-to-dev. Production deployments must build their own
// chain (e.g. `[jwtResolver, apiKeyResolver]`, no fallback) and
// pass it via `TenantMiddlewareOpts.resolvers`.

import type { NextFunction, Request, Response } from "express";
import { GlobalOps, TenantNotFoundError } from "./global-ops.js";
import type { TenantContext } from "./tenant-context.js";
import { DEV_TENANT_ID, DEV_USER_ID } from "./dev-mode.js";
import { isTenantDisabled } from "./config.js";
import {
  DEV_RESOLVER_CHAIN,
  runIdentityChain,
  type IdentityResolver,
  type IdentityResolution,
} from "./identity-resolvers.js";

// Re-export so existing call sites (and tests) keep working.
export {
  DEV_IDENTITY_COOKIE,
  parseIdentityCookie,
  cookieResolver,
  envResolver,
  defaultDevResolver,
  DEV_RESOLVER_CHAIN,
  runIdentityChain,
} from "./identity-resolvers.js";
export type {
  IdentityResolver,
  IdentityResolution,
} from "./identity-resolvers.js";

export interface RequestCtx {
  tenant: TenantContext;
  userId: string;
  /** Which resolver in the chain produced this identity. Set so
   *  routes / plugins that care (audit logs, rate limiting) can
   *  branch on the source without re-running the chain. */
  identitySource: string;
  /** Free-form per-resolver context (email, provider, token id, ...).
   *  Audit / role-derivation only; NEVER trusted for isolation. The
   *  session resolver puts the authed email here so requireAdmin can
   *  derive role from auth.admins without re-parsing the token. */
  identityMeta?: Readonly<Record<string, string>>;
}

declare module "express-serve-static-core" {
  interface Request {
    ctx?: RequestCtx;
  }
}

export interface TenantMiddlewareOpts {
  ops: GlobalOps;
  /**
   * Ordered list of identity resolvers, OR a getter returning it.
   * Defaults to the dev chain (cookie → env → always-fall-back-to-dev).
   *
   * A getter lets the chain change at runtime without rebuilding the
   * middleware — used by auth mode so toggling `auth.enabled` re-arms
   * `[sessionResolver, denyResolver]` vs. the dev chain on the next
   * request. Production setups pass an explicit chain that ends with a
   * resolver returning `deny` rather than the default-dev resolver.
   */
  resolvers?: readonly IdentityResolver[] | (() => readonly IdentityResolver[]);
}

export function tenantMiddleware(opts: TenantMiddlewareOpts) {
  const resolversOpt = opts.resolvers;
  const getChain: () => readonly IdentityResolver[] =
    typeof resolversOpt === "function"
      ? resolversOpt
      : () => resolversOpt ?? DEV_RESOLVER_CHAIN;
  return function tenantMiddlewareHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const { resolution, error } = runIdentityChain(req, getChain());
    if (error) {
      // Resolver crash is treated as a hard 500 — never silently
      // fall through to a more permissive resolver downstream.
      res.status(500).json({
        error: "identity_resolver_threw",
        resolver: error.resolver,
        message: error.message,
      });
      return;
    }

    if (!resolution) {
      res.status(401).json({
        error: "no_identity",
        detail:
          "no resolver in the chain claimed this request; in dev mode the default chain ends with default-dev so this means the chain was misconfigured",
      });
      return;
    }
    if (resolution.kind === "deny") {
      res.status(401).json({
        error: "identity_denied",
        resolver: resolution.source,
        reason: resolution.reason,
      });
      return;
    }

    // Soft off-switch: a disabled tenant is rejected even for an
    // otherwise-valid identity. Data on disk is untouched; this just
    // refuses to route requests into it. Super-admins are NOT exempt
    // here — a disabled tenant is disabled for everyone; manage the
    // list on the admin page (or by hand) to bring it back.
    if (isTenantDisabled(resolution.tenantId)) {
      res.status(403).json({
        error: "tenant_disabled",
        tenantId: resolution.tenantId,
      });
      return;
    }

    let tenant: TenantContext;
    try {
      tenant = opts.ops.open(resolution.tenantId);
    } catch (err) {
      if (err instanceof TenantNotFoundError) {
        // Fall back to default tenant when a resolver claims a
        // tenant that doesn't exist on disk yet. Common in dev:
        // user typo'd ?tenant=foo, or `tianshu tenant delete foo`
        // ran but the cookie is still set. Surface the original
        // request via a response header so the UI / curl caller
        // can show a "reset identity" hint instead of leaving
        // them with a 404.
        try {
          tenant = opts.ops.open(DEV_TENANT_ID);
          res.setHeader(
            "X-Tianshu-Identity-Fallback",
            `requested=${resolution.tenantId};reason=tenant_not_found;source=${resolution.source}`,
          );
          req.ctx = {
            tenant,
            userId: DEV_USER_ID,
            identitySource: `${resolution.source}+fallback-default`,
          };
          res.setHeader("X-Tianshu-Identity-Source", req.ctx.identitySource);
          next();
          return;
        } catch {
          res
            .status(404)
            .json({ error: "tenant_not_found", tenantId: resolution.tenantId });
          return;
        }
      }
      next(err);
      return;
    }
    req.ctx = {
      tenant,
      userId: resolution.userId,
      identitySource: resolution.source,
      identityMeta: resolution.meta,
    };
    res.setHeader("X-Tianshu-Identity-Source", resolution.source);
    next();
  };
}
