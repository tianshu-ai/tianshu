// Auto-compact decision tests.
//
// `shouldCompactBranch` is the pure decision function the chat
// handler runs at the end of every turn to decide whether to fire
// `harness.compact()` before the next prompt. We test the surface
// directly so the runtime path stays unbranchy.

import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  TextContent,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { shouldCompactBranch, tryAutoCompact } from "./handler.js";

function userMessageEntry(text: string): SessionTreeEntry {
  return {
    type: "message",
    id: `m_user_${text.slice(0, 8)}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content: [{ type: "text", text } as TextContent],
      timestamp: 1,
    } as UserMessage,
  };
}

function assistantWithUsage(totalTokens: number): SessionTreeEntry {
  const msg: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "ok" } as TextContent],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake",
    usage: {
      input: totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  } as AssistantMessage;
  return {
    type: "message",
    id: "m_asst",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: msg,
  };
}

// Minimal fakes for tryAutoCompact: it only calls
// piSession.getBranch() and harness.compact(). We drive both to
// exercise the pi-0.80 `reason` mapping the over-window fork
// fallback depends on.
function fakePiSession(branch: SessionTreeEntry[]): never {
  return { getBranch: async () => branch } as never;
}
function fakeHarness(compact: () => Promise<unknown>): never {
  return { compact } as never;
}
// An over-window branch: 90k usage against a 100k window (cap 83_616).
const OVER_WINDOW: SessionTreeEntry[] = [
  userMessageEntry("hi"),
  assistantWithUsage(90_000),
];

describe("tryAutoCompact reason mapping (pi 0.80)", () => {
  it("below_threshold when under the window (no compact() call)", async () => {
    let called = false;
    const r = await tryAutoCompact({
      piSession: fakePiSession([userMessageEntry("hi"), assistantWithUsage(1_000)]),
      harness: fakeHarness(async () => {
        called = true;
        return {};
      }),
      contextWindow: 100_000,
    });
    expect(r).toEqual({ compacted: false, reason: "below_threshold" });
    expect(called).toBe(false);
  });

  it("compacted when over window and compact() succeeds", async () => {
    const r = await tryAutoCompact({
      piSession: fakePiSession(OVER_WINDOW),
      harness: fakeHarness(async () => ({ tokensBefore: 90_000, summary: "s", firstKeptEntryId: "x" })),
      contextWindow: 100_000,
    });
    expect(r.compacted).toBe(true);
    expect(r.reason).toBe("compacted");
    expect(r.tokensBefore).toBe(90_000);
  });

  it("nothing_to_compact when over window but compact() throws 'Nothing to compact'", async () => {
    const r = await tryAutoCompact({
      piSession: fakePiSession(OVER_WINDOW),
      harness: fakeHarness(async () => {
        throw new Error("Nothing to compact");
      }),
      contextWindow: 100_000,
    });
    expect(r).toEqual({ compacted: false, reason: "nothing_to_compact" });
  });

  it("error (with message) when compact() throws anything else", async () => {
    const r = await tryAutoCompact({
      piSession: fakePiSession(OVER_WINDOW),
      harness: fakeHarness(async () => {
        throw new Error("provider 500");
      }),
      contextWindow: 100_000,
    });
    expect(r.compacted).toBe(false);
    expect(r.reason).toBe("error");
    expect(r.error).toContain("provider 500");
  });
});

describe("shouldCompactBranch", () => {
  it("returns false when settings.enabled is false", () => {
    expect(
      shouldCompactBranch({
        branch: [userMessageEntry("hi"), assistantWithUsage(150_000)],
        contextWindow: 100_000,
        settings: {
          enabled: false,
          reserveTokens: 16_384,
          keepRecentTokens: 20_000,
        },
      }),
    ).toBe(false);
  });

  it("returns false when contextWindow is missing or zero", () => {
    const branch = [
      userMessageEntry("hi"),
      assistantWithUsage(999_999),
    ];
    expect(
      shouldCompactBranch({ branch, contextWindow: undefined }),
    ).toBe(false);
    expect(shouldCompactBranch({ branch, contextWindow: 0 })).toBe(false);
  });

  it("returns false when the branch has no messages", () => {
    expect(
      shouldCompactBranch({ branch: [], contextWindow: 100_000 }),
    ).toBe(false);
  });

  it("returns false well below the threshold", () => {
    // contextWindow=100k, reserve=16k → cap is 84k.  Usage 1k is far
    // below.
    expect(
      shouldCompactBranch({
        branch: [userMessageEntry("hi"), assistantWithUsage(1_000)],
        contextWindow: 100_000,
      }),
    ).toBe(false);
  });

  it("returns true when usage exceeds contextWindow - reserveTokens", () => {
    // reserve=16384 → cap is 100_000-16_384=83_616. 90k > cap.
    expect(
      shouldCompactBranch({
        branch: [userMessageEntry("hi"), assistantWithUsage(90_000)],
        contextWindow: 100_000,
      }),
    ).toBe(true);
  });

  it("ignores non-message entries while estimating", () => {
    // A compaction marker should not contribute messages.
    const branch: SessionTreeEntry[] = [
      userMessageEntry("hi"),
      assistantWithUsage(1_000),
      {
        type: "compaction",
        id: "m_compact",
        parentId: null,
        timestamp: new Date().toISOString(),
        summary: "x".repeat(500),
        firstKeptEntryId: "m_asst",
        tokensBefore: 1_000,
      } as SessionTreeEntry,
    ];
    // Usage stayed at 1k → should not compact.
    expect(
      shouldCompactBranch({ branch, contextWindow: 100_000 }),
    ).toBe(false);
  });
});
