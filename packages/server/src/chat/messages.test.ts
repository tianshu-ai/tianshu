// Persistence tests for the chat-message helpers — verifying the new
// agent-aware persistence path (PR #21c) round-trips structured pi-ai
// Messages and that legacy plain-text rows are still readable.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AssistantMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { GlobalOps } from "../core/global-ops.js";
import { DbPool } from "../core/db-pool.js";
import {
  appendAgentMessage,
  appendMessage,
  ensureActiveSession,
  listMessagesForUser,
  loadAgentHistory,
} from "./messages.js";

let home: string;
let ops: GlobalOps;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-msg-"));
  ops = new GlobalOps({ home, pool: new DbPool({ home }) });
  const ctx = ops.create("acme");
  ops.ensureUser(ctx, {
    userId: "user_a",
    provider: "local",
    externalId: "user_a",
    displayName: "User A",
  });
});

afterEach(() => {
  ops.closePool();
  fs.rmSync(home, { recursive: true, force: true });
});

const DEFAULTS = {
  api: "anthropic" as AssistantMessage["api"],
  provider: "anthropic" as AssistantMessage["provider"],
  model: "claude-test",
};

describe("chat persistence", () => {
  it("persists a plain user message and reads it back", () => {
    const ctx = ops.open("acme");
    const session = ensureActiveSession(ctx, "user_a");

    appendMessage(ctx, session, { role: "user", content: "hello" });
    const rows = listMessagesForUser(ctx, "user_a");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("user");
    expect(rows[0]?.content).toBe("hello");
  });

  it("persists a structured AssistantMessage with tool calls", () => {
    const ctx = ops.open("acme");
    const session = ensureActiveSession(ctx, "user_a");

    const assistant: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Looking up notes" },
        {
          type: "toolCall",
          id: "tc_1",
          name: "list_dir",
          arguments: { path: "/" },
        },
      ],
      api: DEFAULTS.api,
      provider: DEFAULTS.provider,
      model: DEFAULTS.model,
      usage: zeroUsage(),
      stopReason: "toolUse",
      timestamp: 1000,
    };
    appendAgentMessage(ctx, session, assistant);

    const hist = loadAgentHistory(ctx, "user_a", DEFAULTS);
    expect(hist).toHaveLength(1);
    const replayed = hist[0] as AssistantMessage;
    expect(replayed.role).toBe("assistant");
    expect(replayed.stopReason).toBe("toolUse");
    expect(replayed.content[0]).toEqual({ type: "text", text: "Looking up notes" });
    expect(replayed.content[1]).toMatchObject({
      type: "toolCall",
      id: "tc_1",
      name: "list_dir",
    });
  });

  it("round-trips a ToolResultMessage as role=tool", () => {
    const ctx = ops.open("acme");
    const session = ensureActiveSession(ctx, "user_a");

    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "tc_1",
      toolName: "list_dir",
      content: [{ type: "text", text: "Directory / (1 entry)" }],
      isError: false,
      timestamp: 1100,
    };
    appendAgentMessage(ctx, session, result);

    const rows = listMessagesForUser(ctx, "user_a");
    expect(rows[0]?.role).toBe("tool");

    const hist = loadAgentHistory(ctx, "user_a", DEFAULTS);
    expect(hist).toHaveLength(1);
    expect(hist[0]?.role).toBe("toolResult");
    expect((hist[0] as ToolResultMessage).toolName).toBe("list_dir");
  });

  it("upgrades legacy plain-text rows on load", () => {
    const ctx = ops.open("acme");
    const session = ensureActiveSession(ctx, "user_a");

    // Legacy: content is a bare string, not JSON.
    appendMessage(ctx, session, { role: "user", content: "hi" });
    appendMessage(ctx, session, { role: "assistant", content: "hello back" });

    const hist = loadAgentHistory(ctx, "user_a", DEFAULTS);
    expect(hist).toHaveLength(2);
    expect(hist[0]?.role).toBe("user");
    expect(hist[1]?.role).toBe("assistant");
    expect((hist[1] as AssistantMessage).model).toBe("claude-test");
  });

  it("preserves chronological order across mixed rows", () => {
    const ctx = ops.open("acme");
    const session = ensureActiveSession(ctx, "user_a");

    appendMessage(ctx, session, { role: "user", content: "first" });
    appendAgentMessage(ctx, session, {
      role: "assistant",
      content: [{ type: "text", text: "thinking" }],
      api: DEFAULTS.api,
      provider: DEFAULTS.provider,
      model: DEFAULTS.model,
      usage: zeroUsage(),
      stopReason: "toolUse",
      timestamp: 200,
    });
    appendAgentMessage(ctx, session, {
      role: "toolResult",
      toolCallId: "tc",
      toolName: "list_dir",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 300,
    });

    const hist = loadAgentHistory(ctx, "user_a", DEFAULTS);
    expect(hist.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
  });
});

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
