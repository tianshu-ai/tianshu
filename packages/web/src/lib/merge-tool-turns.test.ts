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
});
