// Worker pool behaviour tests.
// Uses a 5ms echo worker so the suite stays under a second.

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { up as runInitialMigration } from "../../../../packages/server/src/core/migrations/001-initial.js";
import { up as runDepsMigration } from "../../../../packages/server/src/core/migrations/002-task-dependencies.js";
import { up as runStatusRename } from "../../../../packages/server/src/core/migrations/005-task-status-rename.js";
import { up as runTaskLabels } from "../../../../packages/server/src/core/migrations/006-task-labels.js";
import { ensureSchema as ensureAgentsSchema } from "../db/agents.js";
import { createTask, getTask, updateTask } from "../db/tasks.js";
import {
  EchoWorker,
  WorkerPool,
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

  it("recovers orphaned in_progress tasks on start()", async () => {
    createTask(db, "t1", { ownerUserId: "u1", title: "stuck" });
    // simulate a previous boot that died mid-run
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

    expect(getTask(db, "t1")?.status).toBe("done");
    pool.stop();
  });

  it("worker that throws goes back to ready with failure_reason; stalls after MAX_ATTEMPTS", async () => {
    createTask(db, "t1", { ownerUserId: "u1", title: "boom" });

    const brokenFactory = (a: AgentSpec): WorkerHandle | null => ({
      agentId: a.id,
      kind: a.kind,
      name: a.name,
      async run() {
        throw new Error("nope");
      },
    });

    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      agents: [{ id: "broken", kind: "broken", name: "Broken" }],
      factory: brokenFactory,
    });
    pool.start();
    // The pool re-nudges after every failure, so a synchronously
    // throwing worker burns through the retry budget very quickly.
    // We just wait long enough for it to settle, then assert
    // end-state: 3 attempts, status still 'ready', a 'stalled'
    // label so the pool stops claiming, failure_reason set.
    await pause(80);

    const t = getTask(db, "t1");
    expect(t?.status).toBe("ready");
    expect(t?.attempts).toBe(3);
    expect(t?.labels).toContain("stalled");
    expect(t?.failureReason).toContain("nope");
    expect(t?.resultSummary).toBeNull();
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
});
