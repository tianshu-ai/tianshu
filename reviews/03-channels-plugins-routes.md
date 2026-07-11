# Code Review — Channels, Plugins system, HTTP routes, MCP

Scope: `packages/server/src/channels/*`, `plugins-routes.ts`, `core/plugins/*`, `index.ts` (route mounting + capability wiring), `boot/routes-*.ts`, `boot/ws-upgrade.ts`, `boot/idle-runner.ts`, `tools/index.ts`.

Read-only. Cited paths are relative to `packages/server/src` unless otherwise noted.

Trust model reminder (`docs/architecture/plugins.md` §13): plugins are mutually trusted, "tenant admin curates the list". Findings below therefore focus on **cross-tenant** and **cross-user** boundaries, not on plugin-vs-plugin isolation.

There is also **no admin/role concept** anywhere: `tenantMiddleware` (`core/middleware.ts:77-159`) resolves `(tenantId, userId)` only. Every "admin" route is reachable by every authenticated user in every tenant. That's the single biggest force multiplier for the findings below.

---

## Findings

### 1. HIGH — `PUT /api/admin/models/providers` lets any tenant user rewrite GLOBAL provider config (multi-tenant escalation + SSRF sink)

- **Where**: `boot/routes-core.ts:176-217` (route body), `boot/routes-core.ts:157-159` (mount).
- **What**: The handler loads via `loadGlobalConfig(getTianshuHome())` and writes via `writeGlobalConfig(nextCfg, getTianshuHome())`. It's mounted at `/api/admin/models/providers` behind only `tenantMiddleware`, which does **not** distinguish admin users. Any authenticated user in any tenant (including a fresh dev tenant) can:
  - Rewrite `models.providers[*].baseUrl` / `.api` to attacker infrastructure — every tenant that has not explicitly overridden `models` in their tenant config will subsequently route model calls through the attacker (see `core/config.ts:325-346` — tenant `models` is wholesale-replace, so tenants who inherit global are hijacked).
  - Delete providers / rewrite `defaultModelId` / `defaultModel` — DoS all other tenants.
  - The `__stored__` sentinel does prevent direct key exfiltration via GET, but a hostile user can supply `apiKey: ""` (empty non-sentinel) which clears the stored key, or set their own key.
- **Why**: There is no ACL. GET masks secrets but the write path is untrusted-caller-full-control against a **process-wide** config file. Since the route lives under `/api/admin/...`, it *looks* admin-gated by convention only.
- **Fix**:
  1. Introduce an "admin" role bit (either on the users row or on the tenant) and gate this route on it; deny for non-admins from non-privileged tenants.
  2. At minimum, restrict this route to the dev tenant while an ACL story lands (`req.ctx.tenant.tenantId === DEV_TENANT_ID`), matching the spirit of the resolver-chain doc comment in `core/middleware.ts:19-24`.
  3. Reject requests whose `baseUrl` resolves to loopback / link-local / RFC1918 / metadata addresses unless explicitly whitelisted (SSRF hardening).
  4. Consider partitioning: providers editable through the API should only affect the *calling tenant's* tenant config (`plugins`/`models` under `<tenant>/config.json`) — never `~/.tianshu/config.json`.

---

### 2. HIGH — MCP server CRUD accepts arbitrary URLs → SSRF via config from any tenant user

- **Where**: `plugins-routes.ts:261-299` (POST), `plugins-routes.ts:301-340` (PATCH), URL parser at `plugins-routes.ts:748-786` (`parseUserEntry`). Downstream sink: `core/mcp-manager.ts:145-157` (`makeToolset` → `new McpToolset({ resolve: () => e.url, upstreamHost: e.upstreamHost })`).
- **What**: `parseUserEntry` validates `url` is http(s) with a valid `URL(...)` parse but does not restrict host. A crafted request:
  ```
  POST /api/mcp/servers
  {"id":"x","url":"http://169.254.169.254/latest/meta-data/"}
  ```
  is accepted, persisted into `<tenant>/config.json → mcp.servers[]`, and the MCP toolset will subsequently make outbound HTTP(S) requests to that address from inside the server process. Same works for `http://localhost:6379`, internal Kubernetes services, cloud metadata endpoints, etc.
- Additionally, `upstreamHost` is accepted as any 200-char string with **no format validation** (`plugins-routes.ts:781`). This is forwarded to `McpToolset`'s Host header override; malformed values can trigger request smuggling or hit unintended vhosts on shared infrastructure.
- **Why**: Any tenant user (no admin role, no rate limit) can add MCP servers. The tool schema is trusted so once added, agent tool calls fan out to the attacker-picked URL with server-side network reach.
- **Fix**:
  1. Deny private / link-local / loopback / metadata IPs unless config explicitly enables an allow-list (see `web_fetch` / `web_search` patterns elsewhere).
  2. Validate `upstreamHost` matches a hostname regex (`/^[a-z0-9.-]+(?::\d+)?$/i`) and disallow characters that could break HTTP framing (`\r`, `\n`, spaces).
  3. Cap `servers[]` length in tenant config (prevent runaway DoS via thousands of stalled connect attempts on each `refreshStaleToolsets`).
  4. Bind an admin role once one exists — see Finding #1.

---

### 3. HIGH — `broadcastToUser` is keyed by `userId` only, no tenant scoping

- **Where**: `chat/active-harnesses.ts:145-159` (broadcast), `chat/active-harnesses.ts:105-140` (register).
- **What**: `userSendChannels` is a `Map<userId, Set<send>>`. Anywhere `broadcastToUser(userId, msg)` is called (`channels/stream-sink.ts:56-64`, `channels/router.ts:130-133`, `boot/idle-runner.ts:88-96`) messages fan out to every WS registered for that `userId`, regardless of which tenant that WS is currently in. If a `userId` is ever repeated across tenants (`randomUUID()` collisions are astronomically unlikely, but there is **no schema constraint** guaranteeing uniqueness, and users seeded from external identity systems could produce structured IDs), a message intended for tenant A leaks to tenant B.
- **Why**: The registration payload carries `tenantId` (line 105) but `broadcastToUser` (line 145) doesn't consult it — the tenant map is used only by `broadcastToTenant`. Sensitive events (`message_added` with assistant/user text) flow through `broadcastToUser` from `stream-sink.ts`.
- **Fix**: Change the key to `${tenantId}::${userId}` (or nested `Map<tenantId, Map<userId, Set>>`) and require `tenantId` on every broadcast callsite. Alternatively, tag every registered `send` with `tenantId` and filter inside `broadcastToUser`.

---

### 4. HIGH — Idle-runner scans **every tenant DB** for a session id, then acts inside whichever tenant owns it

- **Where**: `boot/idle-runner.ts:53-83`.
- **What**: Given a `sessionId` from the inbox, the runner iterates `globalOps.list()` and picks the first tenant whose DB has a row with that `id`. It then runs `runPrompt` inside that tenant with the supplied `userId` (unverified) and — for channel-bound sessions — sends replies through `channelHub.send(channelBindingId, …)` and `broadcastToUser(userId, …)`.
- **Why**: Session IDs use `session_${randomUUID()}` so collisions are unlikely, but the pattern is a **capability confusion sink**: anything that can enqueue an inbox row with `{sessionId, userId, promptText}` (session-inbox producers, plugin tools calling `SessionInboxCapability.enqueue`) implicitly names which tenant the turn runs in. Combined with the fact that `enqueue` in `chat/session-inbox.ts` is only tenant-scoped by its ctx at call time and the runner then re-resolves by scanning, a bug in any producer that lets a caller pass an attacker-influenced `sessionId` could cross-tenant. Even without a bug, `userId` is not validated against the resolved session's `user_id`; a mismatched `userId` sends assistant output to the wrong user's WS tabs (Finding #3 makes this concrete).
- **Fix**:
  1. Persist `tenantId` alongside the inbox row (or accept it at `enqueue`-time from ctx) and open only that tenant; do not scan.
  2. Verify `row.user_id === userId` before running, or read `userId` off the row rather than trusting the caller.

---

### 5. MEDIUM — Race: message arrives after binding deletion → session created under an arbitrary tenant user

- **Where**: `channels/sessions.ts:83-110`, `channels/router.ts:110-115`.
- **What**: `dispatch()` calls `ensureChannelSession()` after `channelHub.onMessage` fires. If the binding row was just deleted (`host.channelBindings.delete` in `index.ts:340-373`) but the adapter hasn't fully stopped, an in-flight envelope will fall through to `ensureChannelSession`'s "no binding row" branch (`sessions.ts:88-101`), which then creates a fresh session **owned by the tenant's first user** (`ORDER BY created_at ASC LIMIT 1`). A malicious platform peer (or an accidental late message from a real user's chat) is then delivered into that first user's chat sidebar as if it were their session.
- **Why**: `deleteBinding` runs inside a transaction that also removes the session/message rows, but the adapter stop is `.catch(() => {})` best-effort and there is no fence forcing the hub `onMessage` queue to drain before deletion.
- **Fix**:
  1. `deleteBinding` should first `channelHub.unregister(bindingId)` and `await channelManager.stopBinding(bindingId)` before deleting rows; drop the `.catch(() => {})` silencing so a failed stop keeps the row.
  2. `ensureChannelSession` should refuse to synthesize a fallback owner. If the binding row is gone, drop the message (log at info) rather than pick a random user.

---

### 6. MEDIUM — WebSocket upgrade silently falls back to the DEV tenant on `TenantNotFoundError`

- **Where**: `boot/ws-upgrade.ts:66-100`, mirrors HTTP middleware behaviour at `core/middleware.ts:112-136`.
- **What**: If the identity resolver claims tenant `foo` but `foo` is deleted / misspelled, the socket is silently placed inside `DEV_TENANT_ID` (with `DEV_USER_ID` implicit for HTTP; for WS it inherits `resolution.userId` which may not exist in the dev tenant — worse, it may collide). Combined with the header `X-Tianshu-Identity-Fallback` on HTTP and `identity_fallback` on WS, this is fine in dev but is a landmine in prod: any auth chain misconfiguration silently drops users into a shared tenant.
- **Why**: The comment at `core/middleware.ts:19-24` says production must supply a non-defaulting resolver chain, but there is no *code path* preventing fallback if a production resolver is supplied. If an operator adds `[jwtResolver]` but leaves `bootstrapDevTenantIfNeeded` on, JWT-authenticated users whose tenants disappear get shoved into dev.
- **Fix**: Make the fallback opt-in via `TenantMiddlewareOpts` (`enableDevFallback: boolean`) that defaults to false unless the resolver chain is literally `DEV_RESOLVER_CHAIN`. Do the same in `installChatWebSocket`. Alternatively, guard on `globalConfig.autoCreateDefault === true`.

---

### 7. MEDIUM — `host.channelBindings.create` accepts any `ownerUserId` inside the tenant (cross-user binding attribution)

- **Where**: `index.ts:279-333` (capability closure).
- **What**: The plugin-supplied `input.ownerUserId` is used verbatim. Since `PluginContext` is tenant-scoped but has no `userId` (host injects only `tenantId`, see `core/plugins/registry.ts:975-1010`), plugins cannot verify who "owns" the create. A bug (or malicious plugin, per the design's trust model) can create a wechat/telegram binding attributed to another user in the tenant — subsequent inbound messages produce channel sessions owned by that user (`channels/sessions.ts:83-101`).
- **Why**: The trust model per `plugins.md` §13 gives plugins full access, so this is *documented* behaviour. It becomes a **security-relevant** issue when combined with #3 (userId keying) or #5 (fallback owner).
- **Fix**:
  1. Plumb `userId` into `PluginContext` (bind at `attachChatHandler` time / at OAuth-callback route dispatch) and use it as the source of truth in `create`.
  2. At minimum, verify `ownerUserId` exists in `users` table for `ctx.tenantId` (currently no FK check performed here — `channel_bindings.owner_user_id` FK would catch this at DB level, but the app should return 400 not 500).

---

### 8. MEDIUM — `PATCH /api/plugins/:id` is per-user reachable but has tenant-wide impact

- **Where**: `plugins-routes.ts:431-565`.
- **What**: The route is behind `tenantMiddleware` only. Any authenticated user in the tenant can enable/disable/re-configure any plugin, and the mutation applies **process-wide for that tenant** (`writeTenantConfig` at `plugins-routes.ts:503-508`, plus `registry.invalidate(tenantId)` at :525, plus `onPluginsChanged` broadcast to every other user's WS at :540-560). One user in a multi-user tenant can silently disable another user's tool set mid-turn.
- **Why**: ADR-0003 §13 says v0 is "tenant admin curates". Code doesn't gate this on any role.
- **Fix**:
  1. Add an admin/owner-role gate. Non-admin users get 403.
  2. Log every enabled/disabled transition with `req.ctx.userId` + `identitySource` for audit; today the log message doesn't include the actor.

---

### 9. MEDIUM — Plugin routes bypass Express's normal path handling (`req.path` matched with a hand-rolled regex)

- **Where**: `plugins-routes.ts:139-190` (dispatcher), `plugins-routes.ts:34-73` (`compilePluginPath` / `matchPluginPath`).
- **What**: Two subtle issues:
  1. The capture regex `[A-Za-z0-9._~-]+` (`:65`) allows `..` as a param value. Any plugin that then uses `req.params.id` to build a filesystem path (very plausible for something like `/agents/:id/reset` → `<workspace>/agents/<id>/...`) inherits a path-traversal vector. This is not the host's fault by the trust model, but the host should not silently make it easier.
  2. Only exact-match: `req.path` is compared to a declared pattern with an anchored regex. That means a plugin declaring `/files` will *not* match `/files/foo` — which is intentional per the comment, but conversely, a plugin declaring `/foo/:id` is compared against `req.path` after Express's mount stripping. If Express does not URL-decode consistently across versions this can be exploited.
- **Why**: The comment at :143-152 promises Express-like behaviour but the implementation is bespoke.
- **Fix**:
  1. Refuse capture values containing `..` or leading `.` (`if (v.includes("..") || v.startsWith(".")) return null;`) as a defence in depth.
  2. Consider constructing a real `express.Router()` per plugin at activation time and delegating; the hand-rolled matcher is easy to get subtly wrong.

---

### 10. MEDIUM — `splitSecrets` misses secrets buried in arrays or nested objects deeper than the declared key

- **Where**: `plugins-routes.ts:597-651`.
- **What**: The recursive walk only descends into plain objects (`typeof v === "object" && !Array.isArray(v)`, :639). If a plugin config schema declares a secret at `foo.credentials[0].token`, the top-level `foo.credentials` array is copied wholesale into `plain` — the "secret" cleartext ends up persisted to `<tenant>/config.json` instead of the 0600 `<tenant>/secrets/plugin-<id>.json`. Similar for objects nested inside arrays.
- Also, secret-key detection uses the pre-flattened dotted form (`secretKeys.has(dotted)`). If a plugin's schema declares a literal key `foo.bar` and the form POSTs it as top-level `{"foo.bar": "..."}` instead of nested `{"foo":{"bar":"..."}}`, only the nested form is recognized as a secret; the top-level form leaks cleartext to config.
- **Why**: The comment (:597-605) says top-level keys with dots aren't supported, but the guard isn't enforced.
- **Fix**:
  1. Walk arrays too (recurse into each element with `dotted` unchanged, or with `${dotted}[${i}]` if you extend the schema).
  2. When `secretKeys` contains a dot, refuse to persist any config that has that dotted string as a literal top-level key, or normalize before comparing.
  3. Log a warning when a `secret`-kind field cannot be stripped from `plain`.

---

### 11. MEDIUM — Channel-router sets `binding.status = "error"` from arbitrary agent/provider strings; unauthenticated peers can DoS a binding

- **Where**: `channels/router.ts:255-274`.
- **What**: After failed retries, the router persists the raw provider error into `channel_bindings.status_detail` and marks the binding `error`. A hostile chat-platform peer who can trigger a specific model call to fail (e.g. crafted prompt that saturates the context window, causes 429 spikes, or hits provider-side content policy) can flip the binding into `error` and rely on the admin UI's polling display to be misleading. Repeat abuse also gives an attacker a persistent covert channel via `status_detail` (adversary-controlled text is stored in tenant DB).
- **Why**: `errorReason` is `err instanceof Error ? err.message : String(err)` — untrusted upstream text — and is written to `status_detail` unbounded.
- **Fix**:
  1. Truncate `status_detail` to a sane length (e.g. 512 chars) and strip control characters.
  2. Only escalate to `error` after N failures in a rolling window; transient provider hiccups shouldn't flip binding status.
  3. Consider a distinct `degraded` status so the admin UI distinguishes "one turn failed" from "adapter stopped".

---

### 12. MEDIUM — Adapter-manager `lookup()` scans every tenant DB; no explicit tenant guard on `startBinding`/`stopBinding`

- **Where**: `channels/adapter-manager.ts:80-92, 141-171, 191-201`.
- **What**: `lookup(bindingId)` iterates `globalOps.list()` and returns the first hit. `startBinding`/`stopBinding` are then invoked against whatever tenant that scan returned. The `host.channelBindings` capability closures do check tenant/owner *before* calling `stopBinding` (`index.ts:361-365`), and the `create` path does too. But any future caller inside the host (or a plugin using the capability) that omits the pre-check gets no host-side enforcement.
- **Why**: The manager treats `bindingId` as a global handle without cross-checking the caller's tenant.
- **Fix**: Add `tenantId` to `startBinding`/`stopBinding` signatures (required), and refuse when `binding.tenantId !== provided`. The current caller sites all know the tenant.

---

### 13. MEDIUM — Plugin path-cache is unbounded, keyed by plugin-supplied strings

- **Where**: `plugins-routes.ts:43` (`pluginPathCache`).
- **What**: `compilePluginPath` populates a process-lifetime `Map` keyed by the *declared* path string. A misbehaving (or malicious plugin) can declare thousands of distinct routes and pin memory. Since plugins are trusted this is only a robustness issue today, but the comment "Plugin manifests are bounded" isn't enforced anywhere.
- **Fix**: Cap the manifest's `contributes.apiRoutes` at a small number (10-20) inside `parseApiRoute` (`core/plugins/manifest.ts:761`), or LRU the cache.

---

### 14. LOW — `PATCH /api/mcp/servers/:id` allows id in body to escape via spread, but this is caught — flag for regression

- **Where**: `plugins-routes.ts:316-330`.
- **What**: `merged = parseUserEntry({ ...servers[idx], ...(req.body as Record<string, unknown>), id }, { existingId: id })`. The trailing `id` overrides any attacker-supplied id in the body, and `parseUserEntry` also refuses id changes. Correct today. But the spread ordering is fragile — any future refactor that moves `id` earlier or drops the `existingId` check reopens it. Add a regression test (`plugins-routes.test.ts`) that PATCHes with `{"id":"other"}` and confirms rejection.

---

### 15. LOW — `POST /api/plugins/refresh` triggers a full `deactivate()` + rescan with no rate limit; any tenant user can DoS

- **Where**: `plugins-routes.ts:403-425`.
- **What**: Any authenticated user can hammer this endpoint. `reloadResolver()` re-imports every builtin's dist file (each fs.stat + dynamic import), and `invalidate(tenantId)` awaits every active plugin's `deactivate()` sequentially. In a workboard-heavy tenant, `deactivate()` may take seconds (kill sandbox VMs). A tight loop against `/api/plugins/refresh` denies service to real users.
- **Fix**: Per-tenant rate-limit (e.g. 1 refresh / 5s), or an admin-role gate.

---

### 16. LOW — `channels/router.ts` dispatches every inbound message with `void ... .catch(...)` — unhandled promise sink also swallows binding-context on rejection

- **Where**: `channels/router.ts:104-115`.
- **What**: The catch handler logs but does not surface a status change; a broken adapter that hits sync errors during `dispatch` (e.g. `runPrompt` throwing before any retry logic engages, or a bug in the sink) results in silent drops with no admin visibility. Combined with #11 it means some failure modes flip binding status while others don't.
- **Fix**: Set binding status to `error` (with a short reason) whenever `dispatch` rejects unexpectedly; drop the catch-all silent path.

---

### 17. LOW — `admit()` filter is weak on `mentionsBot` — any adapter that reports `mentionsBot=true` bypasses group filtering

- **Where**: `channels/router.ts:66-77`.
- **What**: Well-formed adapters must not lie, but there is no host-side validation. A misconfigured/misimplemented adapter (see `plugins.md` §13 mutual-trust) could route every group message to the agent. Since it's a trust-model choice, this is a NIT — but worth documenting that group @mention detection is entirely adapter-supplied.
- **Fix**: Comment noting that host relies on adapter honesty, and add a metrics counter for `admit` vs `drop` per binding so operators can spot runaway inbound rates.

---

### 18. LOW — `channels/sessions.ts` picks fallback owner "first user in `users`" without ordering guarantees

- **Where**: `channels/sessions.ts:88-101`.
- **What**: `ORDER BY created_at ASC LIMIT 1`; but `created_at` is `Date.now()` which can collide (sub-ms) or move backward if system clock is adjusted. Compounded by Finding #5, the deterministic fallback becomes user-visible.
- **Fix**: Add `ORDER BY created_at ASC, id ASC` for deterministic ordering; but ultimately prefer Finding #5's "don't fall back at all" resolution.

---

### 19. LOW — Redacted secret marker uses `set: boolean`; leaks empty-vs-set distinction unnecessarily

- **Where**: `core/plugins/secrets.ts:194-205`, consumer at `plugins-routes.ts:723-726`.
- **What**: Sending `{ __secret: true, set: true }` in the JSON response tells the browser whether a secret is configured. Fine for admins; leaks to any user who can PATCH the plugin (per Finding #8). Combined with the wide read surface, a non-admin user can enumerate which plugins have credentials configured.
- **Fix**: Only include the `set` bit when the request comes from a user with edit permission on that plugin — or once #8 is fixed the point is moot.

---

### 20. LOW — `applyPluginSecretPatch` treats empty string as "leave alone"; documented but easy to misuse

- **Where**: `core/plugins/secrets.ts:116-119`.
- **What**: Comment says empty string is a no-op so bulk saves don't wipe existing secrets. But this makes it impossible to distinguish "user meant to unset via typing empty" from "form default". The explicit `{ __secret: true, clear: true }` handshake covers the explicit case but a form bug could silently keep a stale secret alive.
- **Fix**: Log a debug line when the patch sees an empty string for a secret key with an existing value, so drift is spottable.

---

### 21. NIT — `channelHub` throws on duplicate `bindingId` register (`hub.ts:41`) but callers use `.catch(() => {})`

- **Where**: `channels/hub.ts:41`, `channels/adapter-manager.ts:120` (register) and `index.ts:296` (`stopBinding.catch(() => {})`).
- **What**: The idempotency comment in `startBinding` (`adapter-manager.ts:88-92`) says "already running — treat as no-op" but the hub `.register` still throws on duplicates; the code relies on `this.active.has(bindingId)` check preceding it. This is correct today but fragile: any race in the manager (two concurrent `startBinding(id)` calls) will bypass the has-check and throw inside register. Consider adding a proper mutex or making `register` idempotent for the same `(bindingId, adapter)` pair.

---

### 22. NIT — `parseUserEntry` `prefix` accepts empty string and truncates to 32 chars silently

- **Where**: `plugins-routes.ts:778-780`.
- **What**: Silent truncation of user-supplied string with no error message; also allows empty `prefix` which then gets fed into `McpToolset` as an empty string (`core/mcp-manager.ts:152` — `prefix: e.prefix ?? \`${e.id}_\`` — but `??` doesn't catch empty string, so an empty prefix bypasses the default). Tool names would collide with unprefixed host tools.
- **Fix**: `if (typeof r.prefix === "string" && r.prefix.length > 0) entry.prefix = r.prefix.slice(0, 32);` and validate character set.

---

## Notes on things that look OK

- Tenant middleware mount order in `index.ts:659-663` correctly places `/api/health` before it and `/api/*` after. The OpenCode proxy at `index.ts:625` is legitimately mounted before because it has its own token-based auth.
- Plugin route dispatch (`plugins-routes.ts:139-190`) always calls `registry.ensureForTenant(req.ctx.tenant)` first, so a request for a plugin not enabled in the caller's tenant returns 404 — no cross-tenant plugin route leakage.
- Secret files use mode 0600 with atomic tmp+rename (`core/plugins/secrets.ts:63-70`). Directory mode 0700 comes from `getTenantSecretsDir`. Correct.
- `PLUGIN_ID_RE` validation (`plugins-routes.ts:29`) is applied at both plugin-route dispatch and PATCH, preventing path-traversal via URL.
- `channelHub.register` binds `bindingId + tenantId` at register-time so the router's `envelope.tenantId` is not spoofable by the adapter — good.
- Channel-binding delete correctly cascades to sessions + messages inside a transaction (`index.ts:344-370`) with tenant/owner precheck.

---

## Top 3 to fix first

1. **Finding #1** — `PUT /api/admin/models/providers` reachable by any tenant user, writes global config, cross-tenant impact. Gate on admin role or restrict to dev tenant immediately.
2. **Finding #2** — MCP `POST/PATCH /mcp/servers` accepts arbitrary URLs → in-process SSRF via config from any tenant user. Add loopback/private/metadata denylist and validate `upstreamHost` format.
3. **Finding #3** — `broadcastToUser` not tenant-scoped. Rekey by `(tenantId, userId)` before any deployment where user IDs can collide across tenants; combined with #4 it is the mechanism by which the idle-runner tenant-scan bug becomes a real cross-tenant message leak.
