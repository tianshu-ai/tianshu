import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { progressiveHistoryTransform } from "./progressive-history.js";

// ── Fixture helpers ───────────────────────────────────────────────
//
// pi 0.85 migration: the transform now operates on AgentMessage[]
// (called via AgentHarnessOptions.toProviderMessages) instead of the
// old SessionTreeEntry[] shape. Tests build message arrays directly;
// helpers below hand back one message per call so a "turn" is a
// sequence of pushed messages, not a wrapped entry.
//
// We keep the same semantic coverage as the 0.82 tests: threshold
// engagement, boundary math, per-role rewrites, `[system note]` meta
// insertion, and the plugin-system / system-note prefix filter.

function userMsg(text: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function assistantMsg(
  parts: Array<
    | { type: "text"; text: string }
    | {
        type: "toolCall";
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }
  >,
): AssistantMessage {
  return {
    role: "assistant",
    content: parts as AssistantMessage["content"],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
}

function toolResultMsg(
  toolCallId: string,
  toolName: string,
  text: string,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as ToolResultMessage;
}

/**
 * Build a fake message list with N user turns. Each turn is
 * [user, assistant(toolCall), toolResult, assistant(text)].
 */
function fakeMessages(userTurns: number): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (let t = 1; t <= userTurns; t++) {
    out.push(userMsg(`user msg ${t}`));
    const tcId = `tc_${t}`;
    out.push(
      assistantMsg([
        {
          type: "toolCall",
          id: tcId,
          name: "read_file",
          arguments: { path: `/f${t}` },
        },
      ]),
    );
    out.push(
      toolResultMsg(tcId, "read_file", `file ${t} contents (imagine 30KB here)`),
    );
    out.push(assistantMsg([{ type: "text", text: `assistant reply ${t}` }]));
  }
  return out;
}

// ── Tests ─────────────────────────────────────────────────────────

describe("progressiveHistoryTransform", () => {
  it("no-ops when userTurns < minTurnsToEngage", () => {
    const messages = fakeMessages(10);
    const transform = progressiveHistoryTransform({
      minTurnsToEngage: 15,
      recentTurnsToKeep: 5,
    });
    const out = transform(messages);
    // Under threshold — the transform returns the input verbatim
    // (element-by-element identical). We can't require reference
    // equality anymore because the new hook always returns a fresh
    // array to satisfy Message[] type discipline; compare by strict
    // deep equality instead.
    expect(out).toStrictEqual(messages);
  });

  it("engages at the threshold and keeps recent turns verbatim", () => {
    const messages = fakeMessages(20);
    const transform = progressiveHistoryTransform({
      minTurnsToEngage: 15,
      recentTurnsToKeep: 5,
    });
    const out = transform(messages);
    // Above threshold — the transform inserts a meta note and
    // rewrites the old region, so length grows by 1.
    expect(out.length).toBe(messages.length + 1);
    // The last 5 turns should be untouched — that's 5 * 4 = 20
    // messages at the end. Verify the LAST assistant with a toolCall
    // is still intact (original path arg, no archived marker).
    const lastFive = out.slice(-20);
    let recentToolCallsSeen = 0;
    for (const m of lastFive) {
      if (m.role !== "assistant") continue;
      const content = m.content;
      if (!Array.isArray(content)) continue;
      for (const p of content) {
        if (p.type === "toolCall") {
          recentToolCallsSeen++;
          expect(
            (p.arguments as { __archived?: unknown } | undefined)?.__archived,
          ).toBeUndefined();
        }
      }
    }
    expect(recentToolCallsSeen).toBe(5); // one per recent turn
  });

  it("shrinks old assistant toolCall arguments to a marker but keeps the block", () => {
    // We must NOT drop tool_use blocks or convert them to text — the
    // provider (Anthropic/OpenAI) requires tool_use ↔ tool_result to
    // be paired, and breaking that pairing yields `400 status code
    // (no body)`. So old toolCalls keep type="toolCall", id, name;
    // only `arguments` gets replaced with a stub marker.
    const messages = fakeMessages(20);
    const transform = progressiveHistoryTransform({
      minTurnsToEngage: 15,
      recentTurnsToKeep: 5,
    });
    const out = transform(messages);

    // Recent region is the last 20 messages (5 turns × 4 messages).
    // Everything before that is the old region.
    const oldRegion = out.slice(0, out.length - 20);

    let oldStubbedCalls = 0;
    let oldFullCalls = 0;
    for (const m of oldRegion) {
      if (m.role !== "assistant") continue;
      const c = m.content;
      if (!Array.isArray(c)) continue;
      for (const p of c) {
        if (p.type !== "toolCall") continue;
        const args = p.arguments as Record<string, unknown> | undefined;
        expect(p.id).toMatch(/^tc_\d+$/);
        expect(typeof p.name).toBe("string");
        if (args && args.__archived === true) {
          oldStubbedCalls++;
          expect(typeof args.hint).toBe("string");
          expect(String(args.hint)).toContain(p.id);
        } else {
          oldFullCalls++;
        }
      }
    }
    expect(oldStubbedCalls).toBe(15); // one per old turn
    expect(oldFullCalls).toBe(0); // no full arguments left in old region
  });

  it("replaces old tool results with short stubs, preserving role/id", () => {
    const messages = fakeMessages(20);
    const transform = progressiveHistoryTransform({
      minTurnsToEngage: 15,
      recentTurnsToKeep: 5,
    });
    const out = transform(messages);
    const oldRegion = out.slice(0, out.length - 20);
    let toolResults = 0;
    for (const m of oldRegion) {
      if (m.role !== "toolResult") continue;
      toolResults++;
      const content = m.content;
      expect(Array.isArray(content)).toBe(true);
      expect(content.length).toBe(1);
      const first = content[0];
      expect(first?.type).toBe("text");
      expect(
        first?.type === "text" && first.text.startsWith("[archived result:"),
      ).toBe(true);
      expect(m.toolCallId).toMatch(/^tc_\d+$/);
      expect(m.toolName).toBe("read_file");
      expect(
        first?.type === "text" && first.text.includes(m.toolCallId),
      ).toBe(true);
    }
    expect(toolResults).toBe(15);
  });

  it("keeps user text verbatim; tags old-region turns with [turn N]", () => {
    const messages = fakeMessages(20);
    const transform = progressiveHistoryTransform({
      minTurnsToEngage: 15,
      recentTurnsToKeep: 5,
    });
    const out = transform(messages);

    let userSeen = 0;
    let tagged = 0;
    const taggedTurnsSeen: number[] = [];
    let untaggedOriginals = 0;
    for (const m of out) {
      if (m.role !== "user") continue;
      const c = m.content;
      if (!Array.isArray(c)) continue;
      const first = c[0];
      const firstText = first?.type === "text" ? first.text : "";
      // Skip our own meta note (starts with `[system note] Progressive`).
      if (firstText.startsWith("[system note]")) continue;
      userSeen++;
      const turnMatch = firstText.match(/^\[turn (\d+)\]$/);
      if (turnMatch) {
        tagged++;
        taggedTurnsSeen.push(parseInt(turnMatch[1]!, 10));
        // The second block must be the ORIGINAL text, verbatim.
        const second = c[1];
        expect(second?.type).toBe("text");
        expect(
          second?.type === "text" && second.text.startsWith("user msg "),
        ).toBe(true);
      } else {
        expect(firstText.startsWith("user msg ")).toBe(true);
        untaggedOriginals++;
      }
    }
    expect(userSeen).toBe(20);
    expect(tagged).toBe(15);
    expect(untaggedOriginals).toBe(5);
    expect(taggedTurnsSeen).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it("prepends a [system note] meta message before old region", () => {
    const messages = fakeMessages(20);
    const out = progressiveHistoryTransform({
      minTurnsToEngage: 15,
      recentTurnsToKeep: 5,
    })(messages);
    const metas: string[] = [];
    for (const m of out) {
      if (m.role !== "user") continue;
      const c = m.content;
      if (!Array.isArray(c)) continue;
      const first = c[0];
      if (
        first?.type === "text" &&
        first.text.startsWith("[system note] Progressive-history")
      ) {
        metas.push(first.text);
      }
    }
    expect(metas.length).toBe(1);
    expect(metas[0]).toContain("turns 1–15");
    expect(metas[0]).toContain("recall_tool_call");
    expect(metas[0]).toContain("recall_range");
  });

  it("boundary math: recentTurnsToKeep > userTurns keeps everything", () => {
    // If we ask for 20 recent turns but only have 15, boundary should
    // clamp to 0 and no stubbing happens.
    const messages = fakeMessages(15);
    const transform = progressiveHistoryTransform({
      minTurnsToEngage: 15,
      recentTurnsToKeep: 20,
    });
    const out = transform(messages);
    let stubs = 0;
    for (const m of out) {
      if (m.role !== "assistant") continue;
      const c = m.content;
      if (!Array.isArray(c)) continue;
      for (const p of c) {
        if (p.type === "text" && /^\[archived/.test(p.text)) stubs++;
      }
    }
    expect(stubs).toBe(0);
  });

  it("skips [plugin-system] injected user notices when counting turns", () => {
    const messages: AgentMessage[] = [];
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text:
            '[plugin-system] Plugin "Custom UI Shell" (custom-ui) was just ENABLED. ' +
            "Newly available — no agent-facing surface. Use these when they help.",
        },
      ],
      timestamp: Date.now(),
    } as UserMessage);
    messages.push(...fakeMessages(20));

    const transform = progressiveHistoryTransform({
      minTurnsToEngage: 15,
      recentTurnsToKeep: 5,
    });
    const out = transform(messages);

    // The [plugin-system] notice must NOT count toward turn total.
    // With 20 real turns and recentTurnsToKeep=5, exactly 5 turns
    // should have their toolCalls left with original arguments; the
    // 15 old turns' toolCalls should carry the archived marker.
    let recentFullArgs = 0;
    let oldArchivedArgs = 0;
    for (const m of out) {
      if (m.role !== "assistant") continue;
      const c = m.content;
      if (!Array.isArray(c)) continue;
      for (const p of c) {
        if (p.type !== "toolCall") continue;
        const args = p.arguments as Record<string, unknown> | undefined;
        if (args && args.__archived === true) oldArchivedArgs++;
        else recentFullArgs++;
      }
    }
    expect(recentFullArgs).toBe(5);
    expect(oldArchivedArgs).toBe(15);

    // Notice itself still present verbatim.
    const notice = out.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some(
          (p) =>
            p.type === "text" &&
            typeof p.text === "string" &&
            p.text.startsWith("[plugin-system]"),
        ),
    );
    expect(notice).toBeDefined();
  });

  it("skips [system note] injected user notices when counting turns", () => {
    const messages: AgentMessage[] = [];
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text:
            "[system note] tianshu upgraded from 0.48.7 to 0.48.8 while this conversation was open. New tool available: ...",
        },
      ],
      timestamp: Date.now(),
    } as UserMessage);
    // 14 real turns — with the notice miscounted this would engage
    // the transform (15 total). Correct behavior: 14 real, transform
    // no-op (returns the input verbatim by deep equality).
    messages.push(...fakeMessages(14));

    const transform = progressiveHistoryTransform({
      minTurnsToEngage: 15,
      recentTurnsToKeep: 5,
    });
    const out = transform(messages);
    expect(out).toStrictEqual(messages);
  });

  it("preserves assistant text alongside stubbed tool calls", () => {
    // Older assistants that mix text + toolCall should keep the text
    // AND keep the toolCall block (with archived arguments).
    const mixed = assistantMsg([
      { type: "text", text: "let me check that" },
      {
        type: "toolCall",
        id: "tc_mixed",
        name: "web_fetch",
        arguments: { url: "x" },
      },
    ]);
    const messages: AgentMessage[] = [];
    for (let t = 1; t <= 20; t++) {
      messages.push(userMsg(`u${t}`));
      if (t === 3) {
        messages.push(mixed); // planted in old region
      } else {
        messages.push(assistantMsg([{ type: "text", text: `a${t}` }]));
      }
    }
    const out = progressiveHistoryTransform({
      minTurnsToEngage: 15,
      recentTurnsToKeep: 5,
    })(messages);
    const found = out.find(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some(
          (p) => p.type === "text" && p.text === "let me check that",
        ),
    );
    expect(found).toBeDefined();
    if (found && found.role === "assistant") {
      const c = found.content as Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        arguments?: Record<string, unknown>;
      }>;
      const hasText = c.some(
        (p) => p.type === "text" && p.text === "let me check that",
      );
      const toolCall = c.find(
        (p) => p.type === "toolCall" && p.id === "tc_mixed",
      );
      expect(hasText).toBe(true);
      expect(toolCall).toBeDefined();
      expect(toolCall?.name).toBe("web_fetch");
      expect(toolCall?.arguments?.__archived).toBe(true);
      expect(String(toolCall?.arguments?.hint)).toContain("tc_mixed");
      // Original url arg gone.
      expect(toolCall?.arguments?.url).toBeUndefined();
    }
  });
});
