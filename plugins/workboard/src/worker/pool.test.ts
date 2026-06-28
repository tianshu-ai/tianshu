// Worker pool behaviour tests.
// Uses a 5ms echo worker so the suite stays under a second.

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { up as runInitialMigration } from "../../../../packages/server/src/core/migrations/001-initial.js";
import { up as runDepsMigration } from "../../../../packages/server/src/core/migrations/002-task-dependencies.js";
import { up as runStatusRename } from "../../../../packages/server/src/core/migrations/005-task-status-rename.js";
import { up as runTaskLabels } from "../../../../packages/server/src/core/migrations/006-task-labels.js";
import { up as runSessionInbox } from "../../../../packages/server/src/core/migrations/007-session-inbox.js";
import { up as runTaskIntervention } from "../../../../packages/server/src/core/migrations/008-task-intervention.js";
import { ensureSchema as ensureAgentsSchema } from "../db/schema.js";
import { createTask, getTask, updateTask } from "../db/tasks.js";
import {
  EchoWorker,
  WorkerPool,
  effectiveToolsAllow,
  type AgentSpec,
  type WorkerHandle,
} from "./pool.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = MEMORY");
  runInitialMigration(db);
  runDepsMigration(db);
  runStatusRename(db);
  runTaskLabels(db);
  runSessionInbox(db);
  runTaskIntervention(db);
  ensureAgentsSchema(db);
  db.prepare(
    `INSERT INTO users (id, external_id, provider, display_name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("u1", "ext1", "test", "Test", Date.now());
  return db;
}

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const ECHO_AGENT: AgentSpec = { id: "agent-echo", kind: "echo", name: "Echo" };

const echoFactory = (delayMs: number) =>
  (a: AgentSpec): WorkerHandle | null =>
    a.kind === "echo" ? new EchoWorker(a.id, a.name, { delayMs }) : null;

describe("effectiveToolsAllow", () => {
  // task_complete is the only legitimate exit signal a worker has.
  // Without it the run will time out / be killed for stalling even
  // on a perfectly-completed task. So no matter what the user did
  // with their per-agent allow-list, the pool MUST inject it.
  it("injects task_complete when user trimmed it out", () => {
    expect(effectiveToolsAllow(["web_search"])).toEqual([
      "web_search",
      "task_complete",
    ]);
  });

  it("keeps task_complete when user already listed it", () => {
    const out = effectiveToolsAllow(["web_search", "task_complete"]);
    // Only one copy — we don't want duplicate entries leaking into
    // pi-ai's tool registration.
    expect(out).toEqual(["web_search", "task_complete"]);
  });

  it("strips deny-listed tools (e.g. task_create) but keeps required", () => {
    const out = effectiveToolsAllow([
      "web_search",
      "task_create",
      "task_complete",
    ]);
    expect(out).toEqual(["web_search", "task_complete"]);
  });

  it("returns undefined for null/empty allow-list (= all tools)", () => {
    // Undefined means "don't narrow" — task_complete is in the
    // host's all-tools set automatically, so no injection needed.
    expect(effectiveToolsAllow(null)).toBeUndefined();
    expect(effectiveToolsAllow(undefined)).toBeUndefined();
  });
});

describe("WorkerPool", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("claims a ready task, runs the worker, marks done", async () => {
    const broadcasts: { type: string; payload: unknown }[] = [];
    createTask(db, "t1", { ownerUserId: "u1", title: "test 1" });

    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: (type, payload) => broadcasts.push({ type, payload }),
      agents: [ECHO_AGENT],
      factory: echoFactory(5),
    });
    pool.start();

    // give the async drain a chance to claim and complete
    await pause(40);

    const task = getTask(db, "t1");
    expect(task?.status).toBe("done");
    expect(task?.startedAt).not.toBeNull();
    expect(task?.endedAt).not.toBeNull();
    expect(task?.resultSummary).toContain("test 1");

    const claimed = broadcasts.find(
      (b) => b.type === "workboard.task" && (b.payload as any).kind === "claimed",
    );
    const completed = broadcasts.find(
      (b) => b.type === "workboard.task" && (b.payload as any).kind === "completed",
    );
    expect(claimed).toBeDefined();
    expect(completed).toBeDefined();
    expect((completed!.payload as any).status).toBe("done");
    expect((completed!.payload as any).workerAgentId).toBe("agent-echo");

    pool.stop();
  });

  it("nudge() coalesces and a follow-up task is picked up after the first", async () => {
    createTask(db, "t1", { ownerUserId: "u1", title: "first" });
    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      agents: [ECHO_AGENT],
      factory: echoFactory(5),
    });
    pool.start();
    await pause(20);
    expect(getTask(db, "t1")?.status).toBe("done");

    // Add another while the pool is idle: nudge should drain it.
    createTask(db, "t2", { ownerUserId: "u1", title: "second" });
    pool.nudge();
    await pause(20);
    expect(getTask(db, "t2")?.status).toBe("done");
    pool.stop();
  });

  it("recovers orphaned in_progress tasks on start() into awaiting-intervention", async () => {
    // Post-008: an orphan no longer auto-retries. recoverOrphaned
    // parks the row in awaiting-intervention so the main agent
    // decides task_continue / task_retry_fresh / task_abort. The
    // echo worker doesn't pick it up anymore.
    createTask(db, "t1", { ownerUserId: "u1", title: "stuck" });
    updateTask(db, "t1", { status: "in_progress", startedAt: Date.now() });

    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      agents: [ECHO_AGENT],
      factory: echoFactory(5),
    });
    pool.start();
    await pause(40);

    const after = getTask(db, "t1");
    expect(after?.status).toBe("ready");
    expect(after?.labels).toContain("awaiting-intervention");
    expect(after?.failureReason).toMatch(/host restart/);
    expect(after?.interventionReason).toMatch(/host restart/);
    pool.stop();
  });

  it("orphan recovery parks the row in awaiting-intervention immediately (no retry budget)", () => {
    // 008 collapsed the multi-attempt orphan loop into a single
    // "park + ask main agent" step. Attempts still bumps as a
    // counter, but doesn't drive policy.
    createTask(db, "t1", { ownerUserId: "u1", title: "stuck" });
    updateTask(db, "t1", {
      status: "in_progress",
      startedAt: Date.now(),
      attempts: 0,
    });

    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      agents: [],
      factory: () => null,
    });
    pool.start();
    pool.stop();
    const after = getTask(db, "t1");
    expect(after?.status).toBe("ready");
    expect(after?.attempts).toBe(1);
    expect(after?.failureReason).toMatch(/host restart/);
    expect(after?.labels).toContain("awaiting-intervention");
    expect(after?.interventionReason).toMatch(/host restart/);
    expect(after?.interventionAt).toBeTypeOf("number");
  });

  it("worker that throws parks the row in awaiting-intervention and notifies the parent (no retry loop)", async () => {
    // 008: a runtime exception is one of the failure paths that
    // route to intervention. We expect ONE attempt + the
    // awaiting-intervention label, plus a notifyParentSession
    // call with kind=task_intervention_required (when a parent
    // session is set).
    createTask(db, "t1", {
      ownerUserId: "u1",
      title: "boom",
      parentSessionId: "s-parent",
    });

    const brokenFactory = (a: AgentSpec): WorkerHandle | null => ({
      agentId: a.id,
      kind: a.kind,
      name: a.name,
      async run() {
        throw new Error("nope");
      },
    });

    const notifications: Array<{ session: string; kind: string }> = [];
    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      agents: [{ id: "broken", kind: "broken", name: "Broken" }],
      factory: brokenFactory,
      notifyParentSession: (s, m) =>
        notifications.push({ session: s, kind: m.kind }),
    });
    pool.start();
    // Single failure path: the row should settle quickly because
    // there's no auto-retry loop to burn through.
    await pause(40);

    const t = getTask(db, "t1");
    expect(t?.status).toBe("ready");
    expect(t?.attempts).toBe(1);
    expect(t?.labels).toContain("awaiting-intervention");
    expect(t?.failureReason).toContain("nope");
    expect(t?.interventionReason).toContain("nope");
    expect(t?.resultSummary).toBeNull();
    expect(notifications).toEqual([
      { session: "s-parent", kind: "task_intervention_required" },
    ]);
    pool.stop();
  });

  it("higher-priority task is claimed first", async () => {
    createTask(db, "low", { ownerUserId: "u1", title: "low", priority: 0 });
    createTask(db, "high", { ownerUserId: "u1", title: "high", priority: 5 });

    const order: string[] = [];
    const trackFactory = (a: AgentSpec): WorkerHandle | null => ({
      agentId: a.id,
      kind: a.kind,
      name: a.name,
      async run(t) {
        order.push(t.id);
        await pause(2);
        return { status: "done", resultSummary: "ok" };
      },
    });

    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      agents: [{ id: "tracker", kind: "track", name: "Tracker" }],
      factory: trackFactory,
    });
    pool.start();
    await pause(40);

    expect(order[0]).toBe("high");
    pool.stop();
  });

  it("status() reports busy and idle workers", async () => {
    createTask(db, "t1", { ownerUserId: "u1", title: "slow" });
    let resolveRun: (() => void) | null = null;
    const slowFactory = (a: AgentSpec): WorkerHandle | null => ({
      agentId: a.id,
      kind: a.kind,
      name: a.name,
      run(_t) {
        return new Promise<{ status: "done" }>((resolve) => {
          resolveRun = () => resolve({ status: "done" });
        });
      },
    });
    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      agents: [{ id: "slow", kind: "slow", name: "Slow" }],
      factory: slowFactory,
    });
    pool.start();
    await pause(15);
    expect(pool.status().workers[0]).toMatchObject({
      agentId: "slow",
      kind: "slow",
      name: "Slow",
      busy: true,
    });
    expect(pool.status().running).toEqual(["t1"]);

    resolveRun?.();
    await pause(15);
    expect(pool.status().workers[0]).toMatchObject({
      agentId: "slow",
      busy: false,
    });
    pool.stop();
  });

  it("stop() prevents follow-up nudges from claiming new tasks", async () => {
    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      agents: [ECHO_AGENT],
      factory: echoFactory(5),
    });
    pool.start();
    pool.stop();

    createTask(db, "t1", { ownerUserId: "u1", title: "post-stop" });
    pool.nudge();
    await pause(20);
    expect(getTask(db, "t1")?.status).toBe("ready");
  });

  it("rebuild() picks up new agents added at runtime", async () => {
    createTask(db, "t1", { ownerUserId: "u1", title: "first" });
    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      agents: [],
      factory: echoFactory(5),
    });
    pool.start();
    await pause(15);
    // No agents -> task still todo
    expect(getTask(db, "t1")?.status).toBe("ready");

    pool.rebuild([ECHO_AGENT]);
    await pause(20);
    expect(getTask(db, "t1")?.status).toBe("done");
    pool.stop();
  });

  it("agent-pinned task is only claimed by that agent", async () => {
    // Two agents; t1 is pinned to agent A, t2 is pinned to agent B.
    // Each agent should claim only its own task.
    const a: AgentSpec = { id: "A", kind: "echo", name: "A" };
    const b: AgentSpec = { id: "B", kind: "echo", name: "B" };
    createTask(db, "t1", {
      ownerUserId: "u1",
      title: "for A",
      workerAgentId: "A",
    });
    createTask(db, "t2", {
      ownerUserId: "u1",
      title: "for B",
      workerAgentId: "B",
    });
    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      agents: [a, b],
      factory: echoFactory(5),
    });
    pool.start();
    await pause(40);
    // both done
    expect(getTask(db, "t1")?.status).toBe("done");
    expect(getTask(db, "t2")?.status).toBe("done");
    pool.stop();
  });

  it("fallback polling claims a ready task whose write path didn't nudge", async () => {
    // Simulate the dependency-release bug: a task lands in the DB
    // through a code path that forgot to call onTaskWrite (e.g. a
    // direct DB INSERT, a sibling plugin marking its predecessor
    // done). Without the fallback poll the task would stay ready
    // forever; with it, the next interval picks it up.
    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      agents: [ECHO_AGENT],
      factory: echoFactory(5),
      pollIntervalMs: 30,
    });
    pool.start();
    // Give the initial nudge time to drain (the queue is empty so
    // it'll just no-op and clear).
    await pause(15);
    // Now insert a task without nudging — only the fallback poll
    // can pick it up.
    db.prepare(
      `INSERT INTO tasks (id, project_slug, owner_user_id, worker_role, worker_agent_id, title, description, status, priority, depends_on, failure_reason, attempts, created_at) VALUES (?, ?, ?, NULL, NULL, ?, NULL, 'ready', 0, '[]', NULL, 0, ?)`,
    ).run("t1", "inbox", "u1", "silent task", Date.now());
    await pause(80);
    expect(getTask(db, "t1")?.status).toBe("done");
    pool.stop();
  });

  // ─── maxConcurrentRuns ────────────────────────────────────────
  //
  // Yu 2026-06-28 evening: the tenant should be able to throttle
  // how many worker tasks run in parallel even if there are more
  // worker_agents rows registered. With cap=N, only N tasks ever
  // sit in `busy` at the same time; surplus queued work waits.

  it("respects maxConcurrentRuns cap when more workers + tasks are available", async () => {
    // Three workers, three ready tasks. Cap = 1 → only one runs
    // at a time; the other two are still ready while the first
    // is in flight, and complete sequentially.
    db.prepare(
      `INSERT INTO tasks (id, project_slug, owner_user_id, worker_role, worker_agent_id, title, description, status, priority, depends_on, failure_reason, attempts, created_at) VALUES (?, ?, ?, NULL, NULL, ?, NULL, 'ready', 0, '[]', NULL, 0, ?)`,
    ).run("t1", "inbox", "u1", "task 1", Date.now());
    db.prepare(
      `INSERT INTO tasks (id, project_slug, owner_user_id, worker_role, worker_agent_id, title, description, status, priority, depends_on, failure_reason, attempts, created_at) VALUES (?, ?, ?, NULL, NULL, ?, NULL, 'ready', 0, '[]', NULL, 0, ?)`,
    ).run("t2", "inbox", "u1", "task 2", Date.now() + 1);
    db.prepare(
      `INSERT INTO tasks (id, project_slug, owner_user_id, worker_role, worker_agent_id, title, description, status, priority, depends_on, failure_reason, attempts, created_at) VALUES (?, ?, ?, NULL, NULL, ?, NULL, 'ready', 0, '[]', NULL, 0, ?)`,
    ).run("t3", "inbox", "u1", "task 3", Date.now() + 2);

    const a: AgentSpec = { id: "a", kind: "echo", name: "A" };
    const b: AgentSpec = { id: "b", kind: "echo", name: "B" };
    const c: AgentSpec = { id: "c", kind: "echo", name: "C" };
    // 25ms delay per worker run; with cap=1 the three tasks
    // serialise, so total wall time is ~75ms. Without the cap
    // they'd all run in parallel and finish in ~25ms.
    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      agents: [a, b, c],
      factory: echoFactory(25),
      maxConcurrentRuns: 1,
    });
    pool.start();

    // Halfway through the first run, only one of t1/t2/t3 should
    // be claimed (status='running'); the others should still be
    // 'ready'.
    await pause(10);
    const midStatuses = ["t1", "t2", "t3"].map(
      (id) => getTask(db, id)?.status,
    );
    const runningCount = midStatuses.filter(
      (s) => s === "in_progress",
    ).length;
    expect(runningCount).toBeLessThanOrEqual(1);

    // All three eventually complete — the cap is a throttle, not
    // a hard limit on total throughput.
    await pause(120);
    expect(getTask(db, "t1")?.status).toBe("done");
    expect(getTask(db, "t2")?.status).toBe("done");
    expect(getTask(db, "t3")?.status).toBe("done");
    pool.stop();
  });

  it("per-user cap throttles a single user without blocking other users", async () => {
    // Two users, each owning two ready tasks. Per-user cap = 1
    // means user A can have at most one in flight, same for B.
    // With 4 workers available the tenant cap (unlimited) lets
    // both users run one in parallel — so we see two concurrent
    // tasks, one per user. The other two tasks wait.
    db.prepare(
      `INSERT INTO users (id, external_id, provider, display_name, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run("user-a", "a", "test", "A", Date.now());
    db.prepare(
      `INSERT INTO users (id, external_id, provider, display_name, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run("user-b", "b", "test", "B", Date.now());
    db.prepare(
      `INSERT INTO tasks (id, project_slug, owner_user_id, worker_role, worker_agent_id, title, description, status, priority, depends_on, failure_reason, attempts, created_at) VALUES (?, ?, ?, NULL, NULL, ?, NULL, 'ready', 0, '[]', NULL, 0, ?)`,
    ).run("a1", "inbox", "user-a", "a1", Date.now());
    db.prepare(
      `INSERT INTO tasks (id, project_slug, owner_user_id, worker_role, worker_agent_id, title, description, status, priority, depends_on, failure_reason, attempts, created_at) VALUES (?, ?, ?, NULL, NULL, ?, NULL, 'ready', 0, '[]', NULL, 0, ?)`,
    ).run("a2", "inbox", "user-a", "a2", Date.now() + 1);
    db.prepare(
      `INSERT INTO tasks (id, project_slug, owner_user_id, worker_role, worker_agent_id, title, description, status, priority, depends_on, failure_reason, attempts, created_at) VALUES (?, ?, ?, NULL, NULL, ?, NULL, 'ready', 0, '[]', NULL, 0, ?)`,
    ).run("b1", "inbox", "user-b", "b1", Date.now() + 2);
    db.prepare(
      `INSERT INTO tasks (id, project_slug, owner_user_id, worker_role, worker_agent_id, title, description, status, priority, depends_on, failure_reason, attempts, created_at) VALUES (?, ?, ?, NULL, NULL, ?, NULL, 'ready', 0, '[]', NULL, 0, ?)`,
    ).run("b2", "inbox", "user-b", "b2", Date.now() + 3);

    const w1: AgentSpec = { id: "w1", kind: "echo", name: "W1" };
    const w2: AgentSpec = { id: "w2", kind: "echo", name: "W2" };
    const w3: AgentSpec = { id: "w3", kind: "echo", name: "W3" };
    const w4: AgentSpec = { id: "w4", kind: "echo", name: "W4" };
    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      agents: [w1, w2, w3, w4],
      factory: echoFactory(25),
      maxConcurrentRunsPerUser: 1,
    });
    pool.start();

    await pause(10);
    // Inspect each user's in-flight count: at most 1 per user,
    // but both users should be making progress simultaneously.
    const inFlightA = ["a1", "a2"].filter(
      (id) => getTask(db, id)?.status === "in_progress",
    ).length;
    const inFlightB = ["b1", "b2"].filter(
      (id) => getTask(db, id)?.status === "in_progress",
    ).length;
    expect(inFlightA).toBeLessThanOrEqual(1);
    expect(inFlightB).toBeLessThanOrEqual(1);

    await pause(120);
    for (const id of ["a1", "a2", "b1", "b2"]) {
      expect(getTask(db, id)?.status).toBe("done");
    }
    pool.stop();
  });

  it("per-user cap and tenant cap combine: whichever fires first stops claims", async () => {
    // Tenant cap = 2, per-user cap = 1. With user A owning four
    // tasks the per-user cap fires first — only one A task at a
    // time even though the tenant has room for two.
    db.prepare(
      `INSERT INTO users (id, external_id, provider, display_name, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run("user-a", "a", "test", "A", Date.now());
    for (let i = 1; i <= 4; i++) {
      db.prepare(
        `INSERT INTO tasks (id, project_slug, owner_user_id, worker_role, worker_agent_id, title, description, status, priority, depends_on, failure_reason, attempts, created_at) VALUES (?, ?, ?, NULL, NULL, ?, NULL, 'ready', 0, '[]', NULL, 0, ?)`,
      ).run(`a${i}`, "inbox", "user-a", `a${i}`, Date.now() + i);
    }
    const w1: AgentSpec = { id: "w1", kind: "echo", name: "W1" };
    const w2: AgentSpec = { id: "w2", kind: "echo", name: "W2" };
    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      agents: [w1, w2],
      factory: echoFactory(20),
      maxConcurrentRuns: 2,
      maxConcurrentRunsPerUser: 1,
    });
    pool.start();

    await pause(8);
    const inFlight = ["a1", "a2", "a3", "a4"].filter(
      (id) => getTask(db, id)?.status === "in_progress",
    ).length;
    // Tenant cap would allow 2, but per-user cap of 1 wins.
    expect(inFlight).toBeLessThanOrEqual(1);

    await pause(120);
    for (const id of ["a1", "a2", "a3", "a4"]) {
      expect(getTask(db, id)?.status).toBe("done");
    }
    pool.stop();
  });

  it("unlimited (cap=0) keeps legacy behaviour: every slot can run in parallel", async () => {
    db.prepare(
      `INSERT INTO tasks (id, project_slug, owner_user_id, worker_role, worker_agent_id, title, description, status, priority, depends_on, failure_reason, attempts, created_at) VALUES (?, ?, ?, NULL, NULL, ?, NULL, 'ready', 0, '[]', NULL, 0, ?)`,
    ).run("t1", "inbox", "u1", "task 1", Date.now());
    db.prepare(
      `INSERT INTO tasks (id, project_slug, owner_user_id, worker_role, worker_agent_id, title, description, status, priority, depends_on, failure_reason, attempts, created_at) VALUES (?, ?, ?, NULL, NULL, ?, NULL, 'ready', 0, '[]', NULL, 0, ?)`,
    ).run("t2", "inbox", "u1", "task 2", Date.now() + 1);
    const a: AgentSpec = { id: "a", kind: "echo", name: "A" };
    const b: AgentSpec = { id: "b", kind: "echo", name: "B" };
    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      agents: [a, b],
      factory: echoFactory(25),
      // No cap.
    });
    pool.start();
    await pause(10);
    // Both should be in flight at the same time.
    const midStatuses = ["t1", "t2"].map(
      (id) => getTask(db, id)?.status,
    );
    expect(midStatuses).toEqual(["in_progress", "in_progress"]);
    await pause(60);
    expect(getTask(db, "t1")?.status).toBe("done");
    expect(getTask(db, "t2")?.status).toBe("done");
    pool.stop();
  });
});
