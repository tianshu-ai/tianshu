// Worker pool behaviour tests.
// Uses a 5ms echo worker so the suite stays under a second.

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { up as runInitialMigration } from "../../../../packages/server/src/core/migrations/001-initial.js";
import { up as runDepsMigration } from "../../../../packages/server/src/core/migrations/002-task-dependencies.js";
import { createTask, getTask, updateTask } from "../db/tasks.js";
import { WorkerPool, EchoWorker, type WorkerHandle } from "./pool.js";

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

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
      workers: [new EchoWorker({ delayMs: 5 })],
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

    pool.stop();
  });

  it("nudge() coalesces and a follow-up task is picked up after the first", async () => {
    createTask(db, "t1", { ownerUserId: "u1", title: "first" });
    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      workers: [new EchoWorker({ delayMs: 5 })],
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
      workers: [new EchoWorker({ delayMs: 5 })],
    });
    pool.start();
    await pause(40);

    expect(getTask(db, "t1")?.status).toBe("done");
    pool.stop();
  });

  it("worker that throws marks the task stalled", async () => {
    createTask(db, "t1", { ownerUserId: "u1", title: "boom" });

    const broken: WorkerHandle = {
      role: "broken",
      async run() {
        throw new Error("nope");
      },
    };

    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      workers: [broken],
    });
    pool.start();
    await pause(20);

    const t = getTask(db, "t1");
    expect(t?.status).toBe("stalled");
    expect(t?.resultSummary).toContain("nope");
    pool.stop();
  });

  it("higher-priority task is claimed first", async () => {
    createTask(db, "low", { ownerUserId: "u1", title: "low", priority: 0 });
    createTask(db, "high", { ownerUserId: "u1", title: "high", priority: 5 });

    const order: string[] = [];
    const trackingWorker: WorkerHandle = {
      role: "track",
      async run(t) {
        order.push(t.id);
        await pause(2);
        return { status: "done", resultSummary: "ok" };
      },
    };

    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      workers: [trackingWorker],
    });
    pool.start();
    await pause(40);

    expect(order[0]).toBe("high");
    pool.stop();
  });

  it("status() reports busy and idle workers", async () => {
    createTask(db, "t1", { ownerUserId: "u1", title: "slow" });
    let resolveRun: (() => void) | null = null;
    const slowWorker: WorkerHandle = {
      role: "slow",
      run(_t) {
        return new Promise<{ status: "done" }>((resolve) => {
          resolveRun = () => resolve({ status: "done" });
        });
      },
    };
    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      workers: [slowWorker],
    });
    pool.start();
    await pause(15);
    expect(pool.status().workers[0]).toEqual({ role: "slow", busy: true });
    expect(pool.status().running).toEqual(["t1"]);

    resolveRun?.();
    await pause(15);
    expect(pool.status().workers[0]).toEqual({ role: "slow", busy: false });
    pool.stop();
  });

  it("stop() prevents follow-up nudges from claiming new tasks", async () => {
    const pool = new WorkerPool({
      db,
      log: noopLog,
      broadcast: () => {},
      workers: [new EchoWorker({ delayMs: 5 })],
    });
    pool.start();
    pool.stop();

    createTask(db, "t1", { ownerUserId: "u1", title: "post-stop" });
    pool.nudge();
    await pause(20);
    expect(getTask(db, "t1")?.status).toBe("todo");
  });
});
