# pi-ai / pi-agent-core 0.79 → 0.80 migration (implementation brief)

> Status: **DONE** (branch `feat/pi-080-migration`). Tracks GitHub
> issue #260. Smoke-tested end-to-end against real providers
> (openai-completions + anthropic-messages via the local SAP proxy):
> multi-turn chat, structured tool-call round-trip, and
> `harness.compact()` all green on 0.80.2.

## TL;DR — the original probe was WRONG; it's close to #260's estimate

⚠️ An earlier draft of this plan (below, struck through) claimed
0.80 **renamed** `AgentHarness` → `Agent` and **removed**
`compact()`. Re-probing 0.80.2's actual `.d.ts` shows that is
**false**:

- 0.80 still exports `AgentHarness` from
  `pi-agent-core/harness/agent-harness` — it is NOT renamed.
  `Agent` is a *new, lower-level* loop wrapper added alongside it;
  we do not use it.
- `AgentHarness.compact()` is **still there**, unchanged. So is
  `on()`, `subscribe()`, `env`, `session`, `tools`, `systemPrompt`,
  `prompt()`, `navigateTree()`, etc. No compaction re-home needed.
- The ONLY breaking change to `AgentHarness` between 0.79 and 0.80
  is the constructor: the `getApiKeyAndHeaders` option is removed
  and replaced by a required `models: Models` field. The harness
  now drives requests through `models.streamSimple(...)` and
  resolves auth via the provider's `auth.apiKey.resolve()`.

So the real migration is:

1. Bump deps to `^0.80.2`.
2. 3 `complete*` imports → `@earendil-works/pi-ai/compat` (the
   global dispatch API moved behind `/compat`; `{apiKey}` option
   still works). compat self-registers the builtin API impls on
   import.
3. Build a one-line-per-site `Models` instance (new
   `core/pi-models.ts:buildModels(piModel, apiKey)`) and pass it as
   `models:` to the two `new AgentHarness({...})` sites
   (handler.ts + agent-loop.ts), dropping `getApiKeyAndHeaders`.

`compact-decision.ts` / `tryAutoCompact` / the pre-prompt compact in
handler.ts all keep calling `harness.compact()` unchanged.

### What `buildModels()` does

`createModels()` + `setProvider(createProvider({ id, auth:{ apiKey:{
resolve: () => ({ auth:{ apiKey } }) } }, models:[piModel], api:
getApiProvider(piModel.api) }))`. The custom api-key auth hands the
harness tianshu's already-resolved per-tenant key; the wire-level
streaming reuses the builtin api impls from the `/compat`
api-registry (same dispatch table 0.79's global `stream()` used).
Built per chat run, matching the old per-run `getApiKeyAndHeaders`
lifetime — no global mutable state, no cross-tenant leakage.

---

## ⚠️ ORIGINAL (INACCURATE) PROBE — kept for the record

~~Issue #260 says it's "3 easy compat imports + 2
getApiKeyAndHeaders sites". After probing 0.80.2 against the real
.d.ts files, it is bigger:~~ **(This was a misread — see above.)**

1. ~~`AgentHarness` is **renamed to `Agent`**~~ — FALSE.
2. ~~**`Agent` has no `compact()`**~~ — N/A; we keep `AgentHarness`,
   which still has `compact()`.
3. The 3 `complete*` imports → `@earendil-works/pi-ai/compat`
   (this part was correct).

## 0.80 API shape (probed from 0.80.2 .d.ts)

### pi-ai: Models / Provider (replaces the global singleton)

```ts
import { createModels, createProvider } from "@earendil-works/pi-ai";
// createModels(options?: { credentials?; authContext? }): MutableModels
// MutableModels.setProvider(provider) / deleteProvider(id) / clearProviders()
// createProvider({ id, name?, baseUrl?, headers?, auth, models, api, refreshModels? }): Provider
```

- `Provider.auth` is a `ProviderAuth` (apiKey or oauth). For an
  api-key provider, auth.resolve() reports configured-ness and
  yields an `AuthResult`. Our tenant config has the raw apiKey,
  so we build an api-key ProviderAuth from it.
- `Models.stream(model, ctx, opts)` / `.complete(...)` /
  `.streamSimple(...)` — the per-instance equivalents of the old
  globals. `Models.getAuth(model)` resolves request auth.
- `hasApi(model, api)` narrows a dynamically looked-up model.

### pi-agent-core: Agent (replaces AgentHarness)

```ts
import { Agent } from "@earendil-works/pi-agent-core"; // was AgentHarness
new Agent({
  streamFn,            // (replaces getApiKeyAndHeaders) — wire to Models.stream
  getApiKey,           // (provider) => string | undefined
  sessionId,
  toolExecution, steeringMode, followUpMode,
  beforeToolCall, afterToolCall, prepareNextTurn,
  convertToLlm, transformContext, onPayload, onResponse,
  thinkingBudgets, transport, maxRetryDelayMs,
})
```

Method surface that tianshu uses is mostly PRESERVED on Agent:
`subscribe()`, `steer()`, `followUp()`, `abort()`,
`waitForIdle()`, `prompt(text, images?)` / `prompt(messages)`.

**GONE on Agent: `compact()`.** This is the sharp edge.

## Where tianshu leans on the old API (current main)

| File | Old usage | 0.80 change |
| --- | --- | --- |
| `chat/compact.ts` | `import { completeSimple } from "pi-ai"` | → `pi-ai/compat` (easy) |
| `setup/cli-agent.ts` | `import { complete }` + `complete(model, ctx, {apiKey})` | → `pi-ai/compat`; apiKey arg path may change |
| `setup/probe-default-model.ts` | `import { completeSimple }` + `(model, ctx, {apiKey})` | → `pi-ai/compat` |
| `chat/agent-loop.ts` | `new AgentHarness({ getApiKeyAndHeaders })` + harness.* | → `new Agent({ streamFn, getApiKey })`; rewire stream |
| `chat/handler.ts` | `new AgentHarness({ getApiKeyAndHeaders })` + harness.* + auto-compact | → same Agent rewire; **replace harness.compact()** |
| `chat/compact-decision.ts` | `harness.compact()` via `tryAutoCompact` | **needs a compact replacement** |
| anywhere importing `AgentHarness` type | type rename | → `Agent` |

Grep before starting:
`grep -rn "AgentHarness\|getApiKeyAndHeaders\|harness.compact\|from \"@earendil-works/pi-ai\"" packages/server/src`

## Migration steps

1. **Bump deps** to `^0.80.2` in root + packages/server
   package.json. (Currently pinned `^0.79.3`.)
2. **Easy imports**: point the 3 `complete*` imports at
   `@earendil-works/pi-ai/compat`. Verify the `{apiKey}` option
   still works there (compat keeps env-key injection; may need
   to pass the key differently).
3. **Models construction**: add a helper (e.g.
   `core/pi-models.ts`) that builds a `Models` instance for a
   resolved tenant model: createModels() + setProvider(
   createProvider({ id, auth: apiKeyAuth(key), models:[model],
   api })). Decide scope: per-chat-run is simplest + safest
   (matches today's per-run apiKey resolution).
4. **Agent rewire** (agent-loop.ts + handler.ts):
   - `new AgentHarness({...getApiKeyAndHeaders})` →
     `new Agent({ streamFn: (model,ctx,opts)=>models.stream(...),
     getApiKey })`.
   - Keep subscribe/steer/followUp/abort/waitForIdle/prompt as-is
     (names preserved).
   - Rename the `AgentHarness` type to `Agent` everywhere.
5. **Compaction** — the hard part. `Agent` has no compact().
   Options:
   a. Check whether 0.80 exposes compaction elsewhere (a
      standalone fn / a different module) — re-probe the 0.80
      d.ts for "compact" across all files; the harness method may
      have moved to a free function.
   b. If truly gone: tianshu's compact.ts already has its own
      summarisation path (compactSession for manual /compact).
      Re-home auto-compact onto that instead of harness.compact()
      — i.e. tryAutoCompact calls our own summariser, not pi's.
      This also fixes the "0 summarised / 0 kept" UI lie (we'd
      then know the counts).
6. **Smoke test** end to end on at least one real provider
   (Anthropic + OpenAI ideally): a multi-turn chat, a tool call,
   an auto-compact trigger (long history), a worker run.
7. Close #251 / #252; unpin once green; bring to latest 0.80.x.

## Risk / sequencing

- Touches the core chat + worker LLM path. A half-migration goes
  red on the first real turn. Do it whole, behind a branch, with
  smoke tests — do NOT merge on green CI alone (CI has no real
  provider).
- The compaction re-home (step 5b) is arguably a WIN: it removes
  the dependency on pi's opaque compact() and lets us report real
  summarised/kept counts (fixing the misleading auto-compact
  badge Yu noticed on 2026-06-30).

## Refs

- issue #260, dependabot #251 / #252
- 0.80 probed locally at /tmp/pi-probe (0.80.2) — re-probe fresh.
- pi-ai 0.80 release notes: github.com/earendil-works/pi/releases
