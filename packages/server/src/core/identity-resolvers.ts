// Identity resolver chain — pluggable strategies for figuring out
// who the current request belongs to.
//
// Why a chain rather than a single function:
// the answer to "who is this request" comes from different
// sources at different points in tianshu's life:
//
//   today (dev)     → cookie set by the web app, env vars for CLI
//   soon (subdomain)→ alpha.tianshu-ai.com → tenant=alpha
//   later (auth)    → JWT in Authorization header, OAuth callback
//   maybe (api)     → x-api-key header for programmatic clients
//   tests           → trivial stub returning whatever the test wants
//
// Each strategy is a small, independently-testable resolver.
// Middleware runs them in order and uses the first match. A
// resolver returning `null` means "I have nothing to say, ask the
// next one"; returning `{kind:"deny"}` means "I matched but the
// credentials are bad — short-circuit with 401".
//
// Adding a new strategy is a single file + one push to the
// resolver array; the middleware itself never changes shape.

import type { Request } from "express";
import { DEV_TENANT_ID, DEV_USER_ID } from "./dev-mode.js";

/**
 * The result of running one resolver.
 *
 * - `null`         → resolver doesn't apply to this request; try the next one.
 * - `{kind:"ok"}`  → resolved successfully; downstream middleware can use it.
 * - `{kind:"deny"}`→ resolver matched but rejected (bad signature, expired
 *                    token, banned user). Stop the chain; respond 401.
 */
export type IdentityResolution =
  | {
      kind: "ok";
      tenantId: string;
      userId: string;
      /** Strategy that produced this result. Surfaces in
       *  X-Tianshu-Identity-Source so operators can debug routing. */
      source: string;
      /** Free-form per-resolver context (token id, kid, ...). Audit /
       *  log only; never trusted by downstream code. */
      meta?: Readonly<Record<string, string>>;
    }
  | {
      kind: "deny";
      source: string;
      reason: string;
    };

export interface IdentityResolver {
  /** Stable id, used for X-Tianshu-Identity-Source and config. */
  readonly name: string;
  /** Return null to defer; ok to claim; deny to short-circuit. */
  resolve(req: Request): IdentityResolution | null;
}

// ─── Built-in resolvers ─────────────────────────────────────────────

const DEV_IDENTITY_COOKIE = "tianshu_identity";

/**
 * Cookie-based dev identity: `tianshu_identity=<tenant>/<user>`.
 *
 * Highest priority by convention because the web app sets it
 * explicitly to override any other source. Kept dev-only — it's
 * trivially forgeable and exists for local hacking + the
 * URL-driven UX from the dev-identity feature.
 */
export const cookieResolver: IdentityResolver = {
  name: "cookie",
  resolve(req) {
    const parsed = parseIdentityCookie(req.headers.cookie ?? "");
    if (!parsed) return null;
    return {
      kind: "ok",
      tenantId: parsed.tenantId,
      userId: parsed.userId,
      source: "cookie",
    };
  },
};

/**
 * Process-wide override via env vars: `TIANSHU_DEV_TENANT` /
 * `TIANSHU_DEV_USER`. Reads `process.env` at request time so
 * tests / nodemon-style restarts pick up changes.
 */
export const envResolver: IdentityResolver = {
  name: "env",
  resolve(_req) {
    const tenantId = process.env.TIANSHU_DEV_TENANT?.trim();
    const userId = process.env.TIANSHU_DEV_USER?.trim();
    if (!tenantId && !userId) return null;
    return {
      kind: "ok",
      tenantId: tenantId || DEV_TENANT_ID,
      userId: userId || DEV_USER_ID,
      source: "env",
    };
  },
};

/**
 * Last-resort fallback. Always returns the dev tenant + dev user.
 * Place this at the end of the chain so unauthenticated requests
 * in dev mode have somewhere to land.
 *
 * In production, replace with a resolver that returns `deny`
 * (forcing real auth) or omit entirely (so the chain runs out
 * and the middleware 401s).
 */
export const defaultDevResolver: IdentityResolver = {
  name: "default-dev",
  resolve(_req) {
    return {
      kind: "ok",
      tenantId: DEV_TENANT_ID,
      userId: DEV_USER_ID,
      source: "default-dev",
    };
  },
};

/**
 * Default chain shipped with `npm run dev`. Cookie wins, then
 * env, then everyone-is-dev.
 *
 * To plug a new strategy in (subdomain, JWT, api-key) call
 * sites build a new array — the chain itself isn't a singleton.
 */
export const DEV_RESOLVER_CHAIN: readonly IdentityResolver[] = [
  cookieResolver,
  envResolver,
  defaultDevResolver,
];

// ─── Cookie parser (exported for tests + the web bridge) ────────────

/**
 * Parse a `tianshu_identity=<tenant>/<user>` value out of a
 * `Cookie:` header. Returns null when the cookie is absent /
 * malformed; the resolver chain falls through.
 *
 * Validation pass:
 *   - exactly one slash, both sides non-empty
 *   - each side ≤ 64 chars, [A-Za-z0-9._-] only
 * Garbage values never reach `ops.open()`.
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
    let value: string;
    try {
      value = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
    const slash = value.indexOf("/");
    if (slash <= 0 || slash === value.length - 1) continue;
    const tenantId = value.slice(0, slash);
    const userId = value.slice(slash + 1);
    if (!isSafeId(tenantId) || !isSafeId(userId)) continue;
    return { tenantId, userId };
  }
  return null;
}

export { DEV_IDENTITY_COOKIE };

function isSafeId(s: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(s) && s.length <= 64;
}
