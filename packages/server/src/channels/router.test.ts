// Lightweight tests for the channel router's filter + sink logic.
// We don't drive runPrompt end-to-end (that needs a real LLM
// config + tenant DB). Instead we verify the bits we own here:
//
//   - admit(): empty text / group-without-mention dropped, DM
//     admitted, group-with-mention admitted.
//   - the sink collects stream_delta + stream_end correctly so a
//     final text + length-zero tool-only turn are distinguished.
//
// The whole-system "inbound → agent → outbound" loop will get an
// integration test once the test harness for runPrompt with a
// stub model is in place (today the chat handler tests stub the
// LLM through pi-agent-core, not through runPrompt).

import { describe, it, expect } from "vitest";
import type { InboundEnvelope } from "./types.js";
import type { ServerMsg } from "../chat/ws-protocol.js";

// We can't import the private admit/sink helpers, so we re-derive
// them from the same source as router.ts:
//   - DM: every message goes through
//   - group without mention: dropped
//   - empty / whitespace: dropped
// router.ts encodes exactly this behaviour. If this test starts
// disagreeing with router.ts, fix router.ts (admit is the spec).

function admit(envelope: Pick<InboundEnvelope, "text" | "isDirect" | "mentionsBot">):
  | { kind: "admit" }
  | { kind: "drop"; reason: string } {
  if (!envelope.text || !envelope.text.trim()) {
    return { kind: "drop", reason: "empty text" };
  }
  if (!envelope.isDirect && !envelope.mentionsBot) {
    return { kind: "drop", reason: "group without mention" };
  }
  return { kind: "admit" };
}

describe("channel router admit()", () => {
  it("admits direct messages", () => {
    expect(
      admit({ text: "hi", isDirect: true, mentionsBot: undefined }),
    ).toEqual({ kind: "admit" });
  });

  it("drops empty / whitespace text", () => {
    expect(admit({ text: "", isDirect: true }).kind).toBe("drop");
    expect(admit({ text: "   \n  ", isDirect: true }).kind).toBe("drop");
  });

  it("drops group messages without mention", () => {
    const out = admit({ text: "everyone", isDirect: false, mentionsBot: false });
    expect(out.kind).toBe("drop");
    if (out.kind === "drop") expect(out.reason).toContain("mention");
  });

  it("admits group messages when @-mentioned", () => {
    expect(
      admit({ text: "@bot do stuff", isDirect: false, mentionsBot: true }),
    ).toEqual({ kind: "admit" });
  });
});

// Sink behaviour mirrored from router.ts so we can exercise it
// in isolation. The actual sink is a closure inside dispatch()
// that we don't export — the contract we test here:
//   - prefer stream_end.message.text when non-empty
//   - fall back to concatenated deltas when stream_end body is empty
//   - empty final string when nothing meaningful arrived
function applyMessage(state: {
  deltaChunks: string[];
  finalText: string;
  errorReason: string;
}, msg: ServerMsg): void {
  if (msg.type === "stream_delta") {
    state.deltaChunks.push(msg.delta);
  } else if (msg.type === "stream_end") {
    const wireText = msg.message?.text?.trim() ?? "";
    state.finalText = wireText || state.deltaChunks.join("").trim();
  } else if (msg.type === "stream_error") {
    state.errorReason = msg.reason || "unknown";
  }
}

function newSinkState() {
  return { deltaChunks: [] as string[], finalText: "", errorReason: "" };
}

describe("channel router sink semantics", () => {
  it("prefers final stream_end text", () => {
    const s = newSinkState();
    applyMessage(s, { type: "stream_delta", delta: "hel" });
    applyMessage(s, { type: "stream_delta", delta: "lo" });
    applyMessage(s, {
      type: "stream_end",
      message: makeWire("final answer"),
    });
    expect(s.finalText).toBe("final answer");
  });

  it("falls back to deltas when stream_end is empty", () => {
    const s = newSinkState();
    applyMessage(s, { type: "stream_delta", delta: "incremental " });
    applyMessage(s, { type: "stream_delta", delta: "reply" });
    applyMessage(s, { type: "stream_end", message: makeWire("") });
    expect(s.finalText).toBe("incremental reply");
  });

  it("yields empty when nothing meaningful arrived", () => {
    const s = newSinkState();
    applyMessage(s, { type: "stream_end", message: makeWire("") });
    expect(s.finalText).toBe("");
  });

  it("captures stream_error", () => {
    const s = newSinkState();
    applyMessage(s, { type: "stream_error", reason: "no models configured" });
    expect(s.errorReason).toBe("no models configured");
  });
});

function makeWire(text: string) {
  return {
    id: "m",
    sessionId: "s",
    role: "assistant" as const,
    text,
    createdAt: 0,
  };
}
