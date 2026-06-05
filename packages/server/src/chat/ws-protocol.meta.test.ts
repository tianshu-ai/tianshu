// Tests for the assistant-message meta extraction in toWire().
//
// We exercise three things:
//   - meta gets stamped on assistant rows (model, usage, contextWindow)
//   - the contextWindowFor resolver is called with `<provider>/<model>`
//   - meta stays absent on user / tool rows + when nothing is present

import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./messages.js";
import { toWire } from "./ws-protocol.js";

function row(content: string, role: ChatMessage["role"] = "assistant"): ChatMessage {
  return {
    id: "m-1",
    sessionId: "s-1",
    role,
    content,
    createdAt: 1,
  };
}

describe("toWire meta", () => {
  it("stamps model + usage + contextWindow on assistant rows", () => {
    const stored = JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: {
        input: 1234,
        output: 88,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1322,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    });
    const seen: string[] = [];
    const w = toWire(row(stored), {
      contextWindowFor: (id) => {
        seen.push(id);
        return id === "anthropic/claude-sonnet-4-6" ? 200_000 : undefined;
      },
    });
    expect(w.meta?.model).toBe("claude-sonnet-4-6");
    expect(w.meta?.usage).toEqual({ input: 1234, output: 88, totalTokens: 1322 });
    expect(w.meta?.contextWindow).toBe(200_000);
    expect(seen).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  it("derives totalTokens from input+output when missing", () => {
    const stored = JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "x" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: {
        input: 100,
        output: 20,
        // totalTokens deliberately omitted (legacy rows did this)
      },
      stopReason: "stop",
      timestamp: 1,
    });
    const w = toWire(row(stored));
    expect(w.meta?.usage).toEqual({ input: 100, output: 20, totalTokens: 120 });
  });

  it("omits meta when no model and no usage are present", () => {
    const stored = JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      api: "anthropic-messages",
      provider: "anthropic",
      // model + usage missing → nothing meaningful to display
      stopReason: "stop",
      timestamp: 1,
    });
    const w = toWire(row(stored));
    expect(w.meta).toBeUndefined();
  });

  it("does not stamp meta on user rows", () => {
    const stored = JSON.stringify({
      role: "user",
      content: [{ type: "text", text: "hi" }],
      timestamp: 1,
    });
    const w = toWire(row(stored, "user"));
    expect(w.meta).toBeUndefined();
  });

  it("works without a contextWindowFor resolver (legacy path)", () => {
    const stored = JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: { input: 1, output: 1, totalTokens: 2 },
      stopReason: "stop",
      timestamp: 1,
    });
    const w = toWire(row(stored));
    expect(w.meta?.model).toBe("claude-sonnet-4-6");
    expect(w.meta?.contextWindow).toBeUndefined();
  });
});
