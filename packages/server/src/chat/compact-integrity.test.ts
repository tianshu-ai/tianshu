/**
 * Tests that compaction produces a valid message sequence for the LLM.
 *
 * Core invariant: after compact + fork, the kept tail must be a valid
 * LLM conversation — no orphan tool_result without a preceding
 * assistant tool_call, no mid-turn cuts.
 */

import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  Message,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { planCompact } from "./compact.js";
import { filterOrphanToolResults } from "./messages.js";
import type { ChatMessage } from "./messages.js";

// ─── helpers ──────────────────────────────────────────────────────

let seq = 0;

function user(text: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text } as TextContent],
    timestamp: ++seq,
  };
}

function assistant(text: string, toolCalls?: { id: string; name: string }[]): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (text) content.push({ type: "text", text } as TextContent);
  if (toolCalls) {
    for (const tc of toolCalls) {
      content.push({
        type: "toolCall",
        id: tc.id,
        name: tc.name,
        arguments: {},
      } as ToolCall);
    }
  }
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: ++seq,
  };
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "some_tool",
    content: [{ type: "text", text } as TextContent],
    isError: false,
    timestamp: ++seq,
  };
}

function summaryAssistant(summary: string): AssistantMessage {
  return assistant(`[Conversation summary — generated at 2026-01-01T00:00:00.000Z]\n\n${summary}`);
}

function row(m: Message, idx: number): ChatMessage {
  return {
    id: `m-${idx}`,
    sessionId: "s",
    role: m.role === "toolResult" ? "tool" : m.role,
    content: JSON.stringify(m),
    createdAt: idx,
  };
}

/** Check that every toolResult in the list has a matching tool_call
 *  in a preceding assistant message. */
function assertNoOrphanToolResults(messages: Message[]): void {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const block of m.content) {
        const b = block as unknown as Record<string, unknown>;
        if (b.type === "toolCall" && typeof b.id === "string") {
          ids.add(b.id);
        }
      }
    }
  }
  for (const m of messages) {
    if (m.role === "toolResult" && "toolCallId" in m) {
      const tcId = (m as ToolResultMessage).toolCallId;
      if (!ids.has(tcId)) {
        throw new Error(
          `Orphan toolResult: toolCallId="${tcId}" has no matching tool_call in any assistant message`,
        );
      }
    }
  }
}

/** Check that the message sequence doesn't start with a toolResult
 *  (LLM APIs require a user or system message first, or at least
 *  an assistant with the matching tool_call). */
function assertValidStart(messages: Message[]): void {
  if (messages.length > 0 && messages[0]!.role === "toolResult") {
    throw new Error("Message sequence starts with toolResult — invalid for LLM");
  }
}

// ─── planCompact turn integrity ───────────────────────────────────

describe("planCompact turn integrity", () => {
  it("keeps a complete tool turn when the last user is followed by tool calls", () => {
    const msgs: Message[] = [
      user("u1"),
      assistant("a1"),
      user("u2"),
      assistant("", [{ id: "tc1", name: "read_file" }]),
      toolResult("tc1", "file contents"),
      assistant("here is the file"),
    ];
    const rows = msgs.map((m, i) => row(m, i));
    const plan = planCompact(msgs, rows);

    // The last user is at index 2, so keep from index 2 onward
    expect(plan.keep.length).toBeGreaterThanOrEqual(4);
    assertNoOrphanToolResults(plan.keep);
    assertValidStart(plan.keep);
  });

  it("does not cut between tool_call and tool_result", () => {
    const msgs: Message[] = [
      user("u1"),
      assistant("a1", [{ id: "tc1", name: "t1" }]),
      toolResult("tc1", "r1"),
      assistant("done1"),
      user("u2"),
      assistant("a2", [{ id: "tc2", name: "t2" }, { id: "tc3", name: "t3" }]),
      toolResult("tc2", "r2"),
      toolResult("tc3", "r3"),
      assistant("done2"),
    ];
    const rows = msgs.map((m, i) => row(m, i));
    const plan = planCompact(msgs, rows);

    assertNoOrphanToolResults(plan.keep);
    assertValidStart(plan.keep);
  });

  it("keeps everything when there are only 2 messages", () => {
    const msgs: Message[] = [user("hi"), assistant("hello")];
    const rows = msgs.map((m, i) => row(m, i));
    const plan = planCompact(msgs, rows);

    expect(plan.toSummarise).toHaveLength(0);
    expect(plan.keep).toHaveLength(2);
  });
});

// ─── filterOrphanToolResults ──────────────────────────────────────

describe("filterOrphanToolResults", () => {
  it("keeps toolResults that have matching tool_calls", () => {
    const msgs: Message[] = [
      user("u1"),
      assistant("", [{ id: "tc1", name: "t1" }]),
      toolResult("tc1", "result"),
      assistant("done"),
    ];
    const filtered = filterOrphanToolResults(msgs);
    expect(filtered).toHaveLength(4);
  });

  it("drops toolResults whose tool_call was lost (post-compact scenario)", () => {
    // Simulates: summary assistant (no tool_calls) + orphan toolResults
    // from a broken fork_tail copy
    const msgs: Message[] = [
      summaryAssistant("prior context summary"),  // no tool_calls
      toolResult("tc_gone_1", "orphan result 1"),
      toolResult("tc_gone_2", "orphan result 2"),
      user("hello"),
      assistant("hi there"),
    ];
    const filtered = filterOrphanToolResults(msgs);
    expect(filtered).toHaveLength(3); // summary + user + assistant
    expect(filtered.every(m => m.role !== "toolResult")).toBe(true);
  });

  it("drops only the orphan toolResults, keeps valid ones", () => {
    const msgs: Message[] = [
      summaryAssistant("summary"),
      toolResult("tc_orphan", "orphan"),           // orphan — no matching tool_call
      user("do something"),
      assistant("", [{ id: "tc_valid", name: "run" }]),
      toolResult("tc_valid", "ran successfully"),   // valid — tc_valid exists
      assistant("done"),
    ];
    const filtered = filterOrphanToolResults(msgs);
    expect(filtered).toHaveLength(5); // summary, user, assistant(tc), toolResult(tc_valid), assistant
    // The orphan is gone
    expect(
      filtered.some(
        m => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === "tc_orphan",
      ),
    ).toBe(false);
    // The valid one remains
    expect(
      filtered.some(
        m => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === "tc_valid",
      ),
    ).toBe(true);
  });

  it("handles an empty message list", () => {
    expect(filterOrphanToolResults([])).toHaveLength(0);
  });

  it("handles messages with no toolResults at all", () => {
    const msgs: Message[] = [user("hi"), assistant("hello")];
    const filtered = filterOrphanToolResults(msgs);
    expect(filtered).toHaveLength(2);
  });

  it("handles multiple tool_calls in one assistant message", () => {
    const msgs: Message[] = [
      user("u1"),
      assistant("", [{ id: "tc1", name: "a" }, { id: "tc2", name: "b" }, { id: "tc3", name: "c" }]),
      toolResult("tc1", "r1"),
      toolResult("tc2", "r2"),
      toolResult("tc3", "r3"),
      assistant("all done"),
    ];
    const filtered = filterOrphanToolResults(msgs);
    expect(filtered).toHaveLength(6); // all kept
  });

  it("drops toolResult when assistant with tool_call was error-skipped", () => {
    // If loadAgentHistoryForSession skips a broken assistant,
    // its tool_calls vanish — the toolResults become orphans.
    const msgs: Message[] = [
      user("u1"),
      // (broken assistant was skipped — not in the list)
      toolResult("tc_from_broken", "result from broken turn"),
      user("retry"),
      assistant("ok"),
    ];
    const filtered = filterOrphanToolResults(msgs);
    expect(filtered).toHaveLength(3); // user, user, assistant
    expect(filtered.some(m => m.role === "toolResult")).toBe(false);
  });
});

// ─── End-to-end: simulated compact → fork → filter ────────────────

describe("compact + fork simulation", () => {
  it("full cycle: planCompact + simulated fork + filterOrphanToolResults produces valid history", () => {
    // Build a realistic conversation: 3 turns, middle one has tools
    const msgs: Message[] = [
      user("list files in /src"),
      assistant("", [{ id: "tc1", name: "list_dir" }]),
      toolResult("tc1", "index.ts\napp.ts"),
      assistant("I see 2 files: index.ts and app.ts"),
      user("read index.ts"),
      assistant("", [{ id: "tc2", name: "read_file" }]),
      toolResult("tc2", "export function main() { ... }"),
      assistant("Here's the content of index.ts"),
      user("now fix the bug on line 5"),
      assistant("", [{ id: "tc3", name: "edit_file" }]),
      toolResult("tc3", "file edited"),
      assistant("Fixed the bug"),
    ];
    const rows = msgs.map((m, i) => row(m, i));

    // Step 1: plan
    const plan = planCompact(msgs, rows);
    expect(plan.toSummarise.length).toBeGreaterThan(0);
    expect(plan.keep.length).toBeGreaterThan(0);

    // Step 2: simulate fork — summary + kept tail
    const forked: Message[] = [
      summaryAssistant("User listed files, read index.ts, asked to fix bug on line 5"),
      ...plan.keep,
    ];

    // Step 3: filter orphans (in case planCompact cut mid-turn)
    const final = filterOrphanToolResults(forked);

    // Invariants
    assertNoOrphanToolResults(final);
    assertValidStart(final);
    expect(final.length).toBeGreaterThanOrEqual(2); // at least summary + something
  });

  it("worst case: all kept messages are tool_results (everything gets cleaned)", () => {
    // Pathological: planCompact returned only toolResults (shouldn't
    // happen with turn-boundary logic, but filterOrphanToolResults
    // must still produce valid output).
    const forked: Message[] = [
      summaryAssistant("prior context"),
      toolResult("tc_gone1", "orphan 1"),
      toolResult("tc_gone2", "orphan 2"),
    ];
    const final = filterOrphanToolResults(forked);
    assertNoOrphanToolResults(final);
    // Only the summary remains
    expect(final).toHaveLength(1);
    expect(final[0]!.role).toBe("assistant");
  });
});
