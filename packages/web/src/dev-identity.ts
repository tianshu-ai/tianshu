// Dev-only identity switching via URL query parameters.
//
// Usage:
//   http://localhost:5183/?tenant=my-tenant&user=alice
//     → writes cookie tianshu_identity=my-tenant/alice, reloads
//       same path without the query string. Subsequent requests
//       go out as alice in my-tenant (cookie is same-origin).
//
//   http://localhost:5183/?reset-identity
//     → clears the cookie, reloads, back to default/dev.
//
//   http://localhost:5183/
//     → uses whatever the cookie says, or default/dev if no cookie.
//
// Why URL query + cookie rather than localStorage + header:
// the URL is glanceable ("am I signed in as alice or dev?"),
// shareable (paste a link to set up another machine), and the
// cookie picks up automatically on every fetch + WS without us
// having to teach every fetch caller about a header. See the
// docstring on packages/server/src/core/middleware.ts for the
// matching server-side parser.
//
// SECURITY: the cookie is a dev convenience. Anyone with network
// access to the tianshu instance can forge it and impersonate
// any tenant/user. Real auth (JWT) replaces this whole module.

const COOKIE_NAME = "tianshu_identity";

/** Read identity from `document.cookie`. Returns null when unset
 *  or malformed. Mirror of `parseIdentityCookie` on the server. */
export function readIdentityFromCookie(): {
  tenantId: string;
  userId: string;
} | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    const raw = decodeURIComponent(part.slice(eq + 1).trim());
    const slash = raw.indexOf("/");
    if (slash <= 0 || slash === raw.length - 1) continue;
    return {
      tenantId: raw.slice(0, slash),
      userId: raw.slice(slash + 1),
    };
  }
  return null;
}

function writeIdentityCookie(tenantId: string, userId: string): void {
  const value = encodeURIComponent(`${tenantId}/${userId}`);
  // Path=/ so it's sent on every fetch / WS upgrade.
  // Lax samesite so dev links between localhost ports work.
  // 30-day max-age — dev convenience; cleared explicitly via ?reset-identity.
  document.cookie = `${COOKIE_NAME}=${value};Path=/;Max-Age=${30 * 24 * 3600};SameSite=Lax`;
}

function clearIdentityCookie(): void {
  document.cookie = `${COOKIE_NAME}=;Path=/;Max-Age=0;SameSite=Lax`;
}

/**
 * Apply identity changes encoded in `location.search` and reload
 * the page once with a clean URL so the new cookie is in effect
 * before anything else runs.
 *
 * Idempotent — call once at the very top of the entry module.
 * If there's nothing to do, returns synchronously without
 * navigating.
 */
export function applyDevIdentityFromUrl(): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);

  const tenant = (params.get("tenant") ?? "").trim();
  const user = (params.get("user") ?? "").trim();
  const reset = params.has("reset-identity");

  if (reset) {
    clearIdentityCookie();
    params.delete("reset-identity");
    cleanReload(params);
    return;
  }

  if (tenant || user) {
    // Fall back to default-named identities if only one side was
    // supplied, so `?tenant=foo` (just switch tenant, keep dev user)
    // works.
    const current = readIdentityFromCookie();
    const finalTenant = tenant || current?.tenantId || "default";
    const finalUser = user || current?.userId || "dev";
    if (!isSafeId(finalTenant) || !isSafeId(finalUser)) {
      console.warn(
        `[tianshu] ignoring invalid identity from URL: tenant=${finalTenant} user=${finalUser}`,
      );
      return;
    }
    writeIdentityCookie(finalTenant, finalUser);
    params.delete("tenant");
    params.delete("user");
    cleanReload(params);
    return;
  }
}

function cleanReload(params: URLSearchParams): void {
  const search = params.toString();
  const url =
    window.location.pathname + (search ? `?${search}` : "") + window.location.hash;
  // replace + reload so the new cookie is picked up by the next
  // load and we don't leave a dirty back-button entry pointing at
  // ?tenant=...
  window.history.replaceState(null, "", url);
  window.location.reload();
}

function isSafeId(s: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(s) && s.length <= 64;
}
