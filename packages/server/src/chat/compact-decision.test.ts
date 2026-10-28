// Tests for buildMidTurnCompactor — the prepareNextTurn hook that
// runs compaction between tool iterations.

import { describe, it, expect, vi } from "vitest";
import { buildMidTurnCompactor } from "./compact-decision.js";

// Minimal mock types matching what buildMidTurnCompactor needs
function makeEntry(role: string, chars: number) {
  // user messages use string content; assistant uses content-block array
  const content =
    role === "assistant"
      ? [{ type: "text", text: "x".repeat(chars) }]
      : "x".repeat(chars);
  return {
    type: "message" as const,
    message: { role, content },
  };
}

function makeMocks(opts: {
  /** Estimated tokens for the branch (chars/4). */
  branchChars: number;
  contextWindow: number;
  compactResult?: { ok: boolean; error?: { _tag?: string; message?: string } };
}) {
  const entries = [
    makeEntry("user", 100),
    makeEntry("assistant", opts.branchChars - 100),
  ];

  const piSession = {
    findEntries: vi.fn().mockResolvedValue(entries),
    metadata: { id: "test-session" },
  };

  const compactResult = opts.compactResult ?? {
    ok: true,
    value: {
      compaction: {
        summary: "test summary",
        summarisedCount: 5,
        retainedTail: [{ role: "user" }, { role: "assistant" }],
      },
    },
  };

  const lane = {
    compact: vi.fn().mockResolvedValue(compactResult),
  };

  return { piSession, harness: {} as any, lane: lane as any, entries };
}

describe("buildMidTurnCompactor", () => {
  it("does nothing when below threshold", async () => {
    const contextWindow = 100_000;
    const { piSession, harness, lane } = makeMocks({
      branchChars: 10_000, // ~2500 tokens, well below 80% of 100K
      contextWindow,
    });

    const fn = buildMidTurnCompactor({
      piSession: piSession as any,
      harness,
      lane,
      context: {} as any,
      contextWindow,
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    });

    const result = await fn();
    expect(result).toBeUndefined();
    expect(lane.compact).not.toHaveBeenCalled();
  });

  it("runs compaction when above threshold", async () => {
    const contextWindow = 10_000;
    const { piSession, harness, lane } = makeMocks({
      branchChars: 40_000, // ~10K tokens, above 10K window
      contextWindow,
    });

    const onCompacted = vi.fn();
    const fn = buildMidTurnCompactor({
      piSession: piSession as any,
      harness,
      lane,
      context: {} as any,
      contextWindow,
      settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
      onCompacted,
    });

    const result = await fn();
    expect(result).toBeUndefined();
    expect(lane.compact).toHaveBeenCalled();
    expect(onCompacted).toHaveBeenCalled();
  });

  it("prevents reentrant compaction", async () => {
    const contextWindow = 10_000;
    const { piSession, harness, lane } = makeMocks({
      branchChars: 40_000,
      contextWindow,
    });

    // Make compact() slow so we can test reentrancy
    let resolveCompact: () => void;
    lane.compact.mockReturnValue(
      new Promise((r) => {
        resolveCompact = () =>
          r({
            ok: true,
            value: {
              compaction: { summary: "s", summarisedCount: 1, retainedTail: [] },
            },
          });
      }),
    );

    const fn = buildMidTurnCompactor({
      piSession: piSession as any,
      harness,
      lane,
      context: {} as any,
      contextWindow,
      settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
    });

    // Fire two concurrent calls
    const p1 = fn();
    const p2 = fn(); // should skip because inFlight=true
    resolveCompact!();
    await p1;
    await p2;

    // compact() should only be called once
    expect(lane.compact).toHaveBeenCalledTimes(1);
  });

  it("handles nothing_to_compact gracefully", async () => {
    const contextWindow = 10_000;
    const { piSession, harness, lane } = makeMocks({
      branchChars: 40_000,
      contextWindow,
      compactResult: {
        ok: false,
        error: { _tag: "NothingToCompact", message: "Nothing to compact" },
      },
    });

    const onCompacted = vi.fn();
    const fn = buildMidTurnCompactor({
      piSession: piSession as any,
      harness,
      lane,
      context: {} as any,
      contextWindow,
      settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
      onCompacted,
    });

    const result = await fn();
    expect(result).toBeUndefined();
    expect(onCompacted).not.toHaveBeenCalled(); // not compacted
  });

  it("returns undefined even on error (never blocks the loop)", async () => {
    const contextWindow = 10_000;
    const { piSession, harness, lane } = makeMocks({
      branchChars: 40_000,
      contextWindow,
    });

    lane.compact.mockRejectedValue(new Error("DB locked"));

    const fn = buildMidTurnCompactor({
      piSession: piSession as any,
      harness,
      lane,
      context: {} as any,
      contextWindow,
      settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
    });

    // Should not throw — always returns undefined
    const result = await fn();
    expect(result).toBeUndefined();
  });

  it("skips when contextWindow is undefined", async () => {
    const { piSession, harness, lane } = makeMocks({
      branchChars: 40_000,
      contextWindow: 10_000,
    });

    const fn = buildMidTurnCompactor({
      piSession: piSession as any,
      harness,
      lane,
      context: {} as any,
      contextWindow: undefined, // no window info
      settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
    });

    const result = await fn();
    expect(result).toBeUndefined();
    expect(lane.compact).not.toHaveBeenCalled();
  });
});
