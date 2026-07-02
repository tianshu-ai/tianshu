import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import { OpenCodeProxy } from "./proxy.js";

// --- mock the model-resolution layer so tests don't need real
//     tenant config / env keys. The proxy only touches these three.
vi.mock("../core/llm.js", () => ({
  findModel: (_cfg: unknown, id: string) => {
    if (id === "anthropic/claude-opus-4-7") {
      return {
        id,
        providerId: "anthropic",
        modelId: "claude-opus-4-7",
        api: "anthropic-messages",
        baseUrl: "http://upstream.test:3031",
      };
    }
    if (id === "openai/gpt-4o") {
      return {
        id,
        providerId: "openai",
        modelId: "gpt-4o",
        api: "openai-completions",
        baseUrl: "http://upstream.test:3031/v1",
      };
    }
    return undefined;
  },
  resolveApiKey: () => "REAL-SECRET-KEY",
}));
vi.mock("../core/config.js", () => ({
  resolveTenantConfig: () => ({}),
}));
vi.mock("../core/paths.js", () => ({
  getTianshuHome: () => "/tmp/does-not-matter",
}));

// --- tiny express req/res fakes -------------------------------
interface CapturedRes {
  statusCode: number;
  headers: Record<string, string>;
  chunks: Buffer[];
  ended: boolean;
  json?: unknown;
}
function makeRes(): { res: Response; cap: CapturedRes } {
  const cap: CapturedRes = {
    statusCode: 200,
    headers: {},
    chunks: [],
    ended: false,
  };
  const res = {
    status(code: number) {
      cap.statusCode = code;
      return this;
    },
    json(body: unknown) {
      cap.json = body;
      cap.ended = true;
      return this;
    },
    setHeader(k: string, v: string) {
      cap.headers[k.toLowerCase()] = v;
    },
    write(buf: Buffer) {
      cap.chunks.push(Buffer.from(buf));
      return true;
    },
    end() {
      cap.ended = true;
    },
  } as unknown as Response;
  return { res, cap };
}
function makeReq(opts: {
  method?: string;
  token: string;
  tail: string;
  body?: unknown;
  headers?: Record<string, string>;
  query?: string;
}): Request {
  return {
    method: opts.method ?? "POST",
    params: { token: opts.token, splat: opts.tail },
    body: opts.body,
    headers: opts.headers ?? {},
    originalUrl: `/opencode-proxy/${opts.token}/${opts.tail}${
      opts.query ?? ""
    }`,
  } as unknown as Request;
}

/** Build an SSE-ish streaming Response for fetch mock. */
function streamResponse(status: number, text: string): globalThis.Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("OpenCodeProxy — grant lifecycle", () => {
  it("grants a unique token bound to one (tenant, model)", () => {
    const p = new OpenCodeProxy();
    const g1 = p.grant("t1", "anthropic/claude-opus-4-7");
    const g2 = p.grant("t1", "anthropic/claude-opus-4-7");
    expect(g1.token).not.toEqual(g2.token);
    expect(g1.tenantId).toBe("t1");
    expect(g1.modelId).toBe("anthropic/claude-opus-4-7");
    expect(p.size()).toBe(2);
  });

  it("revoke removes the token", () => {
    const p = new OpenCodeProxy();
    const g = p.grant("t1", "openai/gpt-4o");
    expect(p.size()).toBe(1);
    p.revoke(g.token);
    expect(p.size()).toBe(0);
  });

  it("expired grants are dropped", () => {
    const p = new OpenCodeProxy({ ttlMs: 1 });
    p.grant("t1", "openai/gpt-4o");
    // let it expire
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(p.size()).toBe(0);
        resolve();
      }, 5),
    );
  });
});

describe("OpenCodeProxy — request gating", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("rejects unknown token with 401", async () => {
    const p = new OpenCodeProxy();
    const { res, cap } = makeRes();
    await p.handler(
      makeReq({ token: "bogus", tail: "v1/messages" }),
      res,
    );
    expect(cap.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-GET/POST with 405", async () => {
    const p = new OpenCodeProxy();
    const g = p.grant("t1", "anthropic/claude-opus-4-7");
    const { res, cap } = makeRes();
    await p.handler(
      makeReq({ method: "DELETE", token: g.token, tail: "v1/messages" }),
      res,
    );
    expect(cap.statusCode).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a disallowed path with 403", async () => {
    const p = new OpenCodeProxy();
    const g = p.grant("t1", "anthropic/claude-opus-4-7");
    const { res, cap } = makeRes();
    await p.handler(
      makeReq({ token: g.token, tail: "etc/passwd" }),
      res,
    );
    expect(cap.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("502 when the model can't be resolved", async () => {
    const p = new OpenCodeProxy();
    const g = p.grant("t1", "nonexistent/model");
    const { res, cap } = makeRes();
    await p.handler(
      makeReq({ token: g.token, tail: "v1/messages" }),
      res,
    );
    expect(cap.statusCode).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("OpenCodeProxy — forwarding + hardening", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => streamResponse(200, "OK-BODY"));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("forwards to the model's real baseUrl + injects real auth (anthropic)", async () => {
    const p = new OpenCodeProxy();
    const g = p.grant("t1", "anthropic/claude-opus-4-7");
    const { res, cap } = makeRes();
    await p.handler(
      makeReq({
        token: g.token,
        tail: "v1/messages",
        body: { model: "claude-opus-4-7", max_tokens: 8, messages: [] },
        headers: { "x-api-key": "SANDBOX-FAKE-KEY" },
      }),
      res,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://upstream.test:3031/v1/messages");
    // real key injected, sandbox fake key stripped
    expect(init.headers["x-api-key"]).toBe("REAL-SECRET-KEY");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    // response streamed back
    expect(Buffer.concat(cap.chunks).toString()).toBe("OK-BODY");
    expect(cap.statusCode).toBe(200);
  });

  it("overwrites body.model with the grant's native id (anti-tamper)", async () => {
    const p = new OpenCodeProxy();
    const g = p.grant("t1", "anthropic/claude-opus-4-7");
    const { res } = makeRes();
    await p.handler(
      makeReq({
        token: g.token,
        tail: "v1/messages",
        // sandbox tries to sneak a different, pricier model
        body: { model: "claude-some-other-expensive", messages: [] },
      }),
      res,
    );
    const init = fetchMock.mock.calls[0][1];
    const sentBody = JSON.parse(init.body);
    expect(sentBody.model).toBe("claude-opus-4-7");
  });

  it("injects Bearer auth for openai-completions", async () => {
    const p = new OpenCodeProxy();
    const g = p.grant("t1", "openai/gpt-4o");
    const { res } = makeRes();
    // openai baseUrl already ends in /v1, so the AI SDK sends the
    // tail WITHOUT a leading v1/.
    await p.handler(
      makeReq({
        token: g.token,
        tail: "chat/completions",
        body: { model: "gpt-4o", messages: [] },
      }),
      res,
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://upstream.test:3031/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer REAL-SECRET-KEY");
    expect(JSON.parse(init.body).model).toBe("gpt-4o");
  });

  it("allows the endpoint whether or not the tail carries a v1/ prefix", async () => {
    const p = new OpenCodeProxy();
    const g = p.grant("t1", "openai/gpt-4o");
    // with leading v1/ (some clients) and without (openai baseUrl case)
    for (const tail of ["chat/completions", "v1/chat/completions"]) {
      fetchMock.mockClear();
      const { res, cap } = makeRes();
      await p.handler(
        makeReq({ token: g.token, tail, body: { messages: [] } }),
        res,
      );
      expect(cap.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
});
