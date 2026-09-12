import { describe, it, expect } from "vitest";
import type {
  SessionTreeEntry,
  MessageEntry,
} from "@earendil-works/pi-agent-core";
import type {
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { progressiveHistoryTransform } from "./progressive-history.js";

// ── Fixture helpers ───────────────────────────────────────────────

let idCounter = 0;
function nextId(prefix = "e"): string {
  idCounter++;
  return `${prefix}_${idCounter}`;
}

function userEntry(text: string): MessageEntry {
  const msg: UserMessage = {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
  return {
    id: nextId(),
    parentId: null,
    timestamp: new Date().toISOString(),
    type: "message",
    message: msg,
  };
}

function assistantEntry(
  parts: Array<
    | { type: "text"; text: string }
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  >,
): MessageEntry {
  const msg: AssistantMessage = {
    role: "assistant",
    // TS narrows the union properly because we hand-shape `parts`
    content: parts as AssistantMessage["content"],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  return {
    id: nextId(),
    parentId: null,
    timestamp: new Date().toISOString(),
    type: "message",
    message: msg,
  };
}

function toolResultEntry(
  toolCallId: string,
  toolName: string,
  text: string,
): MessageEntry {
  const msg: ToolResultMessage = {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
  return {
    id: nextId(),
    parentId: null,
    timestamp: new Date().toISOString(),
    type: "message",
    message: msg,
  };
}

/**
 * Build a fake branch with N user turns. Each turn is
 * [user, assistant(toolCall), toolResult, assistant(text)].
 */
function fakeBranch(userTurns: number): SessionTreeEntry[] {
  const out: SessionTreeEntry[] = [];
  for (let t = 1; t <= userTurns; t++) {
    out.push(userEntry(`user msg ${t}`));
    const tcId = `tc_${t}`;
    out.push(
      assistantEntry([
        { type: "toolCall", id: tcId, name: "read_file", arguments: { path: `/f${t}` } },
      ]),
    );
    out.push(toolResultEntry(tcId, "read_file", `file ${t} contents (imagine 30KB here)`));
    out.push(assistantEntry([{ type: "text", text: `assistant reply ${t}` }]));
  }
  return out;
}

// ── Tests ─────────────────────────────────────────────────────────

describe("progressiveHistoryTransform", () => {
  it("no-ops when userTurns < minTurnsToEngage", () => {
    const branch = fakeBranch(10);
    const transform = progressiveHistoryTransform({
      minTurnsToEngage: 15,
      recentTurnsToKeep: 5,
    });
    const out = transform(branch);
    expect(out).toBe(branch); // same reference — didn't rebuild
  });

  it("engages at the threshold and keeps recent turns verbatim", () => {
    const branch = fakeBranch(20);
    const transform = progressiveHistoryTransform({
      minTurnsToEngage: 15,
      recentTurnsToKeep: 5,
    });
    const out = transform(branch);
    expect(out).not.toBe(branch);
    // The last 5 user turns should be untouched — that's 5 * 4 = 20
    // entries at the end (user, asst-toolCall, toolResult, asst-text
    // for each turn). Verify the LAST assistant with a toolCall is
    // still intact.
    const outArr = Array.from(out);
    const lastFiveEntries = outArr.slice(-20);
    // Find the assistant messages that have a toolCall inside the
    // recent region; they should preserve the toolCall verbatim.
    let recentToolCallsSeen = 0;
    for (const e of lastFiveEntries) {
      if (e.type !== "message" || e.message.role !== "assistant") continue;
      const content = e.message.content;
      if (!Array.isArray(content)) continue;
      for (const p of content) {
        if (p.type === "toolCall") recentToolCallsSeen++;
      }
    }
    expect(recentToolCallsSeen).toBe(5); // one per recent turn
  });

  it("replaces old assistant toolCalls with text stubs", () => {
    const branch = fakeBranch(20);
    const transform = progressiveHistoryTransform({
      minTurnsToEngage: 15,
      recentTurnsToKeep: 5,
    });
    const out = Array.from(transform(branch));
    // Old region = first 15 turns = 60 entries.
    const oldRegion = out.slice(0, 60);
    // Count assistant messages that still carry a toolCall part in
    // the old region — should be zero after transformation.
    let oldToolCallsRemaining = 0;
    let stubs = 0;
    for (const e of oldRegion) {
      if (e.type !== "message" || e.message.role !== "assistant") continue;
      const c = e.message.content;
      if (!Array.isArray(c)) continue;
      for (const p of c) {
        if (p.type === "toolCall") oldToolCallsRemaining++;
        if (p.type === "text" && /^\[archived call:/.test(p.text)) stubs++;
      }
    }
    expect(oldToolCallsRemaining).toBe(0);
    expect(stubs).toBe(15); // one per old turn
  });

  it("replaces old tool results with short stubs, preserving role/id", () => {
    const branch = fakeBranch(20);
    const transform = progressiveHistoryTransform({
      minTurnsToEngage: 15,
      recentTurnsToKeep: 5,
    });
    const out = Array.from(transform(branch));
    const oldRegion = out.slice(0, 60);
    let toolResults = 0;
    for (const e of oldRegion) {
      if (e.type !== "message" || e.message.role !== "toolResult") continue;
      toolResults++;
      const content = e.message.content;
      expect(Array.isArray(content)).toBe(true);
      expect(content.length).toBe(1);
      const first = content[0];
      expect(first?.type).toBe("text");
      expect(first?.type === "text" && first.text.startsWith("[archived result:")).toBe(true);
      // The toolCallId / toolName must be preserved verbatim.
      expect(e.message.toolCallId).toMatch(/^tc_\d+$/);
      expect(e.message.toolName).toBe("read_file");
      // The stub must include the id so the model knows what to recall.
      expect(first?.type === "text" && first.text.includes(e.message.toolCallId)).toBe(true);
    }
    expect(toolResults).toBe(15);
  });

  it("keeps user messages verbatim in both regions", () => {
    const branch = fakeBranch(20);
    const transform = progressiveHistoryTransform({
      minTurnsToEngage: 15,
      recentTurnsToKeep: 5,
    });
    const out = Array.from(transform(branch));
    let userSeen = 0;
    for (const e of out) {
      if (e.type !== "message" || e.message.role !== "user") continue;
      userSeen++;
      const c = e.message.content;
      expect(Array.isArray(c)).toBe(true);
      // Content must still be the original text (no stub replacement).
      const first = Array.isArray(c) ? c[0] : null;
      expect(first?.type === "text" && first.text.startsWith("user msg ")).toBe(true);
    }
    expect(userSeen).toBe(20);
  });

  it("passes non-message entries through unchanged", () => {
    const branch: SessionTreeEntry[] = [];
    // Prepend a compaction entry
    branch.push({
      id: "compaction_1",
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "compaction",
      summary: "earlier gist",
      tokensBefore: 100000,
    });
    branch.push(...fakeBranch(20));
    const transform = progressiveHistoryTransform({ minTurnsToEngage: 15, recentTurnsToKeep: 5 });
    const out = Array.from(transform(branch));
    expect(out[0]?.type).toBe("compaction");
    if (out[0]?.type === "compaction") {
      expect(out[0].summary).toBe("earlier gist");
    }
  });

  it("boundary math: recentTurnsToKeep > userTurns keeps everything", () => {
    // If we ask for 20 recent turns but only have 15, boundary should
    // clamp to 0 and no stubbing happens.
    const branch = fakeBranch(15);
    const transform = progressiveHistoryTransform({ minTurnsToEngage: 15, recentTurnsToKeep: 20 });
    const out = Array.from(transform(branch));
    // No stub markers anywhere.
    let stubs = 0;
    for (const e of out) {
      if (e.type !== "message" || e.message.role !== "assistant") continue;
      const c = e.message.content;
      if (!Array.isArray(c)) continue;
      for (const p of c) {
        if (p.type === "text" && /^\[archived/.test(p.text)) stubs++;
      }
    }
    expect(stubs).toBe(0);
  });

  it("preserves assistant text alongside stubbed tool calls", () => {
    // Older assistants that mix text + toolCall should keep the text.
    const mixed: MessageEntry = assistantEntry([
      { type: "text", text: "let me check that" },
      { type: "toolCall", id: "tc_mixed", name: "web_fetch", arguments: { url: "x" } },
    ]);
    const branch: SessionTreeEntry[] = [];
    for (let t = 1; t <= 20; t++) {
      branch.push(userEntry(`u${t}`));
      if (t === 3) {
        branch.push(mixed); // planted in old region
      } else {
        branch.push(assistantEntry([{ type: "text", text: `a${t}` }]));
      }
    }
    const out = Array.from(
      progressiveHistoryTransform({ minTurnsToEngage: 15, recentTurnsToKeep: 5 })(branch),
    );
    // Find our mixed assistant post-transform.
    const found = out.find(
      (e) =>
        e.type === "message" &&
        e.message.role === "assistant" &&
        Array.isArray(e.message.content) &&
        e.message.content.some(
          (p) => p.type === "text" && p.text === "let me check that",
        ),
    );
    expect(found).toBeDefined();
    if (found?.type === "message" && found.message.role === "assistant") {
      const c = found.message.content as Array<{ type: string; text?: string }>;
      // Original text preserved.
      const hasText = c.some((p) => p.type === "text" && p.text === "let me check that");
      // Tool call replaced with archived stub, not present as toolCall.
      const hasStub = c.some(
        (p) => p.type === "text" && typeof p.text === "string" && /^\[archived call:.*tc_mixed/.test(p.text),
      );
      const hasRawToolCall = c.some((p) => p.type === "toolCall");
      expect(hasText).toBe(true);
      expect(hasStub).toBe(true);
      expect(hasRawToolCall).toBe(false);
    }
  });
});
