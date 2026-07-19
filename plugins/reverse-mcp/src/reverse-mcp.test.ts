// End-to-end-ish test of the reverse-MCP loop WITHOUT a real server:
// drive the registry + toolset directly with a fake WebSocket that
// behaves like a dialed-in bridge (echoes tools/call).

import { describe, it, expect, vi } from "vitest";
import { BridgeRegistry } from "./registry.js";
import { makeBridgeToolset, toolName } from "./toolset.js";
import { MSG } from "./protocol.js";
import type { AgentToolContext } from "@tianshu-ai/plugin-sdk";

// Minimal fake socket: captures sent frames and lets the test push
// replies back through the registry (simulating the bridge client).
function fakeSocket() {
  const sent: any[] = [];
  return {
    sent,
    readyState: 1,
    OPEN: 1,
    send(data: string) {
      sent.push(JSON.parse(data));
    },
  } as any;
}

function toolCtx(userId: string): AgentToolContext {
  return {
    pluginId: "reverse-mcp",
    tenantId: "t1",
    userId,
    capabilities: { get: () => undefined, has: () => false } as any,
    userHomeDir: "/tmp",
    tenantHomeDir: "/tmp",
  } as AgentToolContext;
}

const log = { info: () => {}, warn: () => {} };

describe("reverse-mcp loop", () => {
  it("register → agent sees the tool → call round-trips over WS", async () => {
    const reg = new BridgeRegistry();
    const toolset = makeBridgeToolset({ registry: reg, log });
    const sock = fakeSocket();

    // Bridge registers one tool.
    reg.register({
      userId: "alice",
      deviceId: "mac",
      label: "Alice's Mac",
      socket: sock,
      tools: [
        { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      ],
    });

    // The agent (as alice) sees exactly one bridge tool, correctly named.
    const tools = toolset.listTools();
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.schema.name).toBe(toolName("mac", "echo"));

    // available() is user-scoped.
    expect(await tool.available!(toolCtx("alice"))).toBe(true);
    expect(await tool.available!(toolCtx("bob"))).toBe(false);

    // Kick off a call; it sends a reverse_mcp_request over the socket.
    const resultP = tool.execute({ text: "hi" }, toolCtx("alice"));
    // The request frame was sent to the bridge.
    const req = sock.sent.find((m: any) => m.type === MSG.request);
    expect(req).toBeTruthy();
    expect(req.method).toBe("tools/call");
    expect(req.params).toEqual({ name: "echo", arguments: { text: "hi" } });

    // Bridge replies (simulate the client executing locally).
    reg.settle(sock, req.id, {
      content: [{ type: "text", text: "hi" }],
    });

    const result = (await resultP) as { ok: boolean; text: string };
    expect(result.ok).toBe(true);
    expect(result.text).toBe("hi");
  });

  it("bob cannot call alice's bridge tool", async () => {
    const reg = new BridgeRegistry();
    const toolset = makeBridgeToolset({ registry: reg, log });
    const sock = fakeSocket();
    reg.register({ userId: "alice", deviceId: "mac", socket: sock, tools: [{ name: "echo" }] });
    const tool = toolset.listTools()[0]!;
    const res = (await tool.execute({}, toolCtx("bob"))) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  it("call errors cleanly when the device is gone", async () => {
    const reg = new BridgeRegistry();
    const toolset = makeBridgeToolset({ registry: reg, log });
    const sock = fakeSocket();
    reg.register({ userId: "alice", deviceId: "mac", socket: sock, tools: [{ name: "echo" }] });
    const tool = toolset.listTools()[0]!;
    reg.removeBySocket(sock); // device disconnects
    const res = (await tool.execute({}, toolCtx("alice"))) as { ok: boolean; text: string };
    expect(res.ok).toBe(false);
    expect(res.text).toMatch(/not connected/);
  });

  it("error replies from the bridge surface as failed tool results", async () => {
    const reg = new BridgeRegistry();
    const toolset = makeBridgeToolset({ registry: reg, log });
    const sock = fakeSocket();
    reg.register({ userId: "alice", deviceId: "mac", socket: sock, tools: [{ name: "boom" }] });
    const tool = toolset.listTools()[0]!;
    const p = tool.execute({}, toolCtx("alice"));
    const req = sock.sent.find((m: any) => m.type === MSG.request);
    reg.settle(sock, req.id, undefined, { message: "local failure" });
    const res = (await p) as { ok: boolean; text: string };
    expect(res.ok).toBe(false);
    expect(res.text).toMatch(/local failure/);
  });
});
