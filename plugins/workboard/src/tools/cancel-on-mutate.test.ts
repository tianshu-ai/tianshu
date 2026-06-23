// task_move / task_delete must cancel any live worker run BEFORE
// applying the database change. Without this:
//
//   - task_move out of in_progress leaves the worker burning
//     LLM tokens; when the worker terminates it writes status/
//     labels back, racing with (and clobbering) the move.
//   - task_delete with a live worker keeps consuming tokens
//     past the row being gone, then the worker crashes when
//     it tries to write status back (FK / not-found errors).
//
// These tests stub the onTaskCancel hook with a counter so we
// can assert it WAS called for the right rows (and was NOT
// called for the no-op rows, e.g. moving a ready task to ready).

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";

import { up as runInitialMigration } from "../../../../packages/server/src/core/migrations/001-initial.js";
import { up as runDepsMigration } from "../../../../packages/server/src/core/migrations/002-task-dependencies.js";
import { up as runStatusRename } from "../../../../packages/server/src/core/migrations/005-task-status-rename.js";
import { up as runTaskLabels } from "../../../../packages/server/src/core/migrations/006-task-labels.js";
import { up as runSessionInbox } from "../../../../packages/server/src/core/migrations/007-session-inbox.js";
import { up as runTaskIntervention } from "../../../../packages/server/src/core/migrations/008-task-intervention.js";
import { ensureSchema as ensureAgentsSchema } from "../db/schema.js";
import {
  createTask,
  getTask,
  updateTask,
} from "../db/tasks.js";

import {
  buildTaskMoveTool,
  buildTaskDeleteTool,
  type ToolDeps,
} from "./index.js";

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
  // tasks → users FK
  db.prepare(
    `INSERT INTO users (id, external_id, provider, display_name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("u1", "ext1", "test", "Test User", Date.now());
  return db;
}

/** Bare-bones deps with stub callbacks. Each call increments a
 *  counter so the assertions can read it back. */
function makeDeps(db: Database.Database): {
  deps: ToolDeps;
  cancelled: string[];
  deletedSandboxes: string[];
  nudges: number;
} {
  const cancelled: string[] = [];
  const deletedSandboxes: string[] = [];
  let nudges = 0;
  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as ToolDeps["log"];
  return {
    deps: {
      db,
      log,
      onTaskWrite: () => {
        nudges += 1;
      },
      onTaskCancel: (taskId: string) => {
        cancelled.push(taskId);
        // Return `true` to mimic "there was a controller and we
        // aborted it"; the call sites under test don't branch on
        // the return value, so a constant true is fine here.
        return true;
      },
      onTaskDelete: (taskId: string) => {
        deletedSandboxes.push(taskId);
      },
    },
    cancelled,
    deletedSandboxes,
    get nudges() {
      return nudges;
    },
  };
}

const CTX = { userId: "u1" } as Parameters<
  ReturnType<typeof buildTaskMoveTool>["execute"]
>[1];

describe("task_move cancel-on-mutate", () => {
  let db: Database.Database;
  let harness: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    db = freshDb();
    harness = makeDeps(db);
  });

  it("cancels a live worker when moving in_progress → ready", () => {
    // Simulates the kanban UI dragging a card from In-Progress
    // back to Ready (a re-queue). Without the cancel, the
    // worker would keep going and overwrite status on finish.
    const t = createTask(db, "task-1", {
      ownerUserId: "u1",
      title: "spike",
    });
    updateTask(db, t.id, { status: "in_progress", startedAt: Date.now() });

    const tool = buildTaskMoveTool(harness.deps);
    const r = tool.execute({ id: t.id, status: "ready" }, CTX);

    expect(r.ok).toBe(true);
    expect(harness.cancelled).toEqual([t.id]);
    expect(getTask(db, t.id)?.status).toBe("ready");
  });

  it("cancels a live worker when moving in_progress → done", () => {
    // Manual "mark as done" while the worker is still running.
    // Same hazard as the ready case: a delayed worker write
    // would change endedAt / resultSummary out from under us.
    const t = createTask(db, "task-2", {
      ownerUserId: "u1",
      title: "spike",
    });
    updateTask(db, t.id, { status: "in_progress", startedAt: Date.now() });

    const tool = buildTaskMoveTool(harness.deps);
    const r = tool.execute({ id: t.id, status: "done" }, CTX);

    expect(r.ok).toBe(true);
    expect(harness.cancelled).toEqual([t.id]);
  });

  it("does NOT cancel when moving a ready task to ready (no worker)", () => {
    // A no-op move shouldn't fire the cancel hook. Pinning
    // this so a refactor that flips the condition direction
    // would fail loudly.
    const t = createTask(db, "task-3", {
      ownerUserId: "u1",
      title: "spike",
    });

    const tool = buildTaskMoveTool(harness.deps);
    tool.execute({ id: t.id, status: "ready" }, CTX);

    expect(harness.cancelled).toEqual([]);
  });

  it("does NOT cancel when moving done → ready (no worker was running)", () => {
    // Re-queueing a completed task: the worker that produced it
    // is long gone, so cancelling would be a no-op signal at
    // best and (more likely) a misleading log line.
    const t = createTask(db, "task-4", {
      ownerUserId: "u1",
      title: "spike",
    });
    updateTask(db, t.id, {
      status: "done",
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
    });

    const tool = buildTaskMoveTool(harness.deps);
    tool.execute({ id: t.id, status: "ready" }, CTX);

    expect(harness.cancelled).toEqual([]);
  });

  it("does NOT cancel when re-affirming in_progress → in_progress", () => {
    // No-op same-status move. Edge case but cheap to pin.
    const t = createTask(db, "task-5", {
      ownerUserId: "u1",
      title: "spike",
    });
    updateTask(db, t.id, { status: "in_progress", startedAt: Date.now() });

    const tool = buildTaskMoveTool(harness.deps);
    tool.execute({ id: t.id, status: "in_progress" }, CTX);

    expect(harness.cancelled).toEqual([]);
  });
});

describe("task_delete cancel-on-mutate", () => {
  let db: Database.Database;
  let harness: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    db = freshDb();
    harness = makeDeps(db);
  });

  it("cancels a live worker before deleting an in_progress task", () => {
    // The original bug Yu hit: deleting an actively-running
    // task left the worker running; it later crashed trying
    // to write status back to a vanished row.
    const t = createTask(db, "task-1", {
      ownerUserId: "u1",
      title: "spike",
    });
    updateTask(db, t.id, { status: "in_progress", startedAt: Date.now() });

    const tool = buildTaskDeleteTool(harness.deps);
    const r = tool.execute({ ids: [t.id] }, CTX);

    expect(r.ok).toBe(true);
    expect(harness.cancelled).toEqual([t.id]);
    // Sandbox teardown ALSO runs for the same row.
    expect(harness.deletedSandboxes).toEqual([t.id]);
    // Row is gone.
    expect(getTask(db, t.id)).toBeNull();
  });

  it("still calls cancel for non-running tasks (cheap no-op signal)", () => {
    // task_delete fires the cancel hook unconditionally — the
    // pool's cancelTaskRun returns false for tasks that
    // weren't running, but the call itself is harmless. Pin
    // this so a future "optimisation" that skips the cancel
    // call for non-in_progress rows is recognised as a
    // behaviour change (and weighed against the race window
    // it opens for tasks claimed between the row lookup and
    // the deleteTask call).
    const t = createTask(db, "task-2", {
      ownerUserId: "u1",
      title: "spike",
    });

    const tool = buildTaskDeleteTool(harness.deps);
    tool.execute({ ids: [t.id] }, CTX);

    expect(harness.cancelled).toEqual([t.id]);
  });

  it("cancels each task in a batch delete", () => {
    // Batch path mustn't drop the cancel for non-first ids.
    const a = createTask(db, "task-a", {
      ownerUserId: "u1",
      title: "a",
    });
    const b = createTask(db, "task-b", {
      ownerUserId: "u1",
      title: "b",
    });
    updateTask(db, a.id, { status: "in_progress", startedAt: Date.now() });
    updateTask(db, b.id, { status: "in_progress", startedAt: Date.now() });

    const tool = buildTaskDeleteTool(harness.deps);
    tool.execute({ ids: [a.id, b.id] }, CTX);

    expect(harness.cancelled.sort()).toEqual([a.id, b.id].sort());
  });
});
