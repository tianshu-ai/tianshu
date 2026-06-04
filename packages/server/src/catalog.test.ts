import { describe, expect, it, vi } from "vitest";
import { CatalogClient } from "./catalog.js";

const VALID_ENTRY = {
  id: "pomodoro",
  displayName: "Pomodoro Timer",
  description: "A focus timer.",
  author: "tianshu-ai",
  verified: true,
  repository: "https://github.com/tianshu-ai/plugin-pomodoro",
  homepage: "https://example.com",
  license: "Apache-2.0",
  tags: ["timer", "productivity"],
  latestVersion: "1.0.0",
  tarballUrl: "https://example.com/pomodoro-1.0.0.tgz",
  tarballSha256: "a".repeat(64),
  tarballSize: 1024,
  tianshuRange: ">=0.2 <2",
};

function fakeFetch(body: unknown, init: { status?: number } = {}): typeof fetch {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return vi.fn(async () =>
    new Response(text, {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("CatalogClient", () => {
  it("fetches and validates a happy-path catalog", async () => {
    const c = new CatalogClient({
      url: "https://x/catalog.json",
      fetcher: fakeFetch({
        schemaVersion: 1,
        updatedAt: "2026-06-04T12:00:00Z",
        plugins: [VALID_ENTRY],
      }),
    });

    const snap = await c.get();
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]!.id).toBe("pomodoro");
    expect(snap.entriesDropped).toBe(0);
    expect(snap.catalogUpdatedAt).toBe("2026-06-04T12:00:00Z");
    expect(snap.source).toBe("https://x/catalog.json");
  });

  it("drops entries that fail field-level validation but keeps the rest", async () => {
    const c = new CatalogClient({
      url: "https://x/catalog.json",
      fetcher: fakeFetch({
        schemaVersion: 1,
        plugins: [
          VALID_ENTRY,
          { ...VALID_ENTRY, id: "BAD ID" }, // bad id
          { ...VALID_ENTRY, id: "x", tarballSha256: "nope" }, // bad sha
          { ...VALID_ENTRY, id: "y", tarballUrl: "ftp://nope" }, // bad url scheme
          { ...VALID_ENTRY, id: "z", description: "" }, // empty description
        ],
      }),
    });

    const snap = await c.get();
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]!.id).toBe("pomodoro");
    expect(snap.entriesDropped).toBe(4);
  });

  it("dedupes entries with the same id", async () => {
    const c = new CatalogClient({
      url: "https://x/catalog.json",
      fetcher: fakeFetch({
        schemaVersion: 1,
        plugins: [VALID_ENTRY, { ...VALID_ENTRY, latestVersion: "1.0.1" }],
      }),
    });

    const snap = await c.get();
    expect(snap.entries).toHaveLength(1);
    expect(snap.entriesDropped).toBe(1);
  });

  it("rejects an unsupported schemaVersion", async () => {
    const c = new CatalogClient({
      url: "https://x/catalog.json",
      fetcher: fakeFetch({ schemaVersion: 99, plugins: [] }),
    });
    await expect(c.get()).rejects.toThrow(/schemaVersion/);
  });

  it("rejects a non-200 response", async () => {
    const c = new CatalogClient({
      url: "https://x/catalog.json",
      fetcher: fakeFetch("not found", { status: 404 }),
    });
    await expect(c.get()).rejects.toThrow(/404/);
  });

  it("rejects a non-JSON body", async () => {
    const c = new CatalogClient({
      url: "https://x/catalog.json",
      fetcher: fakeFetch("not json"),
    });
    await expect(c.get()).rejects.toThrow(/valid JSON/);
  });

  it("caches within ttl, re-fetches after invalidate()", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ schemaVersion: 1, plugins: [VALID_ENTRY] }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;

    const c = new CatalogClient({
      url: "https://x/catalog.json",
      fetcher,
      ttlMs: 60_000,
    });

    await c.get();
    await c.get();
    expect((fetcher as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);

    c.invalidate();
    await c.get();
    expect((fetcher as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
  });

  it("force: true bypasses the cache", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ schemaVersion: 1, plugins: [VALID_ENTRY] }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;

    const c = new CatalogClient({
      url: "https://x/catalog.json",
      fetcher,
      ttlMs: 60_000,
    });

    await c.get();
    await c.get({ force: true });
    expect((fetcher as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
  });

  it("rejects bodies larger than 1 MB", async () => {
    const huge = "x".repeat(1_048_577);
    const c = new CatalogClient({
      url: "https://x/catalog.json",
      fetcher: vi.fn(
        async () =>
          new Response(huge, {
            status: 200,
            headers: { "content-length": String(huge.length) },
          }),
      ) as unknown as typeof fetch,
    });
    await expect(c.get()).rejects.toThrow(/too large/);
  });
});
