// Regression tests for `mergeToolTurns` — the function strips
// `toolCalls` / `toolResult` (folded into `resolvedToolCalls`) but
// MUST pass everything else through. PR #51 added `attachments` and
// the original implementation reconstructed the row from a
// hand-rolled allowlist that silently dropped it; uploaded files
// vanished from the user bubble.

import { describe, expect, it } from "vitest";
import { mergeToolTurns } from "./merge-tool-turns";
import type { WireMessage } from "../types/chat";

function userRow(over: Partial<WireMessage> = {}): WireMessage {
  return {
    id: "u-1",
    sessionId: "s-1",
    role: "user",
    text: "hello",
    createdAt: 1,
    ...over,
  };
}

describe("mergeToolTurns", () => {
  it("preserves attachments on user messages", () => {
    const u = userRow({
      attachments: [
        { path: "/uploads/x.png", mimeType: "image/png", name: "x.png" },
      ],
    });
    const [out] = mergeToolTurns([u]);
    expect(out!.attachments).toEqual(u.attachments);
  });

  it("drops `tool` rows but keeps user/assistant rows verbatim", () => {
    const u = userRow();
    const a: WireMessage = {
      id: "a-1",
      sessionId: "s-1",
      role: "assistant",
      text: "ok",
      createdAt: 2,
    };
    const t: WireMessage = {
      id: "t-1",
      sessionId: "s-1",
      role: "tool",
      text: "ran",
      createdAt: 3,
      toolResult: { callId: "x", name: "y", ok: true, text: "ran" },
    };
    const out = mergeToolTurns([u, a, t]);
    expect(out.map((m) => m.id)).toEqual(["u-1", "a-1"]);
  });

  it("folds matching tool results into resolvedToolCalls and drops the wire-only fields", () => {
    const a: WireMessage = {
      id: "a-1",
      sessionId: "s-1",
      role: "assistant",
      text: "calling",
      createdAt: 1,
      toolCalls: [{ id: "c1", name: "list_dir", arguments: {} }],
    };
    const t: WireMessage = {
      id: "t-1",
      sessionId: "s-1",
      role: "tool",
      text: "...",
      createdAt: 2,
      toolResult: { callId: "c1", name: "list_dir", ok: true, text: "..." },
    };
    const [merged] = mergeToolTurns([a, t]);
    expect(merged!.resolvedToolCalls).toHaveLength(1);
    expect(merged!.resolvedToolCalls![0]!.result?.ok).toBe(true);
    // toolCalls/toolResult lifted, not duplicated on the merged row.
    const m = merged as unknown as Record<string, unknown>;
    expect(m.toolCalls).toBeUndefined();
    expect(m.toolResult).toBeUndefined();
  });

  // ADR-0004 N+4 fix: assistant messages now carry an ordered
  // `blocks` array. mergeToolTurns folds tool results into the
  // matching toolCall block AND keeps text blocks in author order.
  it("folds tool results into ordered blocks (text → toolCall → text → toolCall)", () => {
    const a: WireMessage = {
      id: "a-1",
      sessionId: "s-1",
      role: "assistant",
      text: "first.second.",
      createdAt: 1,
      toolCalls: [
        { id: "c1", name: "list_dir", arguments: {} },
        { id: "c2", name: "read_file", arguments: {} },
      ],
      blocks: [
        { kind: "text", text: "first." },
        { kind: "toolCall", id: "c1", name: "list_dir", arguments: {} },
        { kind: "text", text: "second." },
        { kind: "toolCall", id: "c2", name: "read_file", arguments: {} },
      ],
    };
    const t1: WireMessage = {
      id: "t-1",
      sessionId: "s-1",
      role: "tool",
      text: "ls done",
      createdAt: 2,
      toolResult: { callId: "c1", name: "list_dir", ok: true, text: "ls done" },
    };
    const t2: WireMessage = {
      id: "t-2",
      sessionId: "s-1",
      role: "tool",
      text: "file body",
      createdAt: 3,
      toolResult: { callId: "c2", name: "read_file", ok: true, text: "file body" },
    };
    const [merged] = mergeToolTurns([a, t1, t2]);
    expect(merged!.resolvedBlocks).toHaveLength(4);
    expect(merged!.resolvedBlocks![0]!).toEqual({ kind: "text", text: "first." });
    expect(merged!.resolvedBlocks![1]!.kind).toBe("toolCall");
    if (merged!.resolvedBlocks![1]!.kind === "toolCall") {
      expect(merged!.resolvedBlocks![1]!.result?.text).toBe("ls done");
    }
    expect(merged!.resolvedBlocks![2]!).toEqual({ kind: "text", text: "second." });
    if (merged!.resolvedBlocks![3]!.kind === "toolCall") {
      expect(merged!.resolvedBlocks![3]!.result?.text).toBe("file body");
    }
    // Wire-only fields lifted off.
    const m = merged as unknown as Record<string, unknown>;
    expect(m.blocks).toBeUndefined();
  });

  it("legacy assistant rows without blocks still work via resolvedToolCalls", () => {
    const a: WireMessage = {
      id: "a-1",
      sessionId: "s-1",
      role: "assistant",
      text: "hi",
      createdAt: 1,
      toolCalls: [{ id: "c1", name: "x", arguments: {} }],
    };
    const [merged] = mergeToolTurns([a]);
    expect(merged!.resolvedBlocks).toBeUndefined();
    expect(merged!.resolvedToolCalls).toHaveLength(1);
  });
});
