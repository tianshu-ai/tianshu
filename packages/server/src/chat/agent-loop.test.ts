// Tests for chat/agent-loop.ts (worker-side runner).
//
// We mock @earendil-works/pi-agent-core's `AgentHarness` so the
// suite drives the loop deterministically without going through
// pi-ai's network path. `Session` and other pi exports are
// preserved via importOriginal so the rest of the chat module
// (which constructs Session directly via SqliteSessionStorage)
// still works.

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";

// Test harness: each test sets a "scripted run" that controls how
// the mocked AgentHarness behaves once `prompt()` is called.
interface ScriptedRun {
  /** Events to fire in order to subscribers. */
  events: AgentHarnessEvent[];
  /** Pause between agent_start and event emission, so the
   *  watchdog can fire mid-run. */
  delayMs?: number;
}

let __script: ScriptedRun = { events: [] };
let __abortAcked = false;

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-agent-core")>();

  class FakeHarness {
    private listeners: Array<(e: AgentHarnessEvent) => void> = [];
    // pi-agent-core dispatches some events (notably tool_result) on
    // a separate hook channel via `harness.on(type, handler)`. The
    // real harness's `subscribe(...)` listener never sees those.
    // Mirror that split here so tests catch any regression where
    // server code goes back to listening on subscribe and silently
    // misses tool_result.
    private hookHandlers = new Map<
      string,
      Array<(e: AgentHarnessEvent) => unknown>
    >();
    private aborted = false;
    constructor(_options: unknown) {}
    subscribe(listener: (e: AgentHarnessEvent) => void) {
      this.listeners.push(listener);
      return () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      };
    }
    on(type: string, handler: (e: AgentHarnessEvent) => unknown) {
      const arr = this.hookHandlers.get(type) ?? [];
      arr.push(handler);
      this.hookHandlers.set(type, arr);
      return () => {
        const next = (this.hookHandlers.get(type) ?? []).filter(
          (h) => h !== handler,
        );
        this.hookHandlers.set(type, next);
      };
    }
    async prompt(_text: string): Promise<void> {
      const emit = (e: AgentHarnessEvent) => {
        const t = (e as { type?: string }).type;
        // Hook-channel events (tool_call / tool_result / context /
        // session_before_compact / etc.) go to `on(type, ...)`
        // handlers, NOT subscribe.
        if (t === "tool_result" || t === "tool_call") {
          for (const h of this.hookHandlers.get(t) ?? []) h(e);
          return;
        }
        for (const l of this.listeners) l(e);
      };
      emit({ type: "agent_start" } as AgentHarnessEvent);
      if (__script.delayMs && __script.delayMs > 0) {
        await new Promise<void>((r) => setTimeout(r, __script.delayMs));
      }
      if (this.aborted) {
        emit({ type: "agent_end", messages: [] } as AgentHarnessEvent);
        return;
      }
      for (const e of __script.events) {
        if (this.aborted) break;
        emit(e);
      }
      emit({ type: "agent_end", messages: [] } as AgentHarnessEvent);
    }
    async waitForIdle() {
      // pi calls turn_end internally; we already ran prompt to
      // completion, so resolve immediately.
    }
    async abort() {
      this.aborted = true;
      __abortAcked = true;
    }
  }

  return {
    ...actual,
    AgentHarness: FakeHarness as unknown as typeof actual.AgentHarness,
  };
});

import { up as runInitialMigration } from "../core/migrations/001-initial.js";
import { up as runDepsMigration } from "../core/migrations/002-task-dependencies.js";
import { up as runSessionTreeMigration } from "../core/migrations/003-session-tree.js";
import type { TenantContext } from "../core/index.js";
import { runAgentLoop } from "./agent-loop.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = MEMORY");
  runInitialMigration(db);
  runDepsMigration(db);
  runSessionTreeMigration(db);
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
            models: [
              { id: "fakemodel", name: "Fake", contextWindow: 100_000 },
            ],
          },
        },
      },
    },
  } as unknown as TenantContext;
}

describe("runAgentLoop (worker)", () => {
  let db: Database.Database;
  let ctx: TenantContext;

  beforeEach(() => {
    db = freshDb();
    ctx = fakeCtx(db);
    __script = { events: [] };
    __abortAcked = false;
  });

  it("plain LLM reply (no task_complete) → stalled / no_completion", async () => {
    __script = {
      events: [
        // No tool_result → completionSink stays empty → loop ends
        // naturally → host classifies as stalled with reason=no_completion.
      ],
    };

    const r = await runAgentLoop({
      ctx,
      userId: "u1",
      initialUserMessage: "do the thing",
    });

    expect(r.status).toBe("stalled");
    expect(r.reason).toBe("no_completion");
  });

  it("task_complete tool_result → done with summary + files", async () => {
    __script = {
      events: [
        {
          type: "tool_result",
          toolCallId: "c1",
          toolName: "task_complete",
          input: { summary: "I shipped v1", files: ["report.md"] },
          content: [],
          details: undefined,
          isError: false,
        } as AgentHarnessEvent,
      ],
    };

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
    __script = { events: [], delayMs: 500 };

    const r = await runAgentLoop({
      ctx,
      userId: "u1",
      initialUserMessage: "do the thing",
      timeouts: { maxRunMs: 1, firstResponseMs: 0, idleMs: 0 },
    });

    expect(r.status).toBe("error");
    expect(r.reason).toBe("max_run_timeout");
    expect(__abortAcked).toBe(true);
  });

  it("external abort → aborted", async () => {
    __script = { events: [], delayMs: 500 };
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
    expect(__abortAcked).toBe(true);
  });
});
