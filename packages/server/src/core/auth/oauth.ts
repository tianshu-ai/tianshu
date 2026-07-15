// Generic, provider-agnostic OAuth2 / OIDC login flow.
//
// The runtime hardcodes NO provider. Every configured provider goes
// through the same authorization-code + PKCE flow. Endpoints come from
// either OIDC discovery (`issuer`) or explicit URLs in config. User
// identity is read from the userinfo endpoint and mapped via optional
// `claims` dot-paths.
//
// Yu's requirement (2026-07-12): "OAuth 只要可以配置就行，不用写死,
// 让用户自己配" — this file treats GitHub/Google/Lark/Keycloak/… all
// the same; the difference is entirely in config.

import { createHash, randomBytes } from "node:crypto";
import type { OAuthProviderConfig } from "../config.js";
import { expandEnvPlaceholders } from "../config.js";

/** Resolved provider endpoints (post-discovery). */
export interface ResolvedEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
}

/** Identity extracted from a provider's userinfo response. */
export interface ProviderIdentity {
  /** Provider-scoped stable subject (never reused across providers). */
  subject: string;
  email: string;
  name?: string;
}

/** PKCE + state pair minted at the start of a login, stashed in a
 *  short-lived cookie and checked on callback. */
export interface PkceState {
  state: string;
  codeVerifier: string;
}

const DEFAULT_SCOPES = ["openid", "email", "profile"];

/** Cache discovery docs so we don't refetch on every login. */
const discoveryCache = new Map<string, { at: number; endpoints: ResolvedEndpoints }>();
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1h

/**
 * Resolve a provider's endpoints. Explicit URLs win; otherwise fetch
 * the OIDC discovery document from `<issuer>/.well-known/...`.
 */
export async function resolveEndpoints(
  p: OAuthProviderConfig,
): Promise<ResolvedEndpoints> {
  if (p.authorizeUrl && p.tokenUrl && p.userInfoUrl) {
    return { authorizeUrl: p.authorizeUrl, tokenUrl: p.tokenUrl, userInfoUrl: p.userInfoUrl };
  }
  if (!p.issuer) {
    throw new Error(
      `oauth provider "${p.id}": needs either issuer (OIDC discovery) or explicit authorizeUrl/tokenUrl/userInfoUrl`,
    );
  }
  const cached = discoveryCache.get(p.issuer);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.endpoints;

  const url = p.issuer.replace(/\/$/, "") + "/.well-known/openid-configuration";
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`oauth provider "${p.id}": discovery fetch ${url} → HTTP ${res.status}`);
  }
  const doc = (await res.json()) as {
    authorization_endpoint?: string;
    token_endpoint?: string;
    userinfo_endpoint?: string;
  };
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.userinfo_endpoint) {
    throw new Error(`oauth provider "${p.id}": discovery doc missing endpoints`);
  }
  const endpoints: ResolvedEndpoints = {
    authorizeUrl: doc.authorization_endpoint,
    tokenUrl: doc.token_endpoint,
    userInfoUrl: doc.userinfo_endpoint,
  };
  discoveryCache.set(p.issuer, { at: Date.now(), endpoints });
  return endpoints;
}

/** Mint a fresh PKCE verifier + state. */
export function newPkceState(): PkceState {
  return {
    state: randomBytes(16).toString("hex"),
    codeVerifier: randomBytes(32).toString("base64url"),
  };
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Build the provider authorize URL to 302 the user to. */
export function buildAuthorizeUrl(
  p: OAuthProviderConfig,
  endpoints: ResolvedEndpoints,
  redirectUri: string,
  pkce: PkceState,
): string {
  const u = new URL(endpoints.authorizeUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", (p.scopes ?? DEFAULT_SCOPES).join(" "));
  u.searchParams.set("state", pkce.state);
  u.searchParams.set("code_challenge", codeChallenge(pkce.codeVerifier));
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/** Exchange an authorization code for an access token. */
export async function exchangeCode(
  p: OAuthProviderConfig,
  endpoints: ResolvedEndpoints,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<string> {
  const secret = expandEnvPlaceholders(p.clientSecret) ?? "";
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: p.clientId,
    client_secret: secret,
    code_verifier: codeVerifier,
  });
  const res = await fetch(endpoints.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`oauth provider "${p.id}": token exchange → HTTP ${res.status}`);
  }
  // Most providers return JSON; GitHub returns JSON when accept:json.
  const tok = (await res.json()) as { access_token?: string };
  if (!tok.access_token) {
    throw new Error(`oauth provider "${p.id}": token response has no access_token`);
  }
  return tok.access_token;
}

/** Read a dot-path (e.g. "data.email") out of a JSON object. */
function readPath(obj: unknown, path: string): string | undefined {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" ? cur : cur == null ? undefined : String(cur);
}

/** Fetch userinfo with the access token and map it to a ProviderIdentity. */
export async function fetchIdentity(
  p: OAuthProviderConfig,
  endpoints: ResolvedEndpoints,
  accessToken: string,
): Promise<ProviderIdentity> {
  const res = await fetch(endpoints.userInfoUrl, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`oauth provider "${p.id}": userinfo → HTTP ${res.status}`);
  }
  const info = (await res.json()) as Record<string, unknown>;
  const subjectPath = p.claims?.subject ?? "sub";
  const emailPath = p.claims?.email ?? "email";
  const namePath = p.claims?.name ?? "name";

  const subject = readPath(info, subjectPath);
  const email = readPath(info, emailPath);
  if (!subject) {
    throw new Error(`oauth provider "${p.id}": userinfo missing subject claim "${subjectPath}"`);
  }
  if (!email) {
    throw new Error(`oauth provider "${p.id}": userinfo missing email claim "${emailPath}"`);
  }
  return { subject, email, name: readPath(info, namePath) };
}
