// Tests for the pure parts of compact.ts. The full compactSession()
// runs an LLM and writes to DB; we exercise it via an integration
// test in handler land. Here we lock down planCompact() and
// buildTranscript() since regressions there silently lose user
// context.

import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  Message,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { buildTranscript, planCompact } from "./compact.js";
import type { ChatMessage } from "./messages.js";

function user(text: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text } as TextContent],
    timestamp: 1,
  };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text } as TextContent],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function row(content: string): ChatMessage {
  return {
    id: `m-${content.slice(0, 8)}`,
    sessionId: "s",
    role: "user",
    content,
    createdAt: 1,
  };
}

describe("planCompact", () => {
  it("returns nothing-to-summarise when there are too few messages", () => {
    const pi: Message[] = [user("hi"), assistant("hello")];
    const rows = pi.map((_, i) => row(`r${i}`));
    const plan = planCompact(pi, rows);
    expect(plan.toSummarise).toHaveLength(0);
    expect(plan.keep).toHaveLength(2);
  });

  it("keeps from the last user message to the end", () => {
    // Need >= MIN_MESSAGES_TO_COMPACT (10) messages for planCompact
    // to actually compact. Build a 12-message history.
    const pi: Message[] = [
      user("u1"), assistant("a1"),
      user("u2"), assistant("a2"),
      user("u3"), assistant("a3"),
      user("u4"), assistant("a4"),
      user("u5"), assistant("a5"),
      user("u6"), assistant("a6"),
    ];
    const rows = pi.map((_, i) => row(`r${i}`));
    const plan = planCompact(pi, rows);
    // Last user message is at index 10 → keep indices 10..11
    expect(plan.toSummarise).toHaveLength(10);
    expect(plan.keep).toHaveLength(2);
    expect((plan.keep[0] as UserMessage).content).toEqual(
      [{ type: "text", text: "u6" }],
    );
  });

  it("keepRows mirrors the kept messages by index", () => {
    // Need >= 10 messages for compaction to kick in
    const pi: Message[] = [
      user("u1"), assistant("a1"),
      user("u2"), assistant("a2"),
      user("u3"), assistant("a3"),
      user("u4"), assistant("a4"),
      user("u5"), assistant("a5"),
    ];
    const rows = pi.map((_, i) => row(`r${i}`));
    const plan = planCompact(pi, rows);
    // Last user is index 8 → keep 8..9
    expect(plan.keepRows).toHaveLength(2);
    expect(plan.keepRows[0]!.content).toBe("r8");
    expect(plan.keepRows[1]!.content).toBe("r9");
  });

  it("falls back to a 2-message tail when the log has no user message in range", () => {
    // (Pathological case — assistant-only history, >= 10 messages.)
    const pi: Message[] = Array.from({ length: 12 }, (_, i) =>
      assistant(`a${i + 1}`),
    );
    const rows = pi.map((_, i) => row(`r${i}`));
    const plan = planCompact(pi, rows);
    expect(plan.keep).toHaveLength(2);
    expect(plan.toSummarise).toHaveLength(10);
  });
});

describe("buildTranscript", () => {
  it("renders user / assistant / tool_result blocks", () => {
    const tr: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "list_dir",
      content: [{ type: "text", text: "two files" } as TextContent],
      isError: false,
      timestamp: 1,
    };
    const t = buildTranscript([user("hi"), assistant("yo"), tr]);
    expect(t).toContain("### USER\nhi");
    expect(t).toContain("### ASSISTANT\nyo");
    expect(t).toContain("### TOOL_RESULT (list_dir)\ntwo files");
  });

  it("clamps long tool-result bodies to 3000 chars + a notice", () => {
    const tr: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read_file",
      content: [
        { type: "text", text: "x".repeat(5000) } as TextContent,
      ],
      isError: false,
      timestamp: 1,
    };
    const t = buildTranscript([tr]);
    expect(t).toContain("(+2000 chars)");
    expect(t.length).toBeLessThan(5000);
  });

  it("represents image attachments with a short [image: …] marker", () => {
    const u: UserMessage = {
      role: "user",
      content: [
        { type: "text", text: "look" } as TextContent,
        {
          type: "image",
          data: "BASE64",
          mimeType: "image/png",
          // path/name aren't standard ImageContent fields, but our
          // chat handler stamps them on so we can render the marker.
          ...({ path: "/uploads/x.png", name: "x.png" } as Record<
            string,
            unknown
          >),
        },
      ],
      timestamp: 1,
    };
    const t = buildTranscript([u]);
    expect(t).toContain("[image: x.png]");
    // Critically, the base64 doesn't sneak into the summariser's
    // input or this defeats the whole compaction value.
    expect(t).not.toContain("BASE64");
  });
});
