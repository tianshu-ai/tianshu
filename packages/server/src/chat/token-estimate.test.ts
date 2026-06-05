import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  Message,
  TextContent,
  Tool,
  UserMessage,
} from "@earendil-works/pi-ai";
import { estimateTokens } from "./token-estimate.js";

function user(text: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text } as TextContent],
    timestamp: 1,
  };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text } as TextContent],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

describe("estimateTokens", () => {
  it("counts text contents at ~4 chars per token", () => {
    const t = "x".repeat(400);
    const tokens = estimateTokens({ messages: [user(t)] });
    // 400 chars / 4 = 100 tokens.
    expect(tokens).toBe(100);
  });

  it("includes the system prompt", () => {
    const tokens = estimateTokens({
      systemPrompt: "y".repeat(80),
      messages: [user("x".repeat(40))],
    });
    expect(tokens).toBe(30); // (80 + 40) / 4
  });

  it("counts images as their base64 length", () => {
    const data = "z".repeat(40);
    const msg: UserMessage = {
      role: "user",
      content: [{ type: "image", data, mimeType: "image/png" }],
      timestamp: 1,
    };
    const tokens = estimateTokens({ messages: [msg] });
    expect(tokens).toBe(10);
  });

  it("counts tool schemas (name + description + parameters)", () => {
    const tool: Tool = {
      name: "x".repeat(40),
      description: "y".repeat(40),
      parameters: { type: "object", properties: {} } as Tool["parameters"],
    };
    // name (40) + description (40) + JSON.stringify(params)
    const json = JSON.stringify(tool.parameters ?? {});
    const expected = Math.ceil((40 + 40 + json.length) / 4);
    const tokens = estimateTokens({ messages: [], tools: [tool] });
    expect(tokens).toBe(expected);
  });

  it("aggregates across many messages", () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(user("a".repeat(40)));
      msgs.push(assistant("b".repeat(40)));
    }
    // 20 msgs × 40 chars = 800 chars / 4 = 200 tokens.
    expect(estimateTokens({ messages: msgs })).toBe(200);
  });
});
