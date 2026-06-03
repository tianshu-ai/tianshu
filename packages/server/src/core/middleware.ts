// Express middleware that attaches a TenantContext (and optional userId)
// to every request as `req.ctx`.
//
// PR #20 ships the simplest possible identity story: in dev mode every
// request is the dev user in the dev tenant. Real JWT auth lands in a
// later PR; this file's contract (req.ctx) won't change shape.

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
        res.status(404).json({ error: "tenant_not_found", tenantId: id.tenantId });
        return;
      }
      next(err);
      return;
    }
    req.ctx = { tenant, userId: id.userId };
    next();
  };
}

function defaultDevResolver(_req: Request): { tenantId: string; userId: string } {
  return { tenantId: DEV_TENANT_ID, userId: DEV_USER_ID };
}
