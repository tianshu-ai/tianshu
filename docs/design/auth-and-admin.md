# Design: User Authentication + Admin Section

Status: **draft — awaiting sign-off**
Date: 2026-07-12
Author: tianshu (with Yu)

Reference: the closed-source repo used **better-auth** (email+password,
sessions, OAuth) with a single shared `tianshu.db` and row-level
`tenant_id` isolation. The open-source repo is architecturally
different (physical per-tenant DB isolation + a pluggable
identity-resolver chain), so we adapt the *idea*, not the code.

---

## Goals (from Yu, 2026-07-12)

1. Add a user-authentication feature to the open-source repo.
2. A **Settings → Admin** section to configure it: turn auth **on/off**,
   configure **OAuth providers**.
3. **Admin users are declared in the config file** (not self-service in
   the DB).

## Non-goals (v1)

- Full self-service signup / password reset UI.
- Per-tenant OAuth apps (auth config is **global-only** in v1).
- Migrating existing dev sessions to authed users.

---

## Where it plugs in (existing seams — no architecture change)

| Concern | Existing seam | What we add |
|---|---|---|
| "Who is this request?" | `core/identity-resolvers.ts` chain | a `sessionResolver` (cookie/JWT) + a `denyResolver` tail |
| Wire the chain | `index.ts:676` `tenantMiddleware({ ops })` + `boot/ws-upgrade.ts` | build the chain from config instead of hardcoding `DEV_RESOLVER_CHAIN` |
| Config | `core/config.ts` (already has unused `oauth?: OAuthProviderConfig[]`) | a `GlobalOnlyConfig.auth` block (see below) |
| Admin API | `boot/routes-*.ts` | `/api/admin/auth` (GET config), `/api/auth/*` (login/logout/callback) |
| Admin UI | `web/.../admin/AdminShell.tsx` `CORE_PAGES` | an `AuthPage` core admin page |

The middleware contract (`req.ctx = { tenant, userId, identitySource }`)
**does not change** — that's the whole point of the resolver chain.

---

## Config shape (global-only)

`auth` goes in `GlobalOnlyConfig` (tenant configs must NOT set it — a
tenant can't turn its own auth off). Admin users live here too.

```jsonc
{
  "auth": {
    // Master switch. false (default) = current dev behaviour
    // (cookie/env/default-dev chain, no login wall). true = the
    // session/JWT resolver runs and unauthenticated /api requests 401.
    "enabled": false,

    // Session cookie signing secret. ${VAR} placeholder resolved at
    // load time. Required when enabled=true.
    "sessionSecret": "${TIANSHU_AUTH_SECRET}",

    // Admins are declared here by email. On login, if the resolved
    // identity's email is in this list → role=admin, else role=member.
    // (Yu's requirement: admins in the config file, not the DB.)
    "admins": ["yu@51yuyu88.com"],

    // Login methods offered on the login page. GENERIC + fully
    // config-driven — the code does NOT hardcode github/google/lark.
    // The operator declares any OAuth2/OIDC provider by giving its
    // endpoints. GitHub, Google, Lark, Keycloak, Authentik … are all
    // just "a config entry". Two ways to declare a provider:
    //
    //  (a) OIDC discovery — give an `issuer`; we fetch
    //      `<issuer>/.well-known/openid-configuration` for the
    //      authorize/token/userinfo endpoints automatically.
    //  (b) explicit endpoints — for plain OAuth2 without discovery
    //      (e.g. GitHub), give the three URLs directly.
    "providers": [
      {
        "id": "my-sso",               // stable id, used in the callback URL
        "displayName": "Company SSO", // button label on the login page
        "clientId": "${OIDC_CLIENT_ID}",
        "clientSecret": "${OIDC_CLIENT_SECRET}",
        "scopes": ["openid", "email", "profile"],

        // --- pick ONE of the two shapes below ---

        // (a) discovery:
        "issuer": "https://sso.example.com/realms/main"

        // (b) explicit endpoints (omit `issuer` if you use these):
        // "authorizeUrl": "https://github.com/login/oauth/authorize",
        // "tokenUrl":     "https://github.com/login/oauth/access_token",
        // "userInfoUrl":  "https://api.github.com/user",

        // Optional: map the provider's userinfo JSON → tianshu identity.
        // Defaults suit OIDC (sub/email/name); override for odd providers
        // (e.g. GitHub nests email, Lark uses open_id/en_name).
        // "claims": { "subject": "sub", "email": "email", "name": "name" }
      }
      // …declare as many as you want. The code is provider-agnostic.
    ],

    // tenant assignment strategy for a freshly-authed user:
    //   "email"  → tenantId derived from a sanitized email local-part
    //   "single" → everyone lands in `singleTenant` (below)
    //   "claim"  → read tenant from an OIDC claim (claimName)
    "tenantStrategy": "single",
    "singleTenant": "default"
  }
}
```

`OAuthProviderConfig` already exists in `config.ts` but has hardcoded
`type: "github"|"google"|"oidc"|"lark"`. We **replace** that with the
generic endpoint-driven shape above:

```ts
interface OAuthProviderConfig {
  id: string;
  displayName?: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  // one of:
  issuer?: string;                    // OIDC discovery
  authorizeUrl?: string;              // or explicit OAuth2 endpoints
  tokenUrl?: string;
  userInfoUrl?: string;
  claims?: { subject?: string; email?: string; name?: string };
}
```

No `type` enum — the runtime treats every provider uniformly (standard
OAuth2 authorization-code + PKCE flow). This is what Yu asked for:
"OAuth 只要可以配置就行，不用写死" — no baked-in provider list, the user
configures whatever they use.

### Why global-only (decision, 2026-07-12)

Question raised: should the login switch live at the global or the
tenant level? **Decision: global-only for v1.** Reasoning:

1. **Authentication precedes tenancy.** When an unauthenticated request
   arrives there is NO tenant context yet — you can't read a tenant's
   config to decide whether to challenge them. Chicken-and-egg. The
   `auth.enabled` switch therefore has to be resolvable before any
   tenant is known → global.
2. **Security red-line.** If a tenant could set `auth.enabled` it could
   turn off its own wall (self-inflicted open access); if it could set
   `auth.admins` it could self-promote. Isolation must not be delegated
   to the isolated party. Same class as `server.port` / CORS —
   process/platform-level, not tenant business config.
3. Enforced by leaving `auth` OUT of `TENANT_WHITELIST`; a tenant
   config that sets `auth` is rejected with `TenantConfigForbiddenFieldError`.

**Also removed (2026-07-12):** the dead `OverridableConfig.oauth?:
OAuthProviderConfig[]` field. It sat in `TENANT_WHITELIST` (implying
tenants could configure OAuth) but had zero runtime consumers and
collided in name with the new `auth.providers`. Removing it kills a
"looks tenant-configurable but does nothing" trap. `OAuthProviderConfig`
itself stays — now used by `auth.providers`.

### Future: multi-tenant SaaS evolution (NOT implemented)

If tianshu ever ships as a multi-tenant SaaS where each tenant brings
its own IdP (tenant A on Okta, tenant B on Azure AD), the path is:

- `auth.enabled` + `auth.admins` **stay global** (the red-lines above
  never move).
- `auth.providers` could become `global defaults ⊕ tenant-appended`,
  mirroring the existing `models` global⊕tenant merge — a tenant may
  ADD its own provider but not disable the wall or touch admins.
- Per-tenant callback URLs (`/api/auth/<tenant>/<provider>/callback`)
  and provider-conflict merge rules would need design then.

Deliberately deferred (YAGNI): the open-source repo is single-tenant
for most deployments; per-tenant SSO is a hypothetical need. Building
the two-layer merge now would be premature complexity. The seam (config
merge + resolver chain) is already shaped so this is additive later,
not a rewrite.

---

## Resolver chain: dev vs authed

Today (`DEV_RESOLVER_CHAIN`): `cookie → env → default-dev`.

When `auth.enabled=true`, `index.ts` / `ws-upgrade.ts` build:

```
[ sessionResolver, /* validates the signed session cookie / bearer JWT */
  denyResolver     /* tail: matched-nothing ⇒ {kind:"deny"} ⇒ 401 */ ]
```

- `default-dev` (the always-allow fallback) is **dropped** in authed
  mode, so an unauthenticated request runs out of chain → middleware
  already 401s (that path exists today, see `middleware.ts` `!resolution`).
- `env`/`cookie` dev resolvers stay ONLY in dev mode.

`sessionResolver` responsibilities:
- Read `tianshu_session` cookie (or `Authorization: Bearer`), verify
  the signature/expiry against `auth.sessionSecret`.
- On valid: return `{ kind:"ok", tenantId, userId, source:"session" }`.
- On present-but-bad: return `{ kind:"deny" }` (short-circuit 401).
- On absent: return `null` (defer → hits denyResolver → 401).

Role (admin/member) is derived at the route layer from
`auth.admins.includes(email)` — the resolver only needs to produce a
stable userId/tenantId. The session record carries the email.

---

## Auth routes (new, mounted BEFORE the tenant wall)

`/api/auth/*` must be reachable without a tenant context (you can't
require login to log in). Mount before `tenantMiddleware`, mirroring
how `/api/health` and `/api/board-runtime.js` sit outside the wall.

- `GET  /api/auth/config` — public: `{ enabled, providers:[{id,type,displayName}] }` (no secrets). Login page reads this.
- `GET  /api/auth/:providerId/start` — 302 to the OAuth authorize URL (PKCE/state stored in a short-lived cookie).
- `GET  /api/auth/:providerId/callback` — exchange code → user profile → mint session cookie → 302 to app.
- `POST /api/auth/logout` — clear the session cookie.
- `GET  /api/me` — already exists; extend to include `role` (admin|member) + email.

Session store: reuse per-tenant sqlite? No — sessions are pre-tenant.
Use a **global** sqlite (`~/.tianshu/auth.db`) or signed stateless JWT.
**v1 recommendation: signed stateless cookie (JWT-ish)** — no new DB
file, logout works via short expiry + a cookie clear. Revisit if we
need server-side revocation.

---

## Admin UI: Settings → Admin (Auth) page

Add to `CORE_PAGES` in `AdminShell.tsx`:

```
{ pluginId:"core", pageId:"auth", displayName:"Admin", icon:"ShieldCheck",
  group:"System", order:1, coreComponent: AuthPage }
```

`AuthPage` (read-mostly in v1, since admins live in config):
- Shows **Auth: on/off** (reflects `auth.enabled`) with a toggle that
  writes `config.json` via a new `PATCH /api/admin/auth` (admin-only).
- Lists configured **OAuth providers** (id, type, client-id tail,
  enabled) — editable: add/remove/enable provider, secrets entered
  here are written to `config.json` (mode 0600, same as existing
  `writeGlobalConfig`).
- Shows the **admin allow-list** (read-only note: "edit `auth.admins`
  in config.json") — per Yu's requirement admins are config-declared.

`requireAdmin` guard on the API: `role === "admin"`, where role comes
from `auth.admins.includes(req.ctx.email)`.

---

## Rollout / safety

- Default `auth.enabled=false` → **zero behaviour change** for existing
  dev installs. The whole feature is dark until an operator opts in.
- Turning it on with no `sessionSecret` or no providers → server logs a
  clear error and refuses to arm the auth chain (stays in a safe 401-all
  or refuses to boot — TBD, see open questions).
- `autoCreateDefault` interplay: in authed mode we likely want
  `autoCreateDefault=false` and tenants created on first login.

---

## Open questions for Yu

1. ~~Session mechanism~~ — **RESOLVED**: stateless signed cookie
   (HMAC-SHA256, no new DB). Swap to a global sessions table later only
   if server-side revocation is needed.
2. ~~Tenant assignment~~ — **RESOLVED**: v1 ships `single` as the
   default (everyone → `default`); `email` (one tenant per user) is
   implemented and selectable but not the default.
2b. ~~Global vs tenant-level login control~~ — **RESOLVED (Yu,
   2026-07-12)**: global-only. See "Why global-only" above. Total switch
   `auth.enabled` + `auth.admins` are process-level; a tenant cannot set
   them. Future multi-tenant SaaS may append per-tenant providers, but
   the switch/admins never move to tenant scope.
3. ~~Which providers to hardcode~~ — **RESOLVED (Yu, 2026-07-12)**:
   nothing hardcoded. Generic config-driven OAuth2/OIDC; the user
   declares providers by endpoint/issuer. Code is provider-agnostic.
4. **Email/password**: closed-source had it. Skip for v1 (OAuth-only) or
   include a local password provider too?
5. **Admin editing of providers** in the UI writing secrets to
   `config.json` — OK, or keep providers config-file-only (UI read-only,
   like the admin allow-list)?

---

## Implementation plan (once decisions land)

1. `config.ts`: add `AuthConfig` to `GlobalOnlyConfig`, keep out of
   `TENANT_WHITELIST`; add `${VAR}` resolution for secrets. + tests.
2. `core/auth/` : `session.ts` (mint/verify), `oauth-flow.ts` (generic
   authorization-code + PKCE + OIDC discovery, provider-agnostic),
   `sessionResolver` + `denyResolver`. + tests.
3. `index.ts` + `boot/ws-upgrade.ts`: build chain from `auth.enabled`.
4. `boot/routes-auth.ts`: `/api/auth/*` before the wall; `requireAdmin`
   + `PATCH /api/admin/auth` after.
5. `web`: `LoginPage`, `AuthPage` (admin), extend `/api/me` consumer +
   route guard that bounces to `/login` on 401 when auth is on.
6. `config.example.json`: documented `auth` block (commented, off).
7. docs: this file → `docs/` proper; note the closed-source→OSS
   difference (better-auth+single-db  vs.  resolver-chain+per-tenant).
