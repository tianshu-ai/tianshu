// Tests for the LLM stream resilience wrapper.
//
// Focus areas that would silently break users:
//   * correct error classification (retriable vs terminal, auth flag)
//   * retry only BEFORE content streams (never duplicate output)
//   * backoff honours Retry-After and the jitter/cap bounds
//   * auth failures trigger apiKey re-resolution
//   * abort short-circuits retries

import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import {
  classifyError,
  backoffDelayMs,
  resolveResilience,
  wrapStreamFn,
  retryCompletion,
  type StreamFn,
} from "./model-retry.js";

function assistantError(msg: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
    stopReason: "error",
    errorMessage: msg,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

function doneMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "test",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/** Build a stream fn from a list of scripted attempt behaviours. */
function scriptedStream(
  attempts: Array<
    | { kind: "errorEvent"; err: unknown }
    | { kind: "contentThenThrow"; err: unknown }
    | { kind: "done"; text: string }
  >,
): { fn: StreamFn; calls: () => number } {
  let call = 0;
  const fn: StreamFn = () => {
    const behaviour = attempts[Math.min(call, attempts.length - 1)];
    call += 1;
    const out = createAssistantMessageEventStream();
    void (async () => {
      if (behaviour.kind === "done") {
        out.push({ type: "start", partial: {} as never });
        out.push({ type: "done", reason: "stop", message: doneMessage(behaviour.text) });
        out.end(doneMessage(behaviour.text));
        return;
      }
      if (behaviour.kind === "errorEvent") {
        out.push({ type: "start", partial: {} as never });
        out.push({
          type: "error",
          reason: "error",
          error: behaviour.err as AssistantMessage,
        });
        out.end(behaviour.err as AssistantMessage);
        return;
      }
      if (behaviour.kind === "contentThenThrow") {
        out.push({ type: "start", partial: {} as never });
        out.push({
          type: "text_delta",
          contentIndex: 0,
          delta: "partial ",
          partial: {} as never,
        });
        out.push({
          type: "error",
          reason: "error",
          error: behaviour.err as AssistantMessage,
        });
        out.end(behaviour.err as AssistantMessage);
        return;
      }
    })();
    return out;
  };
  return { fn, calls: () => call };
}

async function drain(
  stream: ReturnType<StreamFn>,
): Promise<{ events: AssistantMessageEvent[]; result: AssistantMessage }> {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) events.push(ev);
  const result = await stream.result();
  return { events, result };
}

const fastResilience = resolveResilience({
  maxAttempts: 4,
  baseDelayMs: 1,
  maxDelayMs: 4,
  jitter: 0,
  respectRetryAfter: false,
});

describe("classifyError", () => {
  it("marks 429 retriable, non-auth", () => {
    const c = classifyError({ status: 429, message: "rate limited" });
    expect(c.retriable).toBe(true);
    expect(c.authFailure).toBe(false);
    expect(c.kind).toBe("http-429");
  });

  it("marks 401/403 retriable + authFailure", () => {
    expect(classifyError({ status: 401 })).toMatchObject({
      retriable: true,
      authFailure: true,
    });
    expect(classifyError({ status: 403 })).toMatchObject({
      retriable: true,
      authFailure: true,
    });
  });

  it("marks 5xx retriable", () => {
    for (const s of [500, 502, 503, 504]) {
      expect(classifyError({ status: s }).retriable).toBe(true);
    }
  });

  it("marks deterministic 4xx non-retriable", () => {
    expect(classifyError({ status: 400 }).retriable).toBe(false);
    expect(classifyError({ status: 404 }).retriable).toBe(false);
    expect(classifyError({ status: 422 }).retriable).toBe(false);
  });

  it("detects network errors from message text", () => {
    expect(classifyError(new Error("socket hang up")).retriable).toBe(true);
    expect(classifyError(new Error("fetch failed")).retriable).toBe(true);
    expect(classifyError(new Error("ETIMEDOUT")).retriable).toBe(true);
  });

  it("treats provider 'terminated' as a retriable transient failure", () => {
    // SAP-proxy Claude drops the stream mid-response with
    // stopReason=error errorMessage="terminated". Must retry.
    expect(classifyError({ errorMessage: "terminated" }).retriable).toBe(true);
    expect(classifyError(new Error("terminated")).retriable).toBe(true);
    expect(classifyError(new Error("stream interrupted")).retriable).toBe(true);
  });

  it("scrapes status codes out of message text", () => {
    expect(classifyError(new Error("upstream returned 503")).kind).toBe(
      "http-503",
    );
  });

  it("treats unknown errors as non-retriable", () => {
    expect(classifyError(new Error("boom")).retriable).toBe(false);
  });

  it("parses Retry-After seconds header", () => {
    const c = classifyError({ status: 429, headers: { "retry-after": "30" } });
    expect(c.retryAfterMs).toBe(30_000);
  });

  it("parses retry hint from message text", () => {
    expect(classifyError(new Error("please retry in 12000ms")).retryAfterMs).toBe(
      12000,
    );
    expect(classifyError(new Error("retry after 5s")).retryAfterMs).toBe(5000);
  });

  it("parses OpenAI-style 'try again in Xs' message", () => {
    const c = classifyError({
      status: 429,
      message: "Rate limit reached. Please try again in 1.5s.",
    });
    expect(c.rateLimited).toBe(true);
    expect(c.retryAfterMs).toBe(1500);
  });

  it("parses retry-after-ms header", () => {
    const c = classifyError({ status: 429, headers: { "retry-after-ms": "250" } });
    expect(c.retryAfterMs).toBe(250);
  });

  it("parses x-ratelimit-reset duration header (20ms / 2s)", () => {
    expect(
      classifyError({ status: 429, headers: { "x-ratelimit-reset-tokens": "20ms" } })
        .retryAfterMs,
    ).toBe(20);
    expect(
      classifyError({ status: 429, headers: { "x-ratelimit-reset-requests": "2s" } })
        .retryAfterMs,
    ).toBe(2000);
  });

  it("parses Anthropic RFC3339 reset header", () => {
    const resetAt = new Date(Date.now() + 4000).toISOString();
    const c = classifyError({
      status: 429,
      headers: { "anthropic-ratelimit-tokens-reset": resetAt },
    });
    expect(c.retryAfterMs).toBeGreaterThan(2500);
    expect(c.retryAfterMs).toBeLessThanOrEqual(4000);
  });

  it("parses Gemini structured retryDelay from the error body", () => {
    const err = {
      status: 429,
      message: "resource exhausted",
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "17s" },
        ],
      },
    };
    const c = classifyError(err);
    expect(c.rateLimited).toBe(true);
    expect(c.retryAfterMs).toBe(17000);
  });

  it("case-insensitive Retry-After header lookup", () => {
    expect(
      classifyError({ status: 429, headers: { "RETRY-AFTER": "3" } }).retryAfterMs,
    ).toBe(3000);
  });

  it("flags rate limits from vendor phrasing without a status code", () => {
    expect(classifyError(new Error("429 Too Many Requests")).rateLimited).toBe(true);
    expect(classifyError(new Error("RESOURCE_EXHAUSTED")).rateLimited).toBe(true);
    expect(classifyError(new Error("quota exceeded")).rateLimited).toBe(true);
    expect(classifyError(new Error("Overloaded")).rateLimited).toBe(true);
  });
});

describe("backoffDelayMs", () => {
  it("honours Retry-After capped by maxRetryAfterMs (never below, small jitter on top)", () => {
    const r = resolveResilience({ respectRetryAfter: true, maxRetryAfterMs: 10_000 });
    const d = backoffDelayMs(1, classifyError({ status: 429, headers: { "retry-after": "999" } }), r);
    // Capped at 10s, plus up to 25% jitter, and never LESS than asked.
    expect(d).toBeGreaterThanOrEqual(10_000);
    expect(d).toBeLessThanOrEqual(12_500);
  });

  it("never waits less than the server-requested Retry-After", () => {
    const r = resolveResilience({ respectRetryAfter: true });
    const cls = classifyError({ status: 429, headers: { "retry-after": "8" } });
    for (let i = 0; i < 50; i++) {
      expect(backoffDelayMs(1, cls, r)).toBeGreaterThanOrEqual(8_000);
    }
  });

  it("uses the rate-limit floor when a 429 gives no explicit wait", () => {
    const r = resolveResilience({
      baseDelayMs: 500,
      maxDelayMs: 60_000,
      jitter: 0,
      rateLimitFloorMs: 5_000,
    });
    const cls = classifyError({ status: 429, message: "rate limited" });
    expect(cls.retryAfterMs).toBeUndefined();
    // Attempt 1 exponential = 500ms, but the floor lifts it to 5000ms.
    expect(backoffDelayMs(1, cls, r)).toBe(5_000);
    // Later attempts exceed the floor and grow normally.
    expect(backoffDelayMs(5, cls, r)).toBe(8_000); // 500 * 2^4
  });

  it("does NOT apply the rate-limit floor to non-ratelimit errors", () => {
    const r = resolveResilience({ baseDelayMs: 500, jitter: 0, rateLimitFloorMs: 5_000 });
    const cls = classifyError({ status: 503 });
    expect(backoffDelayMs(1, cls, r)).toBe(500);
  });

  it("grows exponentially and respects the cap", () => {
    const r = resolveResilience({ baseDelayMs: 100, maxDelayMs: 800, jitter: 0, respectRetryAfter: false });
    const cls = classifyError({ status: 500 });
    expect(backoffDelayMs(1, cls, r)).toBe(100);
    expect(backoffDelayMs(2, cls, r)).toBe(200);
    expect(backoffDelayMs(3, cls, r)).toBe(400);
    expect(backoffDelayMs(4, cls, r)).toBe(800);
    expect(backoffDelayMs(5, cls, r)).toBe(800); // capped
  });
});

describe("resolveResilience", () => {
  it("applies defaults when undefined", () => {
    const r = resolveResilience(undefined);
    expect(r.enabled).toBe(true);
    expect(r.maxAttempts).toBe(4);
  });
  it("clamps out-of-range values", () => {
    const r = resolveResilience({ maxAttempts: 0, jitter: 5 });
    expect(r.maxAttempts).toBe(4); // rejected < 1 -> fallback
    expect(r.jitter).toBe(1); // clamped to max
  });
});

describe("wrapStreamFn", () => {
  it("passes through a successful stream without extra calls", async () => {
    const { fn, calls } = scriptedStream([{ kind: "done", text: "hello" }]);
    const wrapped = wrapStreamFn(fn, { resilience: fastResilience, log: { warn: () => {} } });
    const { events, result } = await drain(wrapped({} as never, {} as never));
    expect(calls()).toBe(1);
    expect(result.stopReason).toBe("stop");
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("retries a pre-content error event and then succeeds", async () => {
    const { fn, calls } = scriptedStream([
      { kind: "errorEvent", err: assistantError("HTTP 503 upstream") },
      { kind: "done", text: "recovered" },
    ]);
    const wrapped = wrapStreamFn(fn, { resilience: fastResilience, log: { warn: () => {} } });
    const { result } = await drain(wrapped({} as never, {} as never));
    expect(calls()).toBe(2);
    expect(result.stopReason).toBe("stop");
  });

  it("exhausts attempts and surfaces terminal error", async () => {
    const { fn, calls } = scriptedStream([
      { kind: "errorEvent", err: assistantError("HTTP 429 rate limit") },
    ]);
    const wrapped = wrapStreamFn(fn, { resilience: fastResilience, log: { warn: () => {} } });
    const { events, result } = await drain(wrapped({} as never, {} as never));
    expect(calls()).toBe(4); // maxAttempts
    expect(result.stopReason).toBe("error");
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("retries after content when retryAfterContent is on (default), suppressing the replay start", async () => {
    const { fn, calls } = scriptedStream([
      { kind: "contentThenThrow", err: assistantError("HTTP 503 mid-stream") },
      { kind: "done", text: "recovered" },
    ]);
    const notices: Array<{ contentStreamed: boolean }> = [];
    const wrapped = wrapStreamFn(fn, {
      resilience: fastResilience,
      log: { warn: () => {} },
      onRetry: (n) => notices.push(n),
    });
    const { events, result } = await drain(wrapped({} as never, {} as never));
    expect(calls()).toBe(2); // retried
    expect(result.stopReason).toBe("stop");
    // Exactly one `start` reaches the consumer (first attempt's); the
    // replay's start is swallowed so the harness keeps one msg slot.
    expect(events.filter((e) => e.type === "start")).toHaveLength(1);
    // The retry notice flags that content had streamed (client resets).
    expect(notices).toHaveLength(1);
    expect(notices[0]!.contentStreamed).toBe(true);
  });

  it("does NOT retry after content when retryAfterContent is off", async () => {
    const { fn, calls } = scriptedStream([
      { kind: "contentThenThrow", err: assistantError("HTTP 503 mid-stream") },
      { kind: "done", text: "should-not-reach" },
    ]);
    const noContentRetry = resolveResilience({
      maxAttempts: 4,
      baseDelayMs: 1,
      maxDelayMs: 4,
      jitter: 0,
      respectRetryAfter: false,
      retryAfterContent: false,
    });
    const wrapped = wrapStreamFn(fn, { resilience: noContentRetry, log: { warn: () => {} } });
    const { events, result } = await drain(wrapped({} as never, {} as never));
    expect(calls()).toBe(1); // no retry
    expect(result.stopReason).toBe("error");
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
  });

  it("does NOT retry a non-retriable error", async () => {
    const { fn, calls } = scriptedStream([
      { kind: "errorEvent", err: assistantError("HTTP 400 bad request") },
    ]);
    const wrapped = wrapStreamFn(fn, { resilience: fastResilience, log: { warn: () => {} } });
    const { result } = await drain(wrapped({} as never, {} as never));
    expect(calls()).toBe(1);
    expect(result.stopReason).toBe("error");
  });

  it("re-resolves apiKey on an auth failure before retrying", async () => {
    const { fn, calls } = scriptedStream([
      { kind: "errorEvent", err: assistantError("HTTP 401 token expired") },
      { kind: "done", text: "authed" },
    ]);
    const reResolve = vi.fn(() => "fresh-jwt");
    const wrapped = wrapStreamFn(fn, {
      resilience: fastResilience,
      reResolveApiKey: reResolve,
      log: { warn: () => {} },
    });
    const { result } = await drain(wrapped({} as never, {} as never));
    expect(calls()).toBe(2);
    expect(reResolve).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("stop");
  });

  it("fires onRetry once per retry with a filled message", async () => {
    const { fn } = scriptedStream([
      { kind: "errorEvent", err: assistantError("HTTP 503") },
      { kind: "errorEvent", err: assistantError("HTTP 503") },
      { kind: "done", text: "ok" },
    ]);
    const notices: unknown[] = [];
    const wrapped = wrapStreamFn(fn, {
      resilience: fastResilience,
      log: { warn: () => {} },
      onRetry: (n) => notices.push(n),
      label: "prov/model",
    });
    await drain(wrapped({} as never, {} as never));
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({
      attempt: 1,
      maxAttempts: 4,
      kind: "http-503",
      label: "prov/model",
    });
    expect((notices[0] as { message: string }).message).toContain("retrying in");
  });

  it("a throwing onRetry does not derail the retry loop", async () => {
    const { fn } = scriptedStream([
      { kind: "errorEvent", err: assistantError("HTTP 429") },
      { kind: "done", text: "ok" },
    ]);
    const wrapped = wrapStreamFn(fn, {
      resilience: fastResilience,
      log: { warn: () => {} },
      onRetry: () => {
        throw new Error("ui handler blew up");
      },
    });
    const { result } = await drain(wrapped({} as never, {} as never));
    expect(result.stopReason).toBe("stop");
  });

  it("returns fn unchanged when disabled", () => {
    const { fn } = scriptedStream([{ kind: "done", text: "x" }]);
    const wrapped = wrapStreamFn(fn, {
      resilience: resolveResilience({ enabled: false }),
    });
    expect(wrapped).toBe(fn);
  });

  it("honours abort during backoff", async () => {
    const { fn, calls } = scriptedStream([
      { kind: "errorEvent", err: assistantError("HTTP 503") },
      { kind: "done", text: "unreached" },
    ]);
    const ctl = new AbortController();
    const slow = resolveResilience({ maxAttempts: 4, baseDelayMs: 1000, jitter: 0, respectRetryAfter: false });
    const wrapped = wrapStreamFn(fn, { resilience: slow, log: { warn: () => {} } });
    const stream = wrapped({} as never, {} as never, { signal: ctl.signal });
    // Abort almost immediately, during the first backoff.
    setTimeout(() => ctl.abort(), 20);
    const { result } = await drain(stream);
    expect(result.stopReason).toBe("error");
    expect(calls()).toBe(1); // never got to the second attempt
  });
});

describe("retryCompletion", () => {
  it("retries transient failures then resolves", async () => {
    let n = 0;
    const run = vi.fn(async () => {
      n += 1;
      if (n < 3) throw { status: 503, message: "unavailable" };
      return "ok";
    });
    const result = await retryCompletion(run, "k", {
      resilience: fastResilience,
      log: { warn: () => {} },
    });
    expect(result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("re-resolves apiKey on auth failure", async () => {
    let n = 0;
    const keys: string[] = [];
    const run = vi.fn(async (key: string) => {
      keys.push(key);
      n += 1;
      if (n < 2) throw { status: 401 };
      return "ok";
    });
    await retryCompletion(run, "old", {
      resilience: fastResilience,
      reResolveApiKey: () => "new",
      log: { warn: () => {} },
    });
    expect(keys).toEqual(["old", "new"]);
  });

  it("rethrows non-retriable errors immediately", async () => {
    const run = vi.fn(async () => {
      throw { status: 400, message: "bad" };
    });
    await expect(
      retryCompletion(run, "k", { resilience: fastResilience, log: { warn: () => {} } }),
    ).rejects.toMatchObject({ status: 400 });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fires onRetry for completion retries", async () => {
    let n = 0;
    const run = vi.fn(async () => {
      n += 1;
      if (n < 2) throw { status: 429, message: "rate limited" };
      return "ok";
    });
    const notices: Array<{ rateLimited: boolean }> = [];
    await retryCompletion(run, "k", {
      resilience: fastResilience,
      log: { warn: () => {} },
      onRetry: (notice) => notices.push(notice),
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.rateLimited).toBe(true);
  });
});
