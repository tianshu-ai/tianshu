import { describe, expect, it, vi } from "vitest";
import { McpToolset } from "./mcp-toolset.js";

// We don't have an easy way to spin up a real MCP server in unit
// tests, so these focus on the parts McpToolset can exercise on
// its own:
//   - `resolve()` is consulted on every `callRemote` so a sandbox
//     restart (new free port) doesn't strand long-lived worker
//     sessions on a dead endpoint.
//   - the `endpoint` field updates when `resolve()` returns a new
//     URL and clears when the resolver returns undefined.

describe("McpToolset endpoint resolution", () => {
  it("re-resolves the endpoint on every callRemote so port changes propagate", async () => {
    let port = 4001;
    const resolve = vi.fn(async () => `http://127.0.0.1:${port}`);
    const ts = new McpToolset({
      name: "spec-mcp",
      resolve,
    });
    // Drive the private path. We don't actually want to open a
    // network connection, so we expect the call to fail at
    // `withClient` (no real server). We only assert (a) resolve
    // was called and (b) the toolset's endpoint reflects the
    // latest resolver answer.
    const callRemote = (
      ts as unknown as {
        callRemote: (
          name: string,
          args: Record<string, unknown>,
          ctx: { log: { warn: () => void } },
        ) => Promise<unknown>;
      }
    ).callRemote.bind(ts);
    const ctx = { log: { warn: vi.fn() } };

    await callRemote("noop", {}, ctx);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect((ts as unknown as { endpoint: string | undefined }).endpoint).toBe(
      "http://127.0.0.1:4001",
    );

    // Simulate a sandbox restart on a different host port.
    port = 4002;
    await callRemote("noop", {}, ctx);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect((ts as unknown as { endpoint: string | undefined }).endpoint).toBe(
      "http://127.0.0.1:4002",
    );
  });

  it("reports `no endpoint` when the resolver returns undefined", async () => {
    const resolve = vi.fn(async () => undefined);
    const ts = new McpToolset({
      name: "spec-mcp",
      resolve,
    });
    const callRemote = (
      ts as unknown as {
        callRemote: (
          name: string,
          args: Record<string, unknown>,
          ctx: { log: { warn: () => void } },
        ) => Promise<{ ok: boolean; text: string }>;
      }
    ).callRemote.bind(ts);
    const out = await callRemote("noop", {}, { log: { warn: vi.fn() } });
    expect(out.ok).toBe(false);
    expect(out.text).toContain("no endpoint");
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
