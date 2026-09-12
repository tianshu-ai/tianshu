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

  it("shrinks old assistant toolCall arguments to a marker but keeps the block", () => {
    // We must NOT drop tool_use blocks or convert them to text — the
    // provider (Anthropic/OpenAI) requires tool_use ↔ tool_result to
    // be paired, and breaking that pairing yields `400 status code
    // (no body)`. So old toolCalls keep type="toolCall", id, name;
    // only `arguments` gets replaced with a stub marker.
    const branch = fakeBranch(20);
    const transform = progressiveHistoryTransform({
      minTurnsToEngage: 15,
      recentTurnsToKeep: 5,
    });
    const out = Array.from(transform(branch));
    const oldRegion = out.slice(0, 60);

    let oldStubbedCalls = 0;
    let oldFullCalls = 0;
    for (const e of oldRegion) {
      if (e.type !== "message" || e.message.role !== "assistant") continue;
      const c = e.message.content;
      if (!Array.isArray(c)) continue;
      for (const p of c) {
        if (p.type !== "toolCall") continue;
        const args = p.arguments as Record<string, unknown> | undefined;
        // Structural fields preserved.
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
    expect(oldFullCalls).toBe(0);     // no full arguments left in old region
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

  it("skips [plugin-system] injected user notices when counting turns", () => {
    // Simulate what tianshu's plugin-enable/disable path writes to the
    // session as a role='user' notice. The transform must NOT treat it
    // as a real user turn, otherwise the recent/old boundary drifts.
    const branch: SessionTreeEntry[] = [];
    // First entry: a system-injected "user" notice (like the one that
    // caused the real 6068e0e1 bug on 2026-09-12).
    const systemNotice: UserMessage = {
      role: "user",
      content: [{
        type: "text",
        text:
          '[plugin-system] Plugin "Custom UI Shell" (custom-ui) was just ENABLED. ' +
          "Newly available — no agent-facing surface. Use these when they help.",
      }],
      timestamp: Date.now(),
    };
    branch.push({
      id: nextId(),
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "message",
      message: systemNotice,
    });
    // Now append 20 real user turns.
    branch.push(...fakeBranch(20));

    const transform = progressiveHistoryTransform({
      minTurnsToEngage: 15,
      recentTurnsToKeep: 5,
    });
    const out = Array.from(transform(branch));

    // The [plugin-system] notice should NOT count toward turn total.
    // With 20 real turns and recentTurnsToKeep=5, exactly 5 turns
    // should have their toolCalls left with original arguments (in
    // the recent region). The 15 old turns' toolCalls stay as blocks
    // but with archived-marker arguments.
    let recentFullArgs = 0;
    let oldArchivedArgs = 0;
    for (const e of out) {
      if (e.type !== "message" || e.message.role !== "assistant") continue;
      const c = e.message.content;
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

    // And the notice itself must still be present verbatim.
    const notice = out.find(
      (e) =>
        e.type === "message" &&
        e.message.role === "user" &&
        Array.isArray(e.message.content) &&
        e.message.content.some(
          (p) => p.type === "text" && typeof p.text === "string" && p.text.startsWith("[plugin-system]"),
        ),
    );
    expect(notice).toBeDefined();
  });

  it("skips [system note] injected user notices when counting turns", () => {
    // Same pattern as above, but with the tool-catalog-refresh prefix.
    const branch: SessionTreeEntry[] = [];
    const upgradeNotice: UserMessage = {
      role: "user",
      content: [{
        type: "text",
        text: "[system note] tianshu upgraded from 0.48.7 to 0.48.8 while this conversation was open. New tool available: ...",
      }],
      timestamp: Date.now(),
    };
    branch.push({
      id: nextId(),
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "message",
      message: upgradeNotice,
    });
    // 14 real turns — with the notice miscounted this would engage the
    // transform (15 total). Correct behavior: 14 real, transform no-op.
    branch.push(...fakeBranch(14));

    const transform = progressiveHistoryTransform({
      minTurnsToEngage: 15,
      recentTurnsToKeep: 5,
    });
    const out = transform(branch);
    expect(out).toBe(branch); // same reference — no-op
  });

  it("preserves assistant text alongside stubbed tool calls", () => {
    // Older assistants that mix text + toolCall should keep the text
    // AND keep the toolCall block (with archived arguments).
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
      const c = found.message.content as Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        arguments?: Record<string, unknown>;
      }>;
      // Original text preserved.
      const hasText = c.some((p) => p.type === "text" && p.text === "let me check that");
      // ToolCall block is STILL present (with stubbed args) so
      // tool_use ↔ tool_result pairing is preserved.
      const toolCall = c.find((p) => p.type === "toolCall" && p.id === "tc_mixed");
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
