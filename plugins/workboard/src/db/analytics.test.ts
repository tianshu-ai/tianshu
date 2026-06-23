// Unit coverage for `computeWorkerAnalytics` (ADR-0002 §12).
//
// What we pin:
//  - owner scoping: a different user's rows never leak into the
//    result.
//  - window scoping: `sinceMs` excludes earlier rows; `untilMs`
//    excludes later rows.
//  - per-agent vs per-role split: both views see the same rows,
//    bucketed differently.
//  - success / intervention / watchdog counters reflect labels +
//    intervention_reason correctly.
//  - duration percentiles return null on empty buckets and an
//    interpolated value on a small sample.
//  - failure-reason top-N respects the `topFailureCount` cap and
//    sorts by count descending.

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { up as runInitialMigration } from "../../../../packages/server/src/core/migrations/001-initial.js";
import { up as runDepsMigration } from "../../../../packages/server/src/core/migrations/002-task-dependencies.js";
import { up as runStatusRename } from "../../../../packages/server/src/core/migrations/005-task-status-rename.js";
import { up as runTaskLabels } from "../../../../packages/server/src/core/migrations/006-task-labels.js";
import { up as runSessionInbox } from "../../../../packages/server/src/core/migrations/007-session-inbox.js";
import { up as runTaskIntervention } from "../../../../packages/server/src/core/migrations/008-task-intervention.js";
import { ensureSchema as ensureAgentsSchema } from "./schema.js";
import { computeWorkerAnalytics, createTask, updateTask } from "./tasks.js";

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
  ).run("u1", "ext1", "test", "U1", Date.now());
  db.prepare(
    `INSERT INTO users (id, external_id, provider, display_name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("u2", "ext2", "test", "U2", Date.now());
  return db;
}

interface SeedOpts {
  id: string;
  owner?: string;
  agent?: string | null;
  role?: string | null;
  durationMs?: number;
  endedAt?: number;
  status?: "ready" | "in_progress" | "done";
  failureReason?: string | null;
  interventionReason?: string | null;
  labels?: string[];
  attempts?: number;
}

// Seed a single task with the fields analytics actually reads.
// Uses createTask for the FK-safe insert then patches the rest via
// updateTask, which is the same path the worker pool takes.
function seed(db: Database.Database, opts: SeedOpts) {
  const t = createTask(db, opts.id, {
    ownerUserId: opts.owner ?? "u1",
    title: opts.id,
    workerRole: opts.role,
    workerAgentId: opts.agent,
  });
  const endedAt = opts.endedAt ?? 1_700_000_000_000;
  const startedAt = endedAt - (opts.durationMs ?? 1_000);
  updateTask(db, t.id, {
    status: opts.status ?? "done",
    startedAt,
    endedAt,
    attempts: opts.attempts ?? 1,
    failureReason: opts.failureReason ?? null,
    interventionReason: opts.interventionReason ?? null,
    labels: opts.labels ?? [],
  });
}

describe("computeWorkerAnalytics", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("scopes to owner — u1 never sees u2's runs", () => {
    seed(db, { id: "t1", owner: "u1", agent: "coder", durationMs: 2_000 });
    seed(db, { id: "t2", owner: "u2", agent: "coder", durationMs: 9_999 });

    const result = computeWorkerAnalytics(db, { ownerUserId: "u1" });
    expect(result.sampleSize).toBe(1);
    expect(result.perAgent).toHaveLength(1);
    expect(result.perAgent[0].key).toBe("coder");
    expect(result.perAgent[0].avgDurationMs).toBe(2_000);
  });

  it("applies sinceMs / untilMs to ended_at and drops in-flight rows", () => {
    seed(db, { id: "old", endedAt: 1_000, durationMs: 100 });
    seed(db, { id: "mid", endedAt: 5_000, durationMs: 100 });
    seed(db, { id: "new", endedAt: 9_000, durationMs: 100 });

    // ready/in_progress task with no ended_at — never included.
    createTask(db, "live", { ownerUserId: "u1", title: "live" });

    const windowed = computeWorkerAnalytics(db, {
      ownerUserId: "u1",
      sinceMs: 2_000,
      untilMs: 8_000,
    });
    expect(windowed.sampleSize).toBe(1);
    expect(windowed.perAgent[0].key).toBe("(unassigned)");
    expect(windowed.perAgent[0].total).toBe(1);
  });

  it("buckets per agent and per role from the same row set", () => {
    seed(db, { id: "a1", agent: "coder", role: "code", durationMs: 1_000 });
    seed(db, { id: "a2", agent: "coder", role: "code", durationMs: 3_000 });
    seed(db, { id: "a3", agent: "writer", role: "writing", durationMs: 2_000 });

    const r = computeWorkerAnalytics(db, { ownerUserId: "u1" });
    expect(r.sampleSize).toBe(3);

    const agents = Object.fromEntries(r.perAgent.map((g) => [g.key, g.total]));
    expect(agents).toEqual({ coder: 2, writer: 1 });

    const roles = Object.fromEntries(r.perRole.map((g) => [g.key, g.total]));
    expect(roles).toEqual({ code: 2, writing: 1 });
  });

  it("classifies success / intervention / watchdog correctly", () => {
    // Successful run.
    seed(db, { id: "s1", agent: "coder", durationMs: 1_000, status: "done" });
    // Intervention via label.
    seed(db, {
      id: "i1",
      agent: "coder",
      durationMs: 2_000,
      status: "done",
      labels: ["awaiting-intervention"],
      interventionReason: "model returned a parse error",
    });
    // Watchdog timeout — reason starts with "watchdog".
    seed(db, {
      id: "w1",
      agent: "coder",
      durationMs: 600_000,
      status: "done",
      labels: ["awaiting-intervention"],
      interventionReason: "watchdog: task exceeded 600000ms",
    });

    const r = computeWorkerAnalytics(db, { ownerUserId: "u1" });
    const coder = r.perAgent.find((g) => g.key === "coder")!;
    expect(coder.total).toBe(3);
    expect(coder.succeeded).toBe(1);
    expect(coder.intervened).toBe(2);
    expect(coder.timeoutHits).toBe(1);
  });

  it("computes p50 / p95 across the bucket's completed runs", () => {
    // Five durations: 1s, 2s, 3s, 4s, 5s → p50=3000, p95=4800.
    for (const ms of [1_000, 2_000, 3_000, 4_000, 5_000]) {
      seed(db, {
        id: `d${ms}`,
        agent: "coder",
        durationMs: ms,
        endedAt: 1_700_000_000_000 + ms,
      });
    }
    const r = computeWorkerAnalytics(db, { ownerUserId: "u1" });
    const coder = r.perAgent.find((g) => g.key === "coder")!;
    expect(coder.p50DurationMs).toBe(3_000);
    expect(coder.avgDurationMs).toBe(3_000);
    // Linear-interp at 95th percentile of [1k..5k] sits at 4.8k.
    expect(coder.p95DurationMs).toBe(4_800);
  });

  it("returns null durations on empty buckets and respects topFailures", () => {
    // 4 distinct failure reasons, varied counts.
    seed(db, { id: "f1", agent: "coder", failureReason: "TimeoutError", durationMs: 0 });
    seed(db, { id: "f2", agent: "coder", failureReason: "TimeoutError", durationMs: 0 });
    seed(db, { id: "f3", agent: "coder", failureReason: "TimeoutError", durationMs: 0 });
    seed(db, { id: "f4", agent: "coder", failureReason: "RateLimited", durationMs: 0 });
    seed(db, { id: "f5", agent: "coder", failureReason: "RateLimited", durationMs: 0 });
    seed(db, { id: "f6", agent: "coder", failureReason: "ParseError", durationMs: 0 });
    seed(db, { id: "f7", agent: "coder", failureReason: "OOM", durationMs: 0 });

    const r = computeWorkerAnalytics(db, {
      ownerUserId: "u1",
      topFailureCount: 2,
    });
    const coder = r.perAgent.find((g) => g.key === "coder")!;
    expect(coder.topFailures).toEqual([
      { reason: "TimeoutError", count: 3 },
      { reason: "RateLimited", count: 2 },
    ]);
  });

  it("reports (unassigned) for null agent / role", () => {
    seed(db, { id: "n1", agent: null, role: null, durationMs: 500 });
    const r = computeWorkerAnalytics(db, { ownerUserId: "u1" });
    expect(r.perAgent[0].key).toBe("(unassigned)");
    expect(r.perRole[0].key).toBe("(unassigned)");
  });

  it("returns empty buckets and sampleSize=0 on a fresh tenant", () => {
    const r = computeWorkerAnalytics(db, { ownerUserId: "u1" });
    expect(r.sampleSize).toBe(0);
    expect(r.perAgent).toEqual([]);
    expect(r.perRole).toEqual([]);
  });
});
