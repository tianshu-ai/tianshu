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
import {
  DEV_RESOLVER_CHAIN,
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
}

declare module "express-serve-static-core" {
  interface Request {
    ctx?: RequestCtx;
  }
}

export interface TenantMiddlewareOpts {
  ops: GlobalOps;
  /**
   * Ordered list of identity resolvers. Defaults to the dev chain
   * (cookie → env → always-fall-back-to-dev). Production setups
   * should pass an explicit chain that ends with a resolver
   * returning `deny` rather than the default-dev resolver.
   */
  resolvers?: readonly IdentityResolver[];
}

export function tenantMiddleware(opts: TenantMiddlewareOpts) {
  const chain = opts.resolvers ?? DEV_RESOLVER_CHAIN;
  return function tenantMiddlewareHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    let resolution: IdentityResolution | null = null;
    for (const resolver of chain) {
      let r: IdentityResolution | null;
      try {
        r = resolver.resolve(req);
      } catch (err) {
        // Resolver crash is treated as deny — never silently fall
        // through to a more permissive resolver downstream. Surface
        // for debugging.
        res.status(500).json({
          error: "identity_resolver_threw",
          resolver: resolver.name,
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (r === null) continue;
      resolution = r;
      break;
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
    };
    res.setHeader("X-Tianshu-Identity-Source", resolution.source);
    next();
  };
}
