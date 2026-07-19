// End-to-end-ish test of the reverse-MCP loop WITHOUT a real server:
// drive the registry + toolset directly with a fake WebSocket that
// behaves like a dialed-in bridge (echoes tools/call).

import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { BridgeRegistry } from "./registry.js";
import { makeBridgeToolset, toolName } from "./toolset.js";
import { MSG } from "./protocol.js";
import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";

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
const noHome = () => "/tmp";

function bridgeToolset(reg: BridgeRegistry, home: (u: string) => string = noHome) {
  return makeBridgeToolset({ registry: reg, userHomeDir: home, log });
}

/** Find a bridge tool by device+name (listTools also returns the
 *  per-user bridge_view_image tool now). */
function findTool(tools: AgentTool[], deviceId: string, name: string): AgentTool {
  const t = tools.find((x) => x.schema.name === toolName(deviceId, name));
  if (!t) throw new Error(`tool ${toolName(deviceId, name)} not found`);
  return t;
}

describe("reverse-mcp loop", () => {
  it("register → agent sees the tool → call round-trips over WS", async () => {
    const reg = new BridgeRegistry();
    const toolset = bridgeToolset(reg);
    const sock = fakeSocket();

    reg.register({
      userId: "alice",
      deviceId: "mac",
      label: "Alice's Mac",
      socket: sock,
      tools: [
        { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      ],
    });

    const tools = toolset.listTools();
    // The echo tool + the per-user bridge_view_image tool.
    expect(tools.some((t) => t.schema.name === "bridge_view_image")).toBe(true);
    const tool = findTool(tools, "mac", "echo");

    expect(await tool.available!(toolCtx("alice"))).toBe(true);
    expect(await tool.available!(toolCtx("bob"))).toBe(false);

    const resultP = tool.execute({ text: "hi" }, toolCtx("alice"));
    const req = sock.sent.find((m: any) => m.type === MSG.request);
    expect(req).toBeTruthy();
    expect(req.method).toBe("tools/call");
    expect(req.params).toEqual({ name: "echo", arguments: { text: "hi" } });

    reg.settle(sock, req.id, { content: [{ type: "text", text: "hi" }] });

    const result = (await resultP) as { ok: boolean; text: string };
    expect(result.ok).toBe(true);
    expect(result.text).toBe("hi");
  });

  it("bob cannot call alice's bridge tool", async () => {
    const reg = new BridgeRegistry();
    const toolset = bridgeToolset(reg);
    const sock = fakeSocket();
    reg.register({ userId: "alice", deviceId: "mac", socket: sock, tools: [{ name: "echo" }] });
    const tool = findTool(toolset.listTools(), "mac", "echo");
    const res = (await tool.execute({}, toolCtx("bob"))) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  it("call errors cleanly when the device is gone", async () => {
    const reg = new BridgeRegistry();
    const toolset = bridgeToolset(reg);
    const sock = fakeSocket();
    reg.register({ userId: "alice", deviceId: "mac", socket: sock, tools: [{ name: "echo" }] });
    const tool = findTool(toolset.listTools(), "mac", "echo");
    reg.removeBySocket(sock);
    const res = (await tool.execute({}, toolCtx("alice"))) as { ok: boolean; text: string };
    expect(res.ok).toBe(false);
    expect(res.text).toMatch(/not connected/);
  });

  it("error replies from the bridge surface as failed tool results", async () => {
    const reg = new BridgeRegistry();
    const toolset = bridgeToolset(reg);
    const sock = fakeSocket();
    reg.register({ userId: "alice", deviceId: "mac", socket: sock, tools: [{ name: "boom" }] });
    const tool = findTool(toolset.listTools(), "mac", "boom");
    const p = tool.execute({}, toolCtx("alice"));
    const req = sock.sent.find((m: any) => m.type === MSG.request);
    reg.settle(sock, req.id, undefined, { message: "local failure" });
    const res = (await p) as { ok: boolean; text: string };
    expect(res.ok).toBe(false);
    expect(res.text).toMatch(/local failure/);
  });

  it("screenshots are saved to disk as a path, then bridge_view_image inlines the bytes", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rmcp-home-"));
    const reg = new BridgeRegistry();
    const toolset = bridgeToolset(reg, () => home);
    const sock = fakeSocket();
    reg.register({ userId: "alice", deviceId: "mac", socket: sock, tools: [{ name: "browser_screenshot" }] });

    // 1x1 png bytes
    const pngB64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQGz3E0aAAAAAElFTkSuQmCC";
    const shot = findTool(toolset.listTools(), "mac", "browser_screenshot");
    const p = shot.execute({}, toolCtx("alice"));
    const req = sock.sent.find((m: any) => m.type === MSG.request);
    reg.settle(sock, req.id, {
      content: [
        { type: "text", text: "shot" },
        { type: "image", data: pngB64, mimeType: "image/png" },
      ],
    });
    const r1 = (await p) as { ok: boolean; text: string; images?: unknown[] };
    expect(r1.ok).toBe(true);
    // path surfaced, no inline bytes in the screenshot result
    expect(r1.text).toMatch(/bridge-screenshots\/.+\.png/);
    expect(r1.images).toBeUndefined();

    const rel = /bridge-screenshots\/\S+\.png/.exec(r1.text)![0];
    // bridge_view_image inlines the saved image as ImageContent
    const view = toolset.listTools().find((t) => t.schema.name === "bridge_view_image")!;
    const r2 = (await view.execute({ path: rel }, toolCtx("alice"))) as {
      ok: boolean;
      images?: Array<{ base64: string; mimeType: string }>;
    };
    expect(r2.ok).toBe(true);
    expect(r2.images?.length).toBe(1);
    expect(r2.images![0]!.mimeType).toBe("image/png");
    expect(r2.images![0]!.base64.length).toBeGreaterThan(10);

    // path-safety: escape attempt is rejected
    const bad = (await view.execute({ path: "../../etc/passwd" }, toolCtx("alice"))) as { ok: boolean };
    expect(bad.ok).toBe(false);

    fs.rmSync(home, { recursive: true, force: true });
  });
});
