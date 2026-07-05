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
/** Captured by FakeHarness's constructor on every run.
 *  Tests inspect this to assert prompt-stitching behaviour. */
let __lastSystemPrompt: string | undefined;

// The real `buildModels` (core/pi-models.ts) asserts that a builtin
// pi-ai API implementation exists for the model's `api` id. These
// tests use a fake api id ("anthropic", not the real
// "anthropic-messages") and fully mock the harness, so the returned
// Models is never used for streaming. Stub it out to a dummy so the
// fake-api guard doesn't fire on a code path that never reaches the
// network.
vi.mock("../core/pi-models.js", () => ({
  buildModels: () => ({}) as never,
}));

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
    constructor(options: unknown) {
      const sp = (options as { systemPrompt?: string } | undefined)
        ?.systemPrompt;
      __lastSystemPrompt = sp;
    }
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { up as runInitialMigration } from "../core/migrations/001-initial.js";
import { up as runDepsMigration } from "../core/migrations/002-task-dependencies.js";
import { up as runSessionTreeMigration } from "../core/migrations/003-session-tree.js";
import type { TenantContext } from "../core/index.js";
import { getTenantConfigDir } from "../core/paths.js";
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

function fakeCtx(db: Database.Database, home = "/tmp/fake"): TenantContext {
  return {
    tenantId: "acme",
    db,
    home,
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

  it("task_complete is terminal: first call wins, harness aborted, later calls ignored", async () => {
    // Regression: an agent (observed: the judge) mis-fired
    // task_complete on turn 1, kept generating, then called it AGAIN
    // with a correction. Nothing stopped the turn, so the SECOND
    // (wrong) summary overwrote the first. Now the first call must
    // win and abort the harness.
    __script = {
      events: [
        {
          type: "tool_result",
          toolCallId: "c1",
          toolName: "task_complete",
          input: { summary: "FIRST verdict", files: ["a.md"] },
          content: [],
          details: undefined,
          isError: false,
        } as AgentHarnessEvent,
        {
          type: "tool_result",
          toolCallId: "c2",
          toolName: "task_complete",
          input: { summary: "SECOND (oops) verdict", files: ["b.md"] },
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
    expect(r.reason).toBe("task_complete");
    // First call wins; second is ignored.
    expect(r.summary).toBe("FIRST verdict");
    expect(r.files).toEqual(["a.md"]);
    // Harness was aborted to actually end the turn.
    expect(__abortAcked).toBe(true);
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

  // ─── ADR-0007 PR-B: worker fragment injection ──────────────────
  //
  // Workers go through `runAgentLoop` (not the chat handler), and
  // historically skipped plugin fragments entirely when a SOUL prompt
  // was set. ADR-0006 problem #2 / ADR-0007 PR-B closes that gap by
  // having `runAgentLoop` consult `pluginRegistry.systemPromptFragmentsForTenant`
  // and stitch the rendered block into the worker's system prompt.
  //
  // We assert on the captured systemPrompt rather than mocking the
  // renderer, because (a) the renderer is the host's responsibility
  // and (b) a regression that drops the renderer call would still
  // pass a renderer-only mock test.

  function makeFragmentRegistry(
    fragments: Array<{
      pluginId: string;
      pluginDisplayName: string;
      fragmentId: string;
      text: string;
    }>,
  ) {
    return {
      systemPromptFragmentsForTenant: () => fragments,
      toolsForTenant: () => [],
      mirroredSkillsForTenant: () => [],
      refreshStaleToolsets: async () => 0,
      hostCapabilities: () => ({
        get: () => undefined,
        has: () => false,
      }),
    } as unknown as Parameters<typeof runAgentLoop>[0]["pluginRegistry"];
  }

  it("worker run refreshes stale dynamic toolsets before snapshotting tools", async () => {
    __script = { events: [] };
    let refreshCalls = 0;
    let toolsListCalls = 0;
    const order: string[] = [];
    const registry = {
      systemPromptFragmentsForTenant: () => [],
      toolsForTenant: () => {
        toolsListCalls += 1;
        order.push("toolsForTenant");
        return [];
      },
      mirroredSkillsForTenant: () => [],
      refreshStaleToolsets: async () => {
        refreshCalls += 1;
        order.push("refreshStaleToolsets");
        return 0;
      },
      hostCapabilities: () => ({
        get: () => undefined,
        has: () => false,
      }),
    } as unknown as Parameters<typeof runAgentLoop>[0]["pluginRegistry"];

    await runAgentLoop({
      ctx,
      userId: "u1",
      initialUserMessage: "do the thing",
      systemPrompt: "You are W.",
      pluginRegistry: registry,
    });

    expect(refreshCalls).toBe(1);
    expect(toolsListCalls).toBeGreaterThanOrEqual(1);
    // refresh must run BEFORE we snapshot the tool list, otherwise
    // the worker session locks in a stale snapshot for its whole
    // lifetime (e.g. empty Playwright MCP entries because the
    // sidecar hadn't refreshed yet).
    const refreshIdx = order.indexOf("refreshStaleToolsets");
    const listIdx = order.indexOf("toolsForTenant");
    expect(refreshIdx).toBeGreaterThanOrEqual(0);
    expect(listIdx).toBeGreaterThan(refreshIdx);
  });

  it("worker with SOUL prompt: fragments are stitched in after SOUL", async () => {
    __script = { events: [] };
    await runAgentLoop({
      ctx,
      userId: "u1",
      initialUserMessage: "do the thing",
      systemPrompt: "You are FooWorker. Soul body.",
      pluginRegistry: makeFragmentRegistry([
        {
          pluginId: "files",
          pluginDisplayName: "Files",
          fragmentId: "read-before-edit",
          text: "- Call read_file before edit_file.",
        },
      ]),
    });
    expect(__lastSystemPrompt).toBeDefined();
    expect(__lastSystemPrompt).toContain("You are FooWorker.");
    expect(__lastSystemPrompt).toContain("## Plugin guidance");
    expect(__lastSystemPrompt).toContain("Files (files)");
    expect(__lastSystemPrompt).toContain("Call read_file before edit_file.");
    // Order: SOUL first, then fragments. Both should land before any
    // skills block (we don't have skills in this test, but the
    // assertion catches the regression where fragments end up above
    // the SOUL).
    const soulIdx = __lastSystemPrompt!.indexOf("You are FooWorker.");
    const fragIdx = __lastSystemPrompt!.indexOf("## Plugin guidance");
    expect(soulIdx).toBeGreaterThanOrEqual(0);
    expect(fragIdx).toBeGreaterThan(soulIdx);
  });

  it("worker with SOUL prompt + no fragments: prompt stays unchanged", async () => {
    __script = { events: [] };
    await runAgentLoop({
      ctx,
      userId: "u1",
      initialUserMessage: "do the thing",
      systemPrompt: "You are BareWorker. Nothing fancy.",
      pluginRegistry: makeFragmentRegistry([]),
    });
    expect(__lastSystemPrompt).toBeDefined();
    expect(__lastSystemPrompt).toContain("You are BareWorker.");
    expect(__lastSystemPrompt).not.toContain("## Plugin guidance");
  });

  it("worker without SOUL prompt: fragments reach defaultSystemPrompt path", async () => {
    __script = { events: [] };
    await runAgentLoop({
      ctx,
      userId: "u1",
      initialUserMessage: "do the thing",
      // No systemPrompt — falls back to defaultSystemPrompt(ctx, userId, skills, pluginFragments).
      pluginRegistry: makeFragmentRegistry([
        {
          pluginId: "microsandbox",
          pluginDisplayName: "Microsandbox",
          fragmentId: "no-foreground-servers",
          text: "- Don't run a foreground server with exec.",
        },
      ]),
    });
    expect(__lastSystemPrompt).toBeDefined();
    expect(__lastSystemPrompt).toContain("## Plugin guidance");
    expect(__lastSystemPrompt).toContain("Microsandbox (microsandbox)");
    expect(__lastSystemPrompt).toContain(
      "Don't run a foreground server with exec.",
    );
  });

  it("worker without pluginRegistry at all: prompt assembly still works", async () => {
    __script = { events: [] };
    await runAgentLoop({
      ctx,
      userId: "u1",
      initialUserMessage: "do the thing",
      systemPrompt: "You are SoloWorker.",
      // No pluginRegistry — callers from older code paths or tests
      // shouldn't be forced to provide one.
    });
    expect(__lastSystemPrompt).toBeDefined();
    expect(__lastSystemPrompt).toContain("You are SoloWorker.");
    expect(__lastSystemPrompt).not.toContain("## Plugin guidance");
  });

  // Per-worker execution-bias override (B model): a worker that
  // carries its own override sidecar gets that text in its prompt
  // instead of the host default, independent of the main agent.
  it("worker with execution-bias override: uses override text, not host default", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ts-worker-eb-"));
    const localCtx = fakeCtx(freshDb(), home);
    const wDir = path.join(getTenantConfigDir("acme", home), "workers", "fooworker");
    fs.mkdirSync(wDir, { recursive: true });
    fs.writeFileSync(
      path.join(wDir, "execution-bias.md"),
      "## Execution bias\nWORKER-ONLY override rule: triple-check sources.",
      "utf8",
    );
    fs.writeFileSync(
      path.join(wDir, "agent.json"),
      JSON.stringify({
        kind: "llm",
        overrides: { executionBias: "execution-bias.md" },
      }),
      "utf8",
    );

    __script = { events: [] };
    await runAgentLoop({
      ctx: localCtx,
      userId: "u1",
      initialUserMessage: "do the thing",
      systemPrompt: "You are FooWorker.",
      workerSlug: "fooworker",
    });
    expect(__lastSystemPrompt).toBeDefined();
    expect(__lastSystemPrompt).toContain(
      "WORKER-ONLY override rule: triple-check sources.",
    );

    fs.rmSync(home, { recursive: true, force: true });
  });

  it("worker without override sidecar: falls back to host execution-bias default", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ts-worker-eb2-"));
    const localCtx = fakeCtx(freshDb(), home);
    // No workers dir / no agent.json → loader returns null → host
    // default block applies. The host default contains the
    // "Execution Bias" heading from formatExecutionBiasBlock().
    __script = { events: [] };
    await runAgentLoop({
      ctx: localCtx,
      userId: "u1",
      initialUserMessage: "do the thing",
      systemPrompt: "You are PlainWorker.",
      workerSlug: "plainworker",
    });
    expect(__lastSystemPrompt).toBeDefined();
    expect(__lastSystemPrompt).toContain("You are PlainWorker.");
    expect(__lastSystemPrompt).not.toContain("WORKER-ONLY override rule");

    fs.rmSync(home, { recursive: true, force: true });
  });
});
