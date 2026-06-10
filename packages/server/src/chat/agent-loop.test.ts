// Tests for chat/agent-loop.ts.
//
// We mock @earendil-works/pi-agent-core's `runAgentLoop` so the
// test drives the loop's emit() callback directly, instead of
// going through pi-ai's network path. The harness records a
// scripted sequence of AgentEvents per test.

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type {
  AgentEvent,
  AgentMessage,
} from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  TextContent,
  ToolCall,
} from "@earendil-works/pi-ai";

// Choreographed events the mocked pi runAgentLoop will emit each
// time the suite calls it. Set per test.
let __scriptedEvents: AgentEvent[] = [];

// Track whether the watchdog should drive an abort BEFORE the
// scripted events run (used by the timeout test).
let __scriptedDelayMs = 0;

vi.mock("@earendil-works/pi-agent-core", async () => {
  return {
    runAgentLoop: async (
      prompts: AgentMessage[],
      context: any,
      config: any,
      emit: (event: AgentEvent) => Promise<void> | void,
      signal?: AbortSignal,
    ) => {
      // Mirror pi's behaviour: append every event-emitted message
      // back into the shared context so the host can read final
      // text out of `context.messages` after the loop exits.
      const ctxMessages: AgentMessage[] = context.messages ?? [];
      const pushToCtx = (m: AgentMessage) => ctxMessages.push(m);
      // Mimic pi's external contract: agent_start → events →
      // agent_end. afterToolCall hook is invoked for every
      // tool_execution_end so the host can flag terminate /
      // isError.
      await emit({ type: "agent_start" });
      // Optional pause so the watchdog can fire mid-run.
      if (__scriptedDelayMs > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, __scriptedDelayMs);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true },
          );
        });
      }
      if (signal?.aborted) {
        await emit({
          type: "agent_end",
          messages: [],
        });
        return [];
      }
      const newMessages: AgentMessage[] = [...prompts];
      prompts.forEach(pushToCtx);
      for (const event of __scriptedEvents) {
        if (signal?.aborted) break;
        if (event.type === "tool_execution_end") {
          // Run the host's afterToolCall hook so terminate /
          // isError flow back into the run.
          const fakeAssistant: AssistantMessage = {
            role: "assistant",
            content: [],
            stopReason: "toolUse",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            api: "anthropic" as never,
            provider: "fake" as never,
            model: "fakemodel",
            timestamp: Date.now(),
          };
          await config.afterToolCall?.({
            assistantMessage: fakeAssistant,
            toolCall: {
              type: "toolCall",
              id: event.toolCallId,
              name: event.toolName,
              arguments: event.args,
            } as ToolCall,
            args: event.args,
            result: event.result,
            isError: event.isError,
            context: { systemPrompt: "", messages: newMessages },
          });
        }
        if (event.type === "message_end") {
          newMessages.push(event.message);
          pushToCtx(event.message);
        }
        await emit(event);
      }
      await emit({ type: "agent_end", messages: newMessages });
      return newMessages;
    },
  };
});

import { up as runInitialMigration } from "../core/migrations/001-initial.js";
import { up as runDepsMigration } from "../core/migrations/002-task-dependencies.js";
import type { TenantContext } from "../core/index.js";
import { runAgentLoop } from "./agent-loop.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = MEMORY");
  runInitialMigration(db);
  runDepsMigration(db);
  db.prepare(
    `INSERT INTO users (id, external_id, provider, display_name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("u1", "ext1", "test", "Test", Date.now());
  return db;
}

function fakeCtx(db: Database.Database): TenantContext {
  return {
    tenantId: "acme",
    db,
    workspaceDir: "/tmp/fake",
    userHomeDir: () => "/tmp/fake/users/u1",
    config: {
      branding: { name: "Tianshu" },
      defaultModel: "fakeprov/fakemodel",
      models: {
        providers: {
          fakeprov: {
            api: "anthropic" as never,
            apiKey: "test-key",
            baseUrl: "http://localhost:0",
            models: [{ id: "fakemodel", name: "Fake", contextWindow: 100_000 }],
          },
        },
      },
    },
  } as unknown as TenantContext;
}

function textBlock(text: string): TextContent {
  return { type: "text", text };
}

function assistantMsg(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    api: "anthropic" as never,
    provider: "fakeprov" as never,
    model: "fakemodel",
    timestamp: Date.now(),
  };
}

describe("runAgentLoop", () => {
  let db: Database.Database;
  let ctx: TenantContext;

  beforeEach(() => {
    db = freshDb();
    ctx = fakeCtx(db);
    __scriptedEvents = [];
    __scriptedDelayMs = 0;
  });

  it("plain LLM reply (no tools) → stalled (worker must call task_complete)", async () => {
    const msg = assistantMsg([textBlock("here is what I think")]);
    __scriptedEvents = [
      { type: "message_start", message: msg },
      { type: "message_end", message: msg },
    ];

    const r = await runAgentLoop({
      ctx,
      userId: "u1",
      initialUserMessage: "do the thing",
    });

    expect(r.status).toBe("stalled");
    expect(r.reason).toBe("max_turns");
    expect(r.summary).toBe("here is what I think");
  });

  it("toolCall(task_complete) → done with summary + files", async () => {
    const call: ToolCall = {
      type: "toolCall",
      id: "c1",
      name: "task_complete",
      arguments: { summary: "I shipped v1", files: ["report.md"] },
    };
    const asstMsg = assistantMsg([call]);
    __scriptedEvents = [
      { type: "message_start", message: asstMsg },
      { type: "message_end", message: asstMsg },
      {
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "task_complete",
        args: { summary: "I shipped v1", files: ["report.md"] },
        result: {
          content: [textBlock("ok")],
          details: undefined,
        },
        isError: false,
      } as AgentEvent,
    ];

    const r = await runAgentLoop({
      ctx,
      userId: "u1",
      initialUserMessage: "do the thing",
    });

    expect(r.status).toBe("done");
    expect(r.summary).toBe("I shipped v1");
    expect(r.files).toEqual(["report.md"]);
    expect(r.reason).toBe("task_complete");
  });

  it("max-run timeout → error / max_run_timeout", async () => {
    // Force the watchdog to fire by holding the loop open for 500ms
    // with maxRunMs=1.
    __scriptedDelayMs = 500;
    __scriptedEvents = [];

    const r = await runAgentLoop({
      ctx,
      userId: "u1",
      initialUserMessage: "do the thing",
      timeouts: { maxRunMs: 1, firstResponseMs: 0, idleMs: 0 },
    });

    expect(r.status).toBe("error");
    expect(r.reason).toBe("max_run_timeout");
  });

  it("aborted via signal → status=aborted, reason=aborted", async () => {
    __scriptedDelayMs = 500;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);

    const r = await runAgentLoop({
      ctx,
      userId: "u1",
      initialUserMessage: "do the thing",
      signal: ac.signal,
      timeouts: { firstResponseMs: 0, idleMs: 0, maxRunMs: 0 },
    });

    expect(r.status).toBe("aborted");
    expect(r.reason).toBe("aborted");
  });
});
