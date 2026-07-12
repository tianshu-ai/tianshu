// Dev-only identity surfacing via URL *path* + cookie sync.
//
// What changed 2026-06-21:
// Previously identity was a query parameter
// (`?tenant=...&user=...`) that got stripped after the cookie
// was set, leaving the URL bar as just `/`. That's invisible
// state — you couldn't tell from looking at the address bar
// who you were "signed in" as, you couldn't bookmark a link
// to a specific identity, you couldn't paste a URL to another
// dev that picked them up as alice in tenant alpha. URL path
// fixes all three.
//
// New shape:
//   http://localhost:5183/tenants/<tenantId>/users/<userId>/<rest>
//
// Examples:
//   /                            → boot redirects to
//                                  /tenants/default/users/dev/
//                                  (or whatever cookie says)
//   /tenants/alpha/users/alice/  → identity is alpha/alice
//   /tenants/alpha/users/alice/admin/plugins
//                                → admin shell under that identity
//
// Backwards compat:
//   /?tenant=alpha&user=alice    → still works; converted into
//                                  the path shape on first load
//   ?reset-identity              → still works; clears cookie +
//                                  bounces to /
//
// We still write the `tianshu_identity` cookie because:
//   - server middleware (core/middleware.ts) reads identity off
//     the cookie for every fetch + WebSocket upgrade. URL path
//     is *display only*; cookie is the source the API trusts.
//   - keeps the migration story simple — JWT auth replaces both
//     URL hack and cookie at once.
//
// SECURITY: the cookie is a dev convenience. Anyone with network
// access to the tianshu instance can forge it and impersonate
// any tenant/user. Real auth (JWT) replaces this whole module.

const COOKIE_NAME = "tianshu_identity";

/** Path prefix that scopes everything to a specific identity. */
const IDENTITY_PATH_RE =
  /^\/tenants\/([A-Za-z0-9._-]{1,64})\/users\/([A-Za-z0-9._-]{1,64})(\/.*)?$/;

/** Reasonable fallback identity when we have nothing else. */
export const FALLBACK_TENANT = "default";
export const FALLBACK_USER = "dev";

export interface ParsedPath {
  tenantId: string;
  userId: string;
  /** Path after the identity prefix, always starts with "/". */
  rest: string;
}

/**
 * Parse the current `location.pathname` for an embedded
 * identity. Returns null when the path doesn't carry one
 * (caller should redirect).
 */
export function parseIdentityPath(pathname: string): ParsedPath | null {
  const m = pathname.match(IDENTITY_PATH_RE);
  if (!m) return null;
  return { tenantId: m[1], userId: m[2], rest: m[3] || "/" };
}

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
 * Build a fully-qualified path under the current identity. Used
 * by everywhere internal navigation happens
 * (Link to="...", navigate("...")). Pass the *non*-identity path
 * you'd write today (`/admin`, `/admin/plugins`, `/`); we prepend
 * `/tenants/<t>/users/<u>`.
 *
 * Returns the input unchanged when called with a string that's
 * already absolute under an identity prefix — makes it safe to
 * call on values that might already be qualified.
 */
export function buildIdentityPath(
  rest: string,
  identity?: { tenantId: string; userId: string },
): string {
  if (IDENTITY_PATH_RE.test(rest)) return rest;
  const id = identity ?? readIdentityFromCookie();
  const tenant = id?.tenantId ?? FALLBACK_TENANT;
  const user = id?.userId ?? FALLBACK_USER;
  const tail = rest.startsWith("/") ? rest : `/${rest}`;
  // `/` should collapse to just the identity prefix.
  const cleaned = tail === "/" ? "" : tail;
  return `/tenants/${tenant}/users/${user}${cleaned}`;
}

/**
 * Boot-time entry: reconcile URL path, query string, and cookie,
 * landing on a canonical `/tenants/<t>/users/<u>/...` URL with the
 * cookie matching.
 *
 * Idempotent — call once at the very top of the entry module.
 * If the URL is already canonical and the cookie agrees, returns
 * synchronously without navigating.
 *
 * Order of precedence (highest wins):
 *   1. ?reset-identity         → clear cookie, send to /
 *   2. ?tenant=... ?user=...   → write cookie, rewrite to path shape
 *   3. /tenants/<t>/users/<u>  → sync cookie to match URL
 *   4. cookie present          → redirect to its path shape
 *   5. nothing                 → redirect to /tenants/default/users/dev
 */
export function applyDevIdentityFromUrl(): void {
  if (typeof window === "undefined") return;

  // Auth-mode surfaces live OUTSIDE the identity path prefix and must
  // never be rewritten into `/tenants/<t>/users/<u>/...` — doing so
  // sends `/login` to `/tenants/default/users/dev/login`, which matches
  // the identity route's catch-all and renders blank. The login page is
  // reached before any identity exists (the api client bounces here on a
  // 401), so leave these paths exactly as-is and let the top-level
  // routes in App.tsx handle them.
  if (isAuthSurfacePath(window.location.pathname)) return;

  const params = new URLSearchParams(window.location.search);

  // 1. ?reset-identity → wipe cookie, fresh start at /.
  if (params.has("reset-identity")) {
    clearIdentityCookie();
    params.delete("reset-identity");
    const tail = params.toString() ? `?${params.toString()}` : "";
    window.location.replace("/" + tail + window.location.hash);
    return;
  }

  // 2. Legacy ?tenant=alpha&user=alice — write cookie, convert to
  //    path shape. Tolerates partial query (just tenant, just
  //    user — falls back through cookie or default).
  const qsTenant = (params.get("tenant") ?? "").trim();
  const qsUser = (params.get("user") ?? "").trim();
  if (qsTenant || qsUser) {
    const cookie = readIdentityFromCookie();
    const tenant = qsTenant || cookie?.tenantId || FALLBACK_TENANT;
    const user = qsUser || cookie?.userId || FALLBACK_USER;
    if (!isSafeId(tenant) || !isSafeId(user)) {
      console.warn(
        `[tianshu] ignoring invalid identity from URL: tenant=${tenant} user=${user}`,
      );
      return;
    }
    writeIdentityCookie(tenant, user);
    params.delete("tenant");
    params.delete("user");
    // Compose new URL: /tenants/<t>/users/<u> + whatever path
    // we were aimed at (minus the identity hints in the query).
    const carryPath = stripIdentityPrefix(window.location.pathname);
    const search = params.toString() ? `?${params.toString()}` : "";
    const next = `/tenants/${tenant}/users/${user}${carryPath}${search}${window.location.hash}`;
    window.location.replace(next);
    return;
  }

  // 3. Path already canonical → sync cookie to match (URL wins on
  //    disagreement — paste a link to another machine and it
  //    works without manual cookie surgery).
  const parsed = parseIdentityPath(window.location.pathname);
  if (parsed) {
    const cookie = readIdentityFromCookie();
    if (
      cookie?.tenantId !== parsed.tenantId ||
      cookie?.userId !== parsed.userId
    ) {
      writeIdentityCookie(parsed.tenantId, parsed.userId);
    }
    return;
  }

  // 4. No identity in path; fall back to cookie if we have one.
  const cookie = readIdentityFromCookie();
  if (cookie) {
    const next = `/tenants/${cookie.tenantId}/users/${cookie.userId}${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.replace(next);
    return;
  }

  // 5. Cold start — never been here before. Send to defaults.
  writeIdentityCookie(FALLBACK_TENANT, FALLBACK_USER);
  window.location.replace(
    `/tenants/${FALLBACK_TENANT}/users/${FALLBACK_USER}${window.location.pathname}${window.location.search}${window.location.hash}`,
  );
}

/**
 * Pull the leading `/tenants/.../users/...` off a pathname if
 * present, returning what's left ("/" if nothing else). Used when
 * converting legacy ?tenant=... query into a path so we don't
 * end up with `/tenants/a/users/b/tenants/.../users/...`.
 */
function stripIdentityPrefix(pathname: string): string {
  const m = pathname.match(IDENTITY_PATH_RE);
  if (m) return m[3] || "/";
  return pathname || "/";
}

function isSafeId(s: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(s) && s.length <= 64;
}

/** Paths that must NOT be rewritten under the dev-identity prefix
 *  (they belong to the auth flow, which is pre-identity). */
function isAuthSurfacePath(pathname: string): boolean {
  return pathname === "/login" || pathname.startsWith("/login/");
}
