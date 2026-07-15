// Stateless signed-cookie sessions.
//
// v1 auth uses a self-contained signed token instead of a server-side
// session table: no new DB file, and logout works via a short expiry +
// a cookie clear. The token is `base64url(payload).base64url(hmac)`,
// signed with HMAC-SHA256 over the payload using `auth.sessionSecret`.
//
// This is deliberately NOT a full JWT lib — we own both ends, the claim
// set is tiny and fixed, and avoiding a dependency keeps the trust
// surface small. If we later need server-side revocation, swap this for
// a global `auth.db` sessions table behind the same mint/verify API.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Claims carried by a session token. Kept minimal + stable. */
export interface SessionClaims {
  /** tianshu userId (stable, provider-scoped external id hashed → id). */
  sub: string;
  /** tenantId this session is bound to. */
  tenant: string;
  /** Email (used to derive admin role against auth.admins). */
  email: string;
  /** Display name, best-effort. */
  name?: string;
  /** Provider id that authenticated this session. */
  provider: string;
  /** Issued-at (epoch seconds). */
  iat: number;
  /** Expiry (epoch seconds). */
  exp: number;
}

const b64url = {
  encode(buf: Buffer): string {
    return buf
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  },
  decode(s: string): Buffer {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
  },
};

function sign(payloadB64: string, secret: string): string {
  return b64url.encode(createHmac("sha256", secret).update(payloadB64).digest());
}

/** Mint a signed session token for the given claims. */
export function mintSession(
  claims: Omit<SessionClaims, "iat" | "exp">,
  secret: string,
  ttlSec: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  const full: SessionClaims = { ...claims, iat: now, exp: now + ttlSec };
  const payloadB64 = b64url.encode(Buffer.from(JSON.stringify(full), "utf8"));
  const sig = sign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

/**
 * Verify + decode a session token. Returns the claims on success, or
 * null on any failure (malformed, bad signature, expired). Constant-time
 * signature compare to avoid timing oracles.
 */
export function verifySession(token: string, secret: string): SessionClaims | null {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = sign(payloadB64, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let claims: SessionClaims;
  try {
    claims = JSON.parse(b64url.decode(payloadB64).toString("utf8")) as SessionClaims;
  } catch {
    return null;
  }
  if (
    !claims ||
    typeof claims.sub !== "string" ||
    typeof claims.tenant !== "string" ||
    typeof claims.exp !== "number"
  ) {
    return null;
  }
  if (Math.floor(Date.now() / 1000) >= claims.exp) return null;
  return claims;
}

/** Cookie name for the session token. */
export const SESSION_COOKIE = "tianshu_session";

/** Read the session token from a Cookie header (or null). */
export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** Build the Set-Cookie value for a session token (HttpOnly, SameSite=Lax). */
export function buildSessionCookie(token: string, ttlSec: number, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${ttlSec}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Build the Set-Cookie value that clears the session (logout). */
export function buildClearCookie(secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
