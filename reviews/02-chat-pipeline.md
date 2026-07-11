# Code Review — Chat Pipeline

Scope: `packages/server/src/chat/{handler.ts, agent-loop.ts, compact.ts,
messages.ts, sqlite-session-storage.ts, sqlite-session-repo.ts,
session-inbox.ts, ws-protocol.ts}` and `packages/server/src/core/{model-retry.ts,
pi-models.ts}`. Focused on the 0.4.72→0.4.80 retry-resilience feature.

Repo: `/Users/yuyu/git/tianshu_opensource` (read-only).

---

## Findings

### 1. HIGH — Retry replay pushes a duplicate `start` event to the harness on pre-content failures
**File**: `packages/server/src/core/model-retry.ts:653–671, 692–698`

**What**: `wrapStreamFn` only swallows the fresh `start` event when
`replayingAfterContent` is true (line 664: `if (ev.type === "start" &&
replayingAfterContent) continue;`). `replayingAfterContent` is only flipped
when `sawContent` was true (line 692). But `start` is emitted at the head of
*every* attempt. If attempt #1 pushes `start` and then fails before any content
(e.g. 429 during headers, 401, socket reset before first `text_start`),
`sawContent` stays false, `replayingAfterContent` stays false, and attempt #2
pushes `start` again — the passthrough stream `out` ends up with
`[start, start, …]` and, on N total attempts before success, up to N `start`
events.

**Why**: pi-ai's `start` event is the AssistantMessage lifecycle marker
(see `isContentEvent` comment at 470). Harness consumers ordinarily use it to
initialise a message slot; forwarding it twice risks a duplicate assistant row
or a stale in-flight message being overwritten mid-turn — the very shape of
bug the "keep a single message slot" comment is defending against. Even if
pi-agent-core happens to be idempotent today, the guard promises invariants
it does not enforce.

**Fix**: track whether the passthrough has already forwarded a `start`, and
skip subsequent `start`s unconditionally:

```ts
let startForwarded = false;
…
if (ev.type === "start") {
  if (startForwarded) continue;
  startForwarded = true;
}
out.push(ev);
```

Drop `replayingAfterContent` from the `start`-swallow condition (keep it for
the client-side reset notice).

---

### 2. HIGH — `retry` on the WebSocket aborts but does not await the previous `runPrompt`; races against `takeResumableUserPrompt`
**File**: `packages/server/src/chat/handler.ts:264–277, 304–324, 807–813,
1274–1358`

**What**: Every `"prompt"` / `"retry"` / `"abort"` client message runs
`aborter.abort()` and *immediately* fires the next `runPrompt(…)` (fire-and-forget;
nothing awaits the previous promise chain). The previous handler is still
inside `harness.waitForIdle()` / `finally` / `maybeAutoCompact()` when the new
one begins. In the retry path this is worse: the new call synchronously runs
`takeResumableUserPrompt(ctx, session.id)` which deletes rows and re-points
`sessions.leaf_id` while the previous `harness` may still be persisting the
tail of the aborted turn via `SqliteSessionStorage.appendEntry` (which also
writes `leaf_id`, line 197 of sqlite-session-storage.ts).

**Why**:
- Two concurrent `runPrompt` invocations share the same session id → both
  register with `registerActiveHarness` (only the last wins), both call
  `maybeAutoCompact` on overlapping branches, both may attempt to
  `send({type:"stream_end", …})` for the socket.
- The `takeResumableUserPrompt` transaction (handler.ts:1341–1352) deletes
  the trailing rows and rewrites `leaf_id`. If the old harness's
  `appendEntry` for the aborted partial races the DELETE, the row may end up
  orphaned (deleted, then re-INSERTed with a `parent_id` pointing at a row
  we just removed) or leaf_id ping-pongs.
- `maybeAutoCompact()` runs after the finally block; on the aborted old run
  it can still fire an LLM call for compaction against a session the new run
  is now driving.

**Fix**: keep a per-socket promise handle; on `retry`/`prompt`, `await` the
previous run's settle (or explicit cleanup) before starting the next.
Something like:

```ts
let inflight: Promise<void> | null = null;
async function replace(next: () => Promise<void>) {
  aborter?.abort();
  const prev = inflight;
  aborter = new AbortController();
  inflight = (async () => {
    if (prev) { try { await prev; } catch { /* swallow */ } }
    await next();
  })();
}
```

At minimum, wrap `takeResumableUserPrompt` in a mutex keyed on session id.

---

### 3. HIGH — Retry silently no-ops when the failing turn is a mid-agent LLM call (post-tool_result)
**File**: `packages/server/src/chat/handler.ts:1274–1358`, esp. 1305–1339

**What**: `takeResumableUserPrompt` walks newest → oldest, treats the first
non-failed, non-empty **assistant** row as the completion boundary, and only
resumes if it saw a `user` row in the trailing failed segment. But a common
failure shape in an agent run looks like

```
[user Q]
[assistant toolUse]     ← stopReason: "toolUse"
[tool tool_result]
[assistant partial]     ← stopReason: "error"   (this is the mid-run LLM failure)
```

The scan sees the partial → toDelete; the tool_result → toDelete (`row.role`
is `"tool"`); then the toolUse assistant → **boundary** (`content` non-empty,
`assistantRowFailed` returns false for `stopReason: "toolUse"`). `userText`
stays `null` because there was no user row between the boundary and the tail.
`takeResumableUserPrompt` returns `null`.

`runPrompt` then hits `throw new HandledTurnAbort()` (handler.ts:809), the
outer catch treats it as an intentional bail, the finally emits a synthetic
`stream_end` — the client hides its retry banner and thinks the turn
finished, even though the user's request was never answered.

**Why**: The retry-resilience feature was justified in part by "terminated
mid-sentence" cases the retry watchdog kicks. Multi-turn agent runs are
exactly where those long streams live; the client's auto-retry loop targets
this scenario, but the server silently discards it.

**Fix**: either (a) fall back to `harness.continue()` semantics when the
trailing failed turn contains a `tool_result` (i.e. the user prompt happened
several turns ago and doesn't need re-inserting), or (b) walk back further —
past the `toolUse` boundary — until a `user` row is found, delete the entire
mid-agent scaffolding, and re-prompt. (a) is safer and aligns with the
retry `ClientMsg` doc-comment which mentions "resume it via
`harness.continue()`".

---

### 4. HIGH — Retry drops attachments/images from the original user message
**File**: `packages/server/src/chat/handler.ts:801–813`, `ws-protocol.ts:67`

**What**: The `"retry"` WS message has no `attachments` field (ws-protocol.ts:67).
`prepareUserInput` is fed `content=""` and `attachments=undefined`
(handler.ts:314–320), so `images` is `[]` and `originalAttachments` is `[]`.
The old user row (which carried the images inlined and had
`attachments[]` spliced onto it) is deleted by `takeResumableUserPrompt`,
and the new `harness.prompt(resume, undefined)` call re-persists the user
row *without* attachments. Storage's `pendingUserAttachments` isn't set
(it was only wired for the non-retry branch, line 578–583).

**Why**: User attaches an image, network drops mid-stream, client auto-retries
→ retry succeeds but the model receives the prompt text with **no image**.
The client's UI still shows the attachment chip because it never got a fresh
`message_added` deleting the old attachment metadata, so the discrepancy is
silent.

**Fix**: before deletion, read the aborted user row and preserve its
`attachments[]` and any `{type:"image"}` content blocks. Re-populate
`storage.pendingUserAttachments` and pass `images` to `harness.prompt`.
`extractUserText` can be generalised to `extractUserPayload` returning
`{ text, images, attachments }`.

---

### 5. HIGH — User abort spawns a full session-recovery agent every time
**File**: `packages/server/src/chat/handler.ts:817–870`

**What**: The catch block after `harness.prompt/waitForIdle` only special-cases
`HandledTurnAbort`. For any other thrown error — including the `AbortError`
that `harness.abort()` raises on a user-stop — it (a) sends `stream_error`
and (b) `spawnSessionRecovery(...)`. Dedupe is claimed to live inside
`spawnSessionRecovery` but the outer callsite still `await import(…)`s the
module, builds a full trigger payload, and calls it for every stop. There
is no `signal.aborted` check.

**Why**: Recovery spawns are expensive (fresh isolated agent session,
tool loop, LLM budget). A user hammering the Stop button, or a socket
churn during reconnects, kicks a recovery every time. Even if the recovery
dedupes internally, the cost of `import()` + payload construction + IPC is
non-zero and pollutes admin/task views with bogus "session recovery" runs.

**Fix**: gate recovery on `!signal.aborted && !isAbortErr(err)`:

```ts
const isAbort = signal.aborted ||
  (err instanceof Error && /abort|cancel/i.test(err.name + err.message));
if (!isAbort && pluginRegistry) { … spawnSessionRecovery … }
```

---

### 6. MEDIUM — `retryCompletion` (compact path) ignores AbortSignal and misclassifies user abort as retriable
**File**: `packages/server/src/core/model-retry.ts:770–815`,
`packages/server/src/chat/compact.ts:139–166`

**What**: `retryCompletion` accepts no `signal`; the internal `await sleep(delay)`
call is unsignallable (line 811). `completeSimple` *is* called with the outer
`signal` (compact.ts:161), so an abort during the LLM call throws — but
`classifyError` looks at the error text; typical AbortError messages contain
the substring `"aborted"` which is in `NETWORK_HINTS` (model-retry.ts:395),
so it is marked `retriable=true, kind="network"`. The loop then sleeps and
retries up to `maxAttempts`. Net effect: a user abort during
`/compact` (manual or auto) fires an additional 3 LLM calls in the background
with a 5–20 s gap between them before finally giving up.

**Why**: The streaming wrapper checks `signal?.aborted` before backoff
(model-retry.ts:701–704); `retryCompletion` does not, so the two layers
behave inconsistently.

**Fix**: plumb `signal` into `retryCompletion` (and into `summarise` /
`compactSession`) and short-circuit both around `sleep` and at the top of
each iteration. Alternatively, in `classifyError`, check
`err instanceof DOMException && err.name === "AbortError"` first and return
`retriable: false`.

---

### 7. MEDIUM — Client can't tell abort-during-backoff from provider error
**File**: `packages/server/src/core/model-retry.ts:713–718` (streaming wrapper)

**What**: If the outer signal aborts while the retry wrapper is sleeping
between attempts:

```ts
try {
  await sleep(delay, signal);
} catch {
  failStream(out, err);        // err is the PREVIOUS attempt's error
  return;
}
```

`err` is the last provider error, not an AbortError. The client sees
`stream_error` reason "http-429 (rate limit)" or "network" even though the
turn ended because the user pressed Stop. This shortens the retry banner
lifecycle (chat-store's auto-retry re-arms because the reason isn't "abort")
and produces confusing UX.

**Fix**: in the catch, prefer the AbortError over the last provider error:

```ts
} catch (abortErr) {
  failStream(out, signal?.aborted ? abortErr : err);
  return;
}
```

Also consider emitting a synthetic `{stopReason:"aborted"}` AssistantMessage
so `agent_end` doesn't paint it as `stopReason:"error"` upstream.

---

### 8. MEDIUM — `NETWORK_HINTS` / `extractStatus` string-matching is over-eager
**File**: `packages/server/src/core/model-retry.ts:365–378, 395–412`

**What**: `extractStatus` falls back to scraping the error message for
`\b(4\d\d|5\d\d)\b`. Many benign strings contain such three-digit chunks
(request-ids, timestamps, cost figures, port numbers). Similarly, `"aborted"`
is in `NETWORK_HINTS`, so any error whose message *includes* the word
"aborted" — user abort, `AbortSignal` from a plugin timeout, an SSE parser
saying "…stream aborted mid-frame" — is classified as a retriable network
blip. Interacts with #6 (compact retry treating user abort as network).

**Fix**: (a) prefer structured `.status` / `.statusCode` from the error
object; only scrape as a last resort and require that the regex match a
context like "HTTP 429" / "status: 429" instead of a bare number. (b) Split
`"aborted"` out of `NETWORK_HINTS` and handle it via an explicit
`isAbortError()` predicate that returns `retriable=false`.

---

### 9. MEDIUM — Duplicate assistant rows never re-broadcast on aborted-then-retried turns
**File**: `packages/server/src/chat/sqlite-session-storage.ts:171–207`,
`packages/server/src/chat/handler.ts:1274–1352`

**What**: `takeResumableUserPrompt` deletes `messages` rows for the trailing
failed turn but does NOT delete `session_inbox` rows that were marked
`delivered` when that turn's user message was persisted
(`markDeliveredFromMessage`, handler.ts:1109–1119). If the delivered turn
gets rolled back (rows deleted), the inbox marker is stuck at `delivered`
and the corresponding inbox notification is silently lost. The
tentative-drain + confirm design was introduced to avoid exactly this class
of loss for the harness followUp path; the retry path bypasses it.

**Why**: A worker completes → enqueues inbox → live harness followUp
succeeds → `bridgeHarnessEventToWs` runs `markDeliveredFromMessage` on the
user row → turn errors mid-stream → user hits retry → `takeResumableUserPrompt`
deletes the user row that contained the `<inbox …>` markers. The row is
gone and `session_inbox` shows `delivered`, so the next turn does not
re-inject the notification. The worker's status was already visible in the
task kanban, but the agent never *sees* it happened.

**Fix**: on retry-time delete, scan the rows-to-delete for `<inbox …>`
markers and re-mark those inbox ids `pending`, or record the deleted rows'
inbox-ids and re-enqueue on next drain.

---

### 10. MEDIUM — `assistantRowFailed` guard is effectively `stopReason` only; the "content non-empty" clause is dead code for structured rows
**File**: `packages/server/src/chat/handler.ts:1305, 1390–1397`

**What**: The scan at line 1305 requires `row.content.trim().length > 0
&& !assistantRowFailed(row.content)`. Since every non-legacy assistant row
is a JSON string (`{"role":"assistant",…}`), `content.trim().length > 0` is
tautologically true for structured rows. The intent was to exclude
"tool-only, content-less" replies — but a tool-only assistant with
`stopReason: "toolUse"` and an empty text array still has non-empty JSON
content, so it becomes a boundary even when the intent was to keep walking.
Interacts with #3.

**Fix**: parse once and derive `hasVisibleText` from the AssistantMessage:

```ts
function isCompletedReply(content: string): boolean {
  const parsed = safeParse(content);
  if (!parsed || parsed.role !== "assistant") return content.trim().length > 0;
  const sr = parsed.stopReason;
  if (sr === "error" || sr === "aborted") return false;
  // Treat toolUse as still an in-flight boundary IF no tool_result follows.
  // (Caller should have already decided that by looking at the tail.)
  const hasText = Array.isArray(parsed.content) &&
    parsed.content.some(c => c.type === "text" && (c.text ?? "").trim());
  return hasText || sr === "toolUse";
}
```

---

### 11. MEDIUM — `retryLastTurn` fires `stream_start` before checking there is anything to resume
**File**: `packages/server/src/chat/handler.ts:588, 807–811`

**What**: `send({ type: "stream_start" })` is emitted at line 588,
unconditionally, before the retry-branch checks `takeResumableUserPrompt`.
If nothing is resumable, we throw `HandledTurnAbort` and finally emit a
synthetic empty `stream_end`. The user sees a brief flicker of the
"thinking…" placeholder for nothing. Worse, the client's watchdog (chat-store
line 692, `RETRY_WATCHDOG_MS`) may have already been cleared by `stream_start`,
so any subsequent quiet failure (e.g. socket drops between the synthetic
`stream_end` and the client processing it) leaves the retry loop believing
the retry succeeded.

**Fix**: on the retry path, defer `stream_start` until after `resume !== null`
is confirmed. Or, drop `stream_start` entirely for retry (the client can
key off `model_retry` or `stream_delta`).

---

### 12. MEDIUM — Auto-compact in worker loop increments `assistantTurns` for its own compaction LLM call
**File**: `packages/server/src/chat/agent-loop.ts:405–447`

**What**: `harness.subscribe(...)` counts `turn_end` events into
`assistantTurns` and resets the watchdog. `tryAutoCompact` calls
`harness.compact()`, which itself runs an LLM turn — that fires a
`turn_end`. The `compactInFlight` guard prevents re-entrant compact triggers,
but doesn't stop the counter from ticking. Result: `result.turns` reports
+1 per compact, and the watchdog "idle" timer is spuriously reset by
compaction activity so a stalled outer loop can hide behind an active
inner compact. `first_response_timeout` is likely fine (compact runs mid-loop,
not before response), but `idle_timeout` semantics are wrong.

**Fix**: filter compact-driven events out of the watchdog reset (e.g. set
`insideCompact = true` around the `tryAutoCompact` call and gate
`lastEventAt = Date.now()` on that flag).

---

### 13. MEDIUM — Session-inbox delivery race: `harness.followUp` succeeded but turn fails before pi consumes it
**File**: `packages/server/src/chat/session-inbox.ts:239–275`

**What**: The comment at line 254–261 acknowledges the failure mode ("provider
terminated, abort, network blip"). With the new retry-resilience layer, this
window is *larger*: the retry loop may re-invoke `stream()` several times
before finally failing, and during retries the followUp text sits pinned in
the harness's internal followUp queue while pi hasn't yet consumed it. If
the whole turn ultimately errors, the followUp is discarded. The current
comment says rows are safe because they stay `pending` — but the DB row is
actually re-INSERT-updated to `delivered` inside
`markDeliveredFromMessage` **only if the user message actually got
persisted**. If the failing turn never fires `message_end` for the user
role, the row stays `pending` (good) — but if the retry succeeds and pi
persists the user message on the *second* attempt, `markDeliveredFromMessage`
runs, and rows are marked delivered without ever having been seen by the
model on the *first* attempt (which we don't care about). Net: safe today,
but this cross-cutting reasoning is fragile.

**Recommendation**: add an integration test that pins down the invariant:
"a followUp message becomes `delivered` iff its content is present in the
pi-persisted user message that the LLM saw as input on a successful turn"
— exercise it under retryAfterContent=true.

---

### 14. LOW — `sessions.leaf_id` update in `SqliteSessionStorage.appendEntry` is not atomic with the row INSERT
**File**: `packages/server/src/chat/sqlite-session-storage.ts:171–207`

**What**: The INSERT and the `setLeafId` are two SQL statements, no
transaction. `better-sqlite3` is single-threaded so this is fine per
call, but combined with #2 (concurrent runPrompt) a leaf pointer can
briefly point at a row from the losing writer. Wrap in a
`db.transaction(() => { … })` for defence in depth.

---

### 15. LOW — `retryAfterContent: true` default replays entire response after mid-stream failure
**File**: `packages/server/src/core/model-retry.ts:105–108`

**What**: The default is documented as "retry mid-stream failures … by
re-running the whole call and rebuilding the message". This is correct for
text-only replies but re-spends tokens (potentially large) and can produce
divergent responses between attempts (the second attempt with the same
prompt is not deterministic even at temperature=0 for many providers,
especially when tool calls are involved). The `stream_reset` on the wire
handles the text case; interaction with in-progress tool_call streaming
(where `toolcall_start`/`toolcall_delta` are content) can produce
different tool call ids on the retry — the outstanding-tool-call bookkeeping
in handler.ts doesn't clean up chips from the aborted half.

**Fix**: on `contentStreamed && retry`, also clear
`outstandingToolCalls` and emit synthetic `tool_result` events for any
in-flight tool call chips before the replay starts. Consider making
`retryAfterContent` opt-in for tool-heavy sessions.

---

### 16. LOW — `emitRetry` mutates the `notice` argument
**File**: `packages/server/src/core/model-retry.ts:594–609`

**What**: `notice.message = retryMessage(notice);` mutates the caller's
object literal. Harmless today because every caller freshly constructs the
notice, but if a future refactor pre-builds notices this creates surprising
mutation. Return a new `Readonly<RetryNotice>` instead.

---

### 17. LOW — `NETWORK_HINTS` includes both "timeout" and "socket hang up" but not "econnreset" (as bare token)
**File**: `packages/server/src/core/model-retry.ts:352–360`

**What**: The current list has `"econnreset"` — good. But
`"and retry after"` (Anthropic) / `"upstream connect error"` (Envoy) /
`"context deadline exceeded"` (Go proxies) are common in tenant deployments
and not covered. Consider expanding after validating on real logs.

---

### 18. LOW — `takeResumableUserPrompt` does not verify the session belongs to the requesting user
**File**: `packages/server/src/chat/handler.ts:1274–1358`

**What**: The function accepts any `sessionId` and deletes rows / rewrites
`leaf_id` without a `user_id` guard. Callsites currently pass
`session.id` derived from `ensureActiveSession(ctx, userId)`, so the
authorization exists one level up — but the helper is a foot-gun for a
future callsite that trusts a session id from the wire. Add a `userId`
argument and enforce `WHERE session_id = ? AND user_id = ?`.

---

### 19. LOW — Compact fallback (`runOverWindowForkFallback`) writes to sessions the abandoned harness may still reference
**File**: `packages/server/src/chat/handler.ts:1450–1500`

**What**: If pre-prompt compact returns `nothing_to_compact` and the fork
fallback runs, we mutate the current `session` row (`status='compacted'`)
and create a new one, then `runPrompt({… session: undefined,
_afterCompactFallback: true})`. The abandoned harness / storage tied to the
old session is unsubscribed and unregistered *before* the recursive call
(good), but its `piSession` object still holds a reference to the same
`SqliteSessionStorage` — a stray subscriber or unresolved awaited work
could still see the "compacted" status. Add a defensive `harness.abort()`
between unregister and the recursive call.

---

### 20. NIT — Comments claim "clamp maxAttempts to [1, DEFAULTS]" but the clamp uses `min=1` and `fallback=DEFAULTS`
**File**: `packages/server/src/core/model-retry.ts:139–142`

`clampInt(cfg.maxAttempts, 1, DEFAULTS.maxAttempts)` — if the user passes
`maxAttempts=1000` the function returns `1000` (not the default cap of 4).
The comment implies a clamp; the code implements a floor + fallback. Either
add an upper bound or fix the comment.

---

## Top 3 to Fix First

1. **#2 (HIGH) — race between `retry` and previous `runPrompt`.**
   `takeResumableUserPrompt` can delete/rewrite rows the old harness is
   still writing. Every subsequent race-driven bug (orphan inbox markers,
   duplicate leaf pointers, doubled `message_added`) traces back here.
   Serialize per-socket run promises, or at minimum lock the resume path
   on the session id.

2. **#3 (HIGH) — retry silently no-ops on mid-agent LLM failures.**
   The most common failure the retry-resilience feature exists to handle
   (long agent runs with a mid-stream provider drop after a tool call)
   is exactly the case `takeResumableUserPrompt` refuses to resume.
   Users see "silence" and the client thinks the turn ended cleanly.

3. **#1 (HIGH) — duplicate `start` events on any pre-content retry.**
   The current `replayingAfterContent` guard misses pre-content retries;
   this is the most likely path in production (401/429/DNS blips before
   any bytes stream). Cheap fix, high protection value.

Runner-up (would be #4): **#4 (HIGH) — retries drop attachments**.
Small change, immediate user-visible correctness win once #2 is fixed.

---

## Summary (10 lines)

1. Retry-resilience is well-scoped and layered cleanly at the pi-ai stream chokepoint; policy is centralised in `wrapStreamFn` / `retryCompletion`, and rate-limit / auth handling is unusually thorough (Retry-After, x-ratelimit-*, Gemini retryDelay, JWT re-resolve).
2. The retry state-machine has one silent-loss bug (mid-agent failure past a tool_result returns null from `takeResumableUserPrompt` and the client thinks the turn finished — #3, HIGH).
3. It has one dedupe bug (pre-content retries push a second `start` event to the harness — #1, HIGH).
4. It has one race bug (concurrent `runPrompt` on `retry` collides with `takeResumableUserPrompt` and `leaf_id` — #2, HIGH).
5. Retries drop the user's attachments/images because the `retry` wire message has no attachments field and the server re-prompts with empty `images[]` (#4, HIGH).
6. Every user Stop that unwinds via harness abort spawns a session-recovery agent (#5, HIGH) — noisy, wasteful, likely already producing bogus admin entries.
7. Compact retry loop (`retryCompletion`) ignores AbortSignal and treats user aborts as "network" errors due to substring matching — three extra LLM calls after Stop (#6/#8, MEDIUM).
8. Aborted-during-backoff surfaces the previous provider error to the UI instead of an AbortError (#7, MEDIUM); client's auto-retry keeps climbing.
9. Session-inbox row markers can be orphaned when retry deletes the user row that carried them (#9, MEDIUM); worker notifications silently vanish from the agent's view.
10. Storage-layer atomicity (`leaf_id` update not in a transaction with the INSERT — #14, LOW) and the completion-boundary heuristic in `takeResumableUserPrompt` (#10, MEDIUM) are latent hazards that will bite as soon as any of the HIGH races above land in production.
