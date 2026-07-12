// Auth-mode identity resolvers + chain builder.
//
// When `auth.enabled=true`, the middleware chain becomes
// `[ sessionResolver, denyResolver ]` (the dev fallback that pins every
// request to default/dev is dropped). When disabled, callers keep using
// the DEV_RESOLVER_CHAIN unchanged — the whole feature is dark by default.

import type { Request } from "express";
import type { AuthConfig } from "../config.js";
import { expandEnvPlaceholders } from "../config.js";
import {
  DEV_RESOLVER_CHAIN,
  type IdentityResolver,
} from "../identity-resolvers.js";
import { verifySession, readSessionCookie } from "./session.js";

/**
 * Validates the signed session cookie (or `Authorization: Bearer
 * <token>`) against the auth session secret.
 *   - valid   → { kind:"ok", ... source:"session" }
 *   - bad     → { kind:"deny" }  (short-circuit 401)
 *   - absent  → null             (defer → denyResolver → 401)
 */
export function sessionResolver(cfg: AuthConfig): IdentityResolver {
  const secret = expandEnvPlaceholders(cfg.sessionSecret) ?? "";
  return {
    name: "session",
    resolve(req: Request) {
      const bearer = readBearer(req);
      const cookie = readSessionCookie(req.headers.cookie as string | undefined);
      const token = bearer ?? cookie;
      if (!token) return null; // defer

      const claims = verifySession(token, secret);
      if (!claims) {
        return { kind: "deny", source: "session", reason: "invalid_or_expired_session" };
      }
      return {
        kind: "ok",
        tenantId: claims.tenant,
        userId: claims.sub,
        source: "session",
        meta: {
          email: claims.email,
          provider: claims.provider,
          ...(claims.name ? { name: claims.name } : {}),
        },
      };
    },
  };
}

/**
 * Chain tail for authed mode: nothing matched, so reject. Placing this
 * last means an unauthenticated request runs out of chain-with-a-match
 * and the middleware 401s.
 */
export const denyResolver: IdentityResolver = {
  name: "deny",
  resolve() {
    return { kind: "deny", source: "deny", reason: "authentication_required" };
  },
};

/**
 * Build the resolver chain for the current auth config.
 *   - auth disabled → the dev chain (cookie → env → default-dev).
 *   - auth enabled  → [ sessionResolver, denyResolver ].
 */
export function buildResolverChain(cfg: AuthConfig | undefined): readonly IdentityResolver[] {
  if (!cfg?.enabled) return DEV_RESOLVER_CHAIN;
  return [sessionResolver(cfg), denyResolver];
}

/** Assert the auth config is armable; throws with a clear message so the
 *  operator sees why turning auth on failed rather than a silent 401-all. */
export function assertAuthArmable(cfg: AuthConfig): void {
  if (!cfg.enabled) return;
  const secret = expandEnvPlaceholders(cfg.sessionSecret) ?? "";
  if (!secret) {
    throw new Error(
      "auth.enabled=true but auth.sessionSecret is empty (set it or a ${VAR} that resolves)",
    );
  }
  const hasOAuth = !!cfg.providers && cfg.providers.length > 0;
  const hasLocal = !!cfg.superAdmins && cfg.superAdmins.length > 0;
  if (!hasOAuth && !hasLocal && !cfg.allowRegistration) {
    throw new Error(
      "auth.enabled=true but no way to log in — configure auth.providers, auth.superAdmins, or auth.allowRegistration",
    );
  }
}

function readBearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]! : null;
}
