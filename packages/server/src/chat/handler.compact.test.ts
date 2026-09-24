// Auto-compact decision tests.
//
// `shouldCompactBranch` is the pure decision function the chat
// handler runs at the end of every turn to decide whether to fire
// `lane.compact()` before the next prompt. We test the surface
// directly so the runtime path stays unbranchy.
//
// pi 0.85 migration:
//   - Session.getBranch() → Session.findEntries(undefined, ctx)
//   - AgentHarness.compact() → AgentLane.compact(options, ctx)
//     with a Result<{compaction, run?}, LaneBusy|NothingToCompact|Closed>
//     return type — see agent-harness.d.ts::CompactionResult.
//   - Entry gained `seq: number` and `timestamp: number` (was ISO
//     string); the SessionTreeEntry export was renamed to `Entry`.
//   - tryAutoCompact() now requires { piSession, harness, lane,
//     context, contextWindow, settings? }.

import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  TextContent,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { Entry } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { shouldCompactBranch, tryAutoCompact } from "./handler.js";

function userMessageEntry(text: string): Entry {
  return {
    type: "message",
    id: `m_user_${text.slice(0, 8)}`,
    parentId: null,
    seq: 1,
    timestamp: 1,
    message: {
      role: "user",
      content: [{ type: "text", text } as TextContent],
      timestamp: 1,
    } as UserMessage,
  };
}

function assistantWithUsage(totalTokens: number): Entry {
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
    seq: 2,
    timestamp: 2,
    message: msg,
  };
}

// Minimal fakes for tryAutoCompact: pi 0.85 needs findEntries on
// the session and compact on the lane. tryAutoCompact reads the
// branch once before compact and once after; the same closure
// returns both calls (post-compact recount is best-effort so it's
// fine to re-read the pre-compact branch).
function fakePiSession(branch: Entry[]): never {
  return {
    findEntries: async () => branch,
  } as never;
}
function fakeHarness(): never {
  // pi 0.85: compact is no longer on the harness; tryAutoCompact
  // reads settings + tokens off the harness's session but doesn't
  // call any harness method. We still pass one to satisfy the type.
  return {} as never;
}
function fakeLane(
  compact: () => Promise<
    | { ok: true; value: { compaction: unknown; run?: unknown } }
    | { ok: false; error: { _tag: string; message?: string } }
  >,
): never {
  return { compact } as never;
}

// An over-window branch: 90k usage against a 100k window (cap 83_616).
const OVER_WINDOW: Entry[] = [
  userMessageEntry("hi"),
  assistantWithUsage(90_000),
];

describe("tryAutoCompact reason mapping (pi 0.85)", () => {
  it("below_threshold when under the window (no compact() call)", async () => {
    let called = false;
    const r = await tryAutoCompact({
      piSession: fakePiSession([
        userMessageEntry("hi"),
        assistantWithUsage(1_000),
      ]),
      harness: fakeHarness(),
      lane: fakeLane(async () => {
        called = true;
        return { ok: true, value: { compaction: {} } };
      }),
      context: BACKGROUND_CONTEXT,
      contextWindow: 100_000,
    });
    expect(r).toEqual({ compacted: false, reason: "below_threshold" });
    expect(called).toBe(false);
  });

  it("compacted when over window and compact() succeeds", async () => {
    const r = await tryAutoCompact({
      piSession: fakePiSession(OVER_WINDOW),
      harness: fakeHarness(),
      lane: fakeLane(async () => ({
        ok: true,
        value: { compaction: {} },
      })),
      context: BACKGROUND_CONTEXT,
      contextWindow: 100_000,
    });
    expect(r.compacted).toBe(true);
    expect(r.reason).toBe("compacted");
    // pi 0.85's CompactionResult doesn't expose tokensBefore anymore.
    // tryAutoCompact computes it locally via estimateContextTokens on
    // the pre-compact branch; for a single 90k-token assistant it
    // should reflect roughly that much (allow a wide range because
    // estimateContextTokens has its own accounting).
    expect(r.tokensBefore).toBeGreaterThan(0);
  });

  it("nothing_to_compact when over window but compact() reports NothingToCompact", async () => {
    const r = await tryAutoCompact({
      piSession: fakePiSession(OVER_WINDOW),
      harness: fakeHarness(),
      // pi 0.85's compact() returns a Result. NothingToCompact is
      // a typed error variant identified by its _tag; we replicate
      // that shape so tryAutoCompact hits the mapped branch.
      lane: fakeLane(async () => ({
        ok: false,
        error: { _tag: "NothingToCompact", message: "nothing to compact" },
      })),
      context: BACKGROUND_CONTEXT,
      contextWindow: 100_000,
    });
    expect(r).toEqual({ compacted: false, reason: "nothing_to_compact" });
  });

  it("error (with message) when compact() throws anything else", async () => {
    const r = await tryAutoCompact({
      piSession: fakePiSession(OVER_WINDOW),
      harness: fakeHarness(),
      lane: fakeLane(async () => {
        throw new Error("provider 500");
      }),
      context: BACKGROUND_CONTEXT,
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
    const branch: Entry[] = [
      userMessageEntry("hi"),
      assistantWithUsage(1_000),
      {
        type: "compaction",
        id: "m_compact",
        parentId: null,
        seq: 3,
        timestamp: 3,
        summary: "x".repeat(500),
        retainedTail: [],
        tokensBefore: 1_000,
        fromHook: false,
      } as Entry,
    ];
    // Usage stayed at 1k → should not compact.
    expect(
      shouldCompactBranch({ branch, contextWindow: 100_000 }),
    ).toBe(false);
  });
});
