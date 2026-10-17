import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentToolContext, PluginContext } from "@tianshu-ai/plugin-sdk";
import plugin from "../server.js";
import { PARALLEL_MCP_URL, EXA_MCP_URL } from "./providers.js";

const ctx: AgentToolContext = {
  pluginId: "web-search",
  tenantId: "test",
  userId: "test",
  capabilities: { get: () => undefined, has: () => false },
  userHomeDir: "/tmp/tianshu-web-search-test",
  tenantHomeDir: "/tmp/tianshu-web-search-test",
  log: { info: () => {}, warn: () => {}, error: () => {} },
};

async function searchTool(pluginConfig: Record<string, unknown> = { backend: "parallel" }) {
  const activated = await plugin.activate({
    pluginConfig,
    log: ctx.log,
  } as PluginContext);
  return activated.tools!.WebSearchTool;
}

function mcpResponse(payload: unknown, sse = false) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }] },
  });
  return new Response(sse ? `event: message\ndata: ${body}\n\n` : body, {
    headers: { "content-type": sse ? "text/event-stream" : "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("web_search through plugin activation", () => {
  it.each([false, true])("returns Parallel excerpts and dates (SSE: %s)", async (sse) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(mcpResponse({
      results: [
        { title: "Release notes", url: "https://example.com/releases", excerpts: ["First excerpt.", "Second excerpt."], publish_date: "2026-10-01" },
        { title: "More notes", url: "https://example.com/more", excerpts: ["More context."], publish_date: null },
      ],
    }, sse));
    vi.stubGlobal("fetch", fetchMock);
    const tool = await searchTool();
    const out = await tool.execute({ query: "  release notes  ", count: 1 }, ctx);

    expect(out.ok).toBe(true);
    expect(out.data).toEqual({
      query: "release notes",
      provider: "parallel",
      results: [{ title: "Release notes", url: "https://example.com/releases", content: "First excerpt.\n\nSecond excerpt.", publishedDate: "2026-10-01" }],
    });
    expect(out.text).toContain("First excerpt.\n\nSecond excerpt.");
    expect(out.text).toContain("https://example.com/releases (2026-10-01)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(PARALLEL_MCP_URL);
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("user-agent")).toBe("tianshu-web-search/0.3");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("accept")).toBe("application/json, text/event-stream");
    expect(JSON.parse(init?.body as string)).toEqual({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "web_search", arguments: { objective: "release notes", search_queries: ["release notes"] } },
    });
  });

  it("keeps legacy field precedence and tolerates missing or non-string excerpts", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(mcpResponse([
      { title: "Legacy", url: "https://example.com/legacy", text: "Existing snippet", excerpts: ["New excerpt"], publishedDate: "2026-09-01", publish_date: "2026-10-01" },
      { name: "Aliases", link: "https://example.com/aliases", snippet: "Alias snippet", published_date: "2026-08-01" },
      { title: "Mixed", url: "https://example.com/mixed", excerpts: [null, "Useful", 42, {}, "context"], publish_date: null },
      { title: "Missing", url: "https://example.com/missing" },
      { title: "Invalid", url: "https://example.com/invalid", excerpts: "not an array" },
    ])));
    const out = await (await searchTool()).execute({ query: "notes" }, ctx);
    expect(out.data).toMatchObject({ results: [
      { content: "Existing snippet", publishedDate: "2026-09-01" },
      { title: "Aliases", url: "https://example.com/aliases", content: "Alias snippet", publishedDate: "2026-08-01" },
      { content: "Useful\n\ncontext", publishedDate: null },
      { content: "", publishedDate: null },
      { content: "", publishedDate: null },
    ] });
  });

  it("retains snippet length limits for joined excerpts", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(mcpResponse({
      results: [{ title: "Long", url: "https://example.com/long", excerpts: ["A".repeat(700), "B".repeat(700)] }],
    })));
    const out = await (await searchTool()).execute({ query: "notes" }, ctx);
    expect(out.data).toMatchObject({ results: [{ content: "A".repeat(700) + "\n\n" + "B".repeat(298) }] });
    expect(out.text).toContain("A".repeat(280));
    expect(out.text).not.toContain("A".repeat(281));
  });

  it.each([{}, { backend: "exa" }])("preserves Exa selection and text parsing for %j", async (config) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(mcpResponse("Title: Exa result\nURL: https://example.com/exa\nPublished: 2026-09-01\nHighlights:\nOriginal highlight."));
    vi.stubGlobal("fetch", fetchMock);
    const out = await (await searchTool(config)).execute({ query: "notes", count: 2 }, ctx);
    expect(out.data).toMatchObject({ provider: "exa", results: [{ title: "Exa result", content: "Original highlight.", publishedDate: "2026-09-01" }] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(EXA_MCP_URL);
    expect(JSON.parse(init?.body as string).params).toEqual({ name: "web_search_exa", arguments: { query: "notes", numResults: 2, type: "auto" } });
  });

  it("surfaces HTTP errors without reporting successful results", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("Try later", { status: 429 })));
    const out = await (await searchTool()).execute({ query: "notes" }, ctx);
    expect(out.ok).toBe(false);
    expect(out.text).toContain("status 429");
    expect(out.text).toContain("Try later");
  });

  it("surfaces transport errors", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("connection failed")));
    const out = await (await searchTool()).execute({ query: "notes" }, ctx);
    expect(out.ok).toBe(false);
    expect(out.text).toContain("connection failed");
  });

  it("aborts a pending request at the configured timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(new DOMException("Request aborted", "AbortError")), { once: true });
      });
    }));
    const tool = await searchTool({ backend: "parallel", timeoutMs: 1000 });
    const pending = tool.execute({ query: "notes" }, ctx);
    await vi.advanceTimersByTimeAsync(1000);
    const out = await pending;
    expect(signal?.aborted).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.text).toContain("Request aborted");
    expect(vi.getTimerCount()).toBe(0);
  });
});
