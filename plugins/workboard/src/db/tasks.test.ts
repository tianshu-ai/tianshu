// DB-layer behaviours we care about:
//  - create/list/update/delete round-trips
//  - listTasks scopes to owner + statuses
//  - claimNextTask is atomic (two parallel claims never return the
//    same row)
//  - listProjects groups counts correctly

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { up as runInitialMigration } from "../../../../packages/server/src/core/migrations/001-initial.js";
import { up as runDepsMigration } from "../../../../packages/server/src/core/migrations/002-task-dependencies.js";
import { up as runStatusRename } from "../../../../packages/server/src/core/migrations/005-task-status-rename.js";
import { up as runTaskLabels } from "../../../../packages/server/src/core/migrations/006-task-labels.js";
import { up as runSessionInbox } from "../../../../packages/server/src/core/migrations/007-session-inbox.js";
import { up as runTaskIntervention } from "../../../../packages/server/src/core/migrations/008-task-intervention.js";
import { ensureSchema as ensureAgentsSchema } from "./schema.js";
import {
  createTask,
  listTasks,
  getTask,
  updateTask,
  deleteTask,
  claimNextTask,
  listProjects,
  isEligible,
} from "./tasks.js";

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
  // Tasks reference users(id); seed a stub user so the FK is valid.
  db.prepare(
    `INSERT INTO users (id, external_id, provider, display_name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("u1", "ext1", "test", "Test User", Date.now());
  db.prepare(
    `INSERT INTO users (id, external_id, provider, display_name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("u2", "ext2", "test", "Other User", Date.now());
  return db;
}

describe("tasks db layer", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("creates and reads back a task with defaults", () => {
    const task = createTask(db, "t1", {
      ownerUserId: "u1",
      title: "  Hello  ",
    });
    expect(task.id).toBe("t1");
    expect(task.title).toBe("Hello");
    expect(task.status).toBe("ready");
    expect(task.projectSlug).toBe("inbox");
    expect(task.priority).toBe(0);
    expect(task.workerRole).toBeNull();
    expect(task.startedAt).toBeNull();
    expect(task.endedAt).toBeNull();
    expect(task.resultFiles).toEqual([]);
  });

  it("listTasks scopes to owner and visible statuses", () => {
    createTask(db, "t1", { ownerUserId: "u1", title: "mine A" });
    createTask(db, "t2", { ownerUserId: "u1", title: "mine B" });
    createTask(db, "t3", { ownerUserId: "u2", title: "theirs" });

    const mine = listTasks(db, { ownerUserId: "u1" });
    expect(mine.map((t) => t.id).sort()).toEqual(["t1", "t2"]);

    const theirs = listTasks(db, { ownerUserId: "u2" });
    expect(theirs).toHaveLength(1);
    expect(theirs[0].title).toBe("theirs");

    // aborted is NOT in VISIBLE_STATUSES — should be hidden by default.
    updateTask(db, "t1", { status: "aborted" });
    expect(listTasks(db, { ownerUserId: "u1" }).map((t) => t.id)).toEqual(["t2"]);

    // Explicit status filter resurrects it.
    expect(
      listTasks(db, { ownerUserId: "u1", statuses: ["aborted"] }).map((t) => t.id),
    ).toEqual(["t1"]);
  });

  it("listTasks orders by priority desc, then created_at asc", async () => {
    createTask(db, "low", { ownerUserId: "u1", title: "low", priority: 0 });
    // make timestamps distinct without relying on real wall clock
    await new Promise((r) => setTimeout(r, 5));
    createTask(db, "high", { ownerUserId: "u1", title: "high", priority: 5 });
    await new Promise((r) => setTimeout(r, 5));
    createTask(db, "mid", { ownerUserId: "u1", title: "mid", priority: 5 });

    const ids = listTasks(db, { ownerUserId: "u1" }).map((t) => t.id);
    expect(ids).toEqual(["high", "mid", "low"]);
  });

  it("updateTask patches one or more columns and ignores empty patches", () => {
    const orig = createTask(db, "t1", {
      ownerUserId: "u1",
      title: "Old",
      description: "old desc",
    });

    const patched = updateTask(db, "t1", {
      title: "New",
      priority: 7,
      status: "done",
      resultSummary: "all done",
      resultFiles: ["/uploads/a.csv", "/uploads/b.csv"],
      endedAt: 12345,
    });
    expect(patched).not.toBeNull();
    expect(patched!.title).toBe("New");
    expect(patched!.priority).toBe(7);
    expect(patched!.status).toBe("done");
    expect(patched!.resultSummary).toBe("all done");
    expect(patched!.resultFiles).toEqual(["/uploads/a.csv", "/uploads/b.csv"]);
    expect(patched!.endedAt).toBe(12345);
    expect(patched!.description).toBe("old desc"); // untouched

    // Empty patch returns the current row.
    const same = updateTask(db, "t1", {});
    expect(same?.title).toBe("New");

    expect(orig.id).toBe(patched!.id);
  });

  it("deleteTask returns true on hit, false on miss", () => {
    createTask(db, "t1", { ownerUserId: "u1", title: "a" });
    expect(deleteTask(db, "t1")).toBe(true);
    expect(deleteTask(db, "t1")).toBe(false);
    expect(getTask(db, "t1")).toBeNull();
  });

  it("claimNextTask flips a todo to in_progress atomically", () => {
    createTask(db, "t1", { ownerUserId: "u1", title: "first", priority: 1 });
    createTask(db, "t2", { ownerUserId: "u1", title: "second", priority: 5 });
    // higher-priority claimed first
    const a = claimNextTask(db);
    expect(a?.id).toBe("t2");
    expect(a?.status).toBe("in_progress");
    expect(a?.startedAt).not.toBeNull();

    const b = claimNextTask(db);
    expect(b?.id).toBe("t1");

    const c = claimNextTask(db);
    expect(c).toBeNull();
  });

  it("claimNextTask refuses second claim while the worker has one in flight", () => {
    // Source-of-truth guard: even if the in-memory busy map
    // drifted (rebuild race, dropped stale entries, etc.), the
    // SQL itself must reject a second claim by the same worker.
    createTask(db, "a", { ownerUserId: "u1", title: "a", priority: 1 });
    createTask(db, "b", { ownerUserId: "u1", title: "b", priority: 1 });
    const first = claimNextTask(db, { workerAgentId: "agent-1" });
    expect(first?.id).toBe("a");
    const second = claimNextTask(db, { workerAgentId: "agent-1" });
    expect(second).toBeNull();
    // After the first task ends, the worker can claim again.
    updateTask(db, "a", { status: "done", endedAt: Date.now() });
    const third = claimNextTask(db, { workerAgentId: "agent-1" });
    expect(third?.id).toBe("b");
  });

  it("claimNextTask role-aware: matches own role + role-less tasks, skips foreign roles", () => {
    createTask(db, "any", { ownerUserId: "u1", title: "any" });
    createTask(db, "mine", {
      ownerUserId: "u1",
      title: "mine",
      workerRole: "qianliyan",
    });
    createTask(db, "other", {
      ownerUserId: "u1",
      title: "other",
      workerRole: "luban",
    });

    // worker tagged 'qianliyan' picks up its own role first (FIFO at
    // equal priority — both have priority 0, so created_at order:
    // any, mine, other → first hit is `any`).
    const a = claimNextTask(db, { workerRole: "qianliyan" });
    expect(["any", "mine"]).toContain(a?.id);
    const b = claimNextTask(db, { workerRole: "qianliyan" });
    expect(["any", "mine"]).toContain(b?.id);
    expect(b?.id).not.toBe(a?.id);
    // Foreign role-tagged task left behind.
    const c = claimNextTask(db, { workerRole: "qianliyan" });
    expect(c).toBeNull();

    // A worker with the matching role can pick it up.
    const d = claimNextTask(db, { workerRole: "luban" });
    expect(d?.id).toBe("other");
  });

  it("createTask persists dependsOn and dedupes self-references", () => {
    const a = createTask(db, "a", { ownerUserId: "u1", title: "a" });
    const b = createTask(db, "b", {
      ownerUserId: "u1",
      title: "b",
      dependsOn: ["a", "b", "a", ""], // self-ref + dup + empty all dropped
    });
    expect(b.dependsOn).toEqual(["a"]);
    // round-trip read keeps the array
    expect(getTask(db, "b")?.dependsOn).toEqual(["a"]);
    expect(a.dependsOn).toEqual([]);
  });

  it("isEligible returns true for empty deps, false when any upstream is not done", () => {
    const a = createTask(db, "a", { ownerUserId: "u1", title: "a" });
    const b = createTask(db, "b", {
      ownerUserId: "u1",
      title: "b",
      dependsOn: ["a"],
    });
    expect(isEligible(db, a)).toBe(true);
    expect(isEligible(db, b)).toBe(false);
    updateTask(db, "a", { status: "done" });
    const bAfter = getTask(db, "b")!;
    expect(isEligible(db, bAfter)).toBe(true);
  });

  it("isEligible treats a deleted prerequisite as unsatisfied", () => {
    createTask(db, "a", { ownerUserId: "u1", title: "a" });
    const b = createTask(db, "b", {
      ownerUserId: "u1",
      title: "b",
      dependsOn: ["a"],
    });
    deleteTask(db, "a");
    expect(isEligible(db, b)).toBe(false);
  });

  it("claimNextTask skips blocked tasks and picks the next eligible one", () => {
    createTask(db, "a", { ownerUserId: "u1", title: "a", priority: 5 });
    createTask(db, "b", {
      ownerUserId: "u1",
      title: "b",
      priority: 10, // higher priority but blocked
      dependsOn: ["a"],
    });
    // First claim: b is highest priority but blocked, so a wins.
    const first = claimNextTask(db);
    expect(first?.id).toBe("a");
    // Second claim: a is in_progress (not done), so b still blocked.
    expect(claimNextTask(db)).toBeNull();
    // Mark a done — b becomes eligible.
    updateTask(db, "a", { status: "done" });
    const second = claimNextTask(db);
    expect(second?.id).toBe("b");
  });

  it("updateTask can replace dependsOn (and supports clearing with [])", () => {
    createTask(db, "a", { ownerUserId: "u1", title: "a" });
    createTask(db, "b", { ownerUserId: "u1", title: "b" });
    const c = createTask(db, "c", {
      ownerUserId: "u1",
      title: "c",
      dependsOn: ["a"],
    });
    expect(c.dependsOn).toEqual(["a"]);

    const patched = updateTask(db, "c", { dependsOn: ["a", "b"] });
    expect(patched?.dependsOn).toEqual(["a", "b"]);

    const cleared = updateTask(db, "c", { dependsOn: [] });
    expect(cleared?.dependsOn).toEqual([]);
  });

  it("listProjects groups counts by project + status", () => {
    createTask(db, "a", { ownerUserId: "u1", title: "a", projectSlug: "alpha" });
    createTask(db, "b", { ownerUserId: "u1", title: "b", projectSlug: "alpha" });
    updateTask(db, "b", { status: "done" });
    createTask(db, "c", { ownerUserId: "u1", title: "c", projectSlug: "beta" });
    updateTask(db, "c", { status: "in_progress" });
    createTask(db, "d", { ownerUserId: "u2", title: "d", projectSlug: "alpha" });

    const projects = listProjects(db, "u1");
    const byName = Object.fromEntries(projects.map((p) => [p.projectSlug, p]));
    expect(byName.alpha).toEqual({
      projectSlug: "alpha",
      ready: 1,
      inProgress: 0,
      done: 1,
      total: 2,
    });
    expect(byName.beta).toEqual({
      projectSlug: "beta",
      ready: 0,
      inProgress: 1,
      done: 0,
      total: 1,
    });
    expect(byName.alpha.total + byName.beta.total).toBe(3);
    // u2's row not visible.
    expect(projects.every((p) => p.total > 0)).toBe(true);
  });

  it("isEligible respects pool-skip labels (`stalled`, `draft`)", () => {
    createTask(db, "a", { ownerUserId: "u1", title: "a" });
    createTask(db, "b", { ownerUserId: "u1", title: "b", labels: ["draft"] });
    createTask(db, "c", { ownerUserId: "u1", title: "c", labels: ["stalled"] });
    expect(isEligible(db, getTask(db, "a")!)).toBe(true);
    expect(isEligible(db, getTask(db, "b")!)).toBe(false);
    expect(isEligible(db, getTask(db, "c")!)).toBe(false);
  });

  it("createTask sanitises label inputs (trim, dedupe, drop empties)", () => {
    const t = createTask(db, "x", {
      ownerUserId: "u1",
      title: "x",
      labels: ["  draft  ", "draft", "", "urgent"],
    });
    expect(t.labels.sort()).toEqual(["draft", "urgent"]);
  });

  it("updateTask can replace labels (and supports clearing with [])", () => {
    createTask(db, "x", { ownerUserId: "u1", title: "x", labels: ["draft"] });
    let t = updateTask(db, "x", { labels: ["stalled", "q3"] });
    expect(t?.labels.sort()).toEqual(["q3", "stalled"]);
    t = updateTask(db, "x", { labels: [] });
    expect(t?.labels).toEqual([]);
  });
});
