// Worker-agent CRUD + seed loop tests.
//
// Schema is set up via the plugin's own `ensureSchema()` (idempotent
// CREATE IF NOT EXISTS), not a host migration — N+6.2 v2 moved the
// table back into the plugin since nothing outside it references
// agent ids.

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { up as runInitialMigration } from "../../../../packages/server/src/core/migrations/001-initial.js";
import { up as runDepsMigration } from "../../../../packages/server/src/core/migrations/002-task-dependencies.js";
import {
  createUserWorkerAgent,
  deleteWorkerAgent,
  ensureSchema,
  getWorkerAgent,
  listWorkerAgents,
  resetBuiltinAgent,
  seedBuiltinAgents,
  updateWorkerAgent,
  type SeedAgentSpec,
} from "./agents.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = MEMORY");
  runInitialMigration(db);
  runDepsMigration(db);
  ensureSchema(db);
  return db;
}

describe("workboard worker_agents", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("ensureSchema is idempotent", () => {
    ensureSchema(db);
    ensureSchema(db);
    // Sanity: table exists, no agents yet.
    expect(listWorkerAgents(db, "t1")).toEqual([]);
  });

  it("ensureSchema adds tasks.worker_agent_id when missing", () => {
    const cols = db
      .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('tasks')`)
      .all();
    expect(cols.map((c) => c.name)).toContain("worker_agent_id");
  });

  it("createUserWorkerAgent + read-back round-trips JSON columns", () => {
    const a = createUserWorkerAgent(db, "t1", {
      kind: "llm",
      name: "Researcher",
      description: "External research agent",
      modelId: "sap-proxy/claude-sonnet-4-6",
      systemPrompt: "You are a researcher.",
      toolsAllow: ["task_list", "web_fetch"],
      skills: ["research-howto"],
      ownerUserId: "u1",
    });
    expect(a.source).toBe("user");
    expect(a.toolsAllow).toEqual(["task_list", "web_fetch"]);
    expect(a.skills).toEqual(["research-howto"]);
    expect(a.overridesAt).toBeNull();

    const fromDb = getWorkerAgent(db, "t1", a.id)!;
    expect(fromDb.toolsAllow).toEqual(["task_list", "web_fetch"]);
    expect(fromDb.skills).toEqual(["research-howto"]);
  });

  it("seedBuiltinAgents inserts on first call", () => {
    const r = seedBuiltinAgents(db, "t1", [
      { builtinKey: "k1", kind: "echo", name: "Echo demo" },
      {
        builtinKey: "k2",
        kind: "llm",
        name: "General LLM",
        systemPrompt: "Be helpful.",
      },
    ]);
    expect(r).toEqual({ inserted: 2, updated: 0, preserved: 0 });
    expect(listWorkerAgents(db, "t1")).toHaveLength(2);
  });

  it("seedBuiltinAgents updates rows that the user hasn't edited", () => {
    seedBuiltinAgents(db, "t1", [
      { builtinKey: "k1", kind: "echo", name: "Echo demo v1" },
    ]);
    const after = seedBuiltinAgents(db, "t1", [
      {
        builtinKey: "k1",
        kind: "echo",
        name: "Echo demo v2",
        description: "now with extra echo",
      },
    ]);
    expect(after).toEqual({ inserted: 0, updated: 1, preserved: 0 });
    const [row] = listWorkerAgents(db, "t1");
    expect(row.name).toBe("Echo demo v2");
    expect(row.description).toBe("now with extra echo");
    expect(row.overridesAt).toBeNull();
  });

  it("seedBuiltinAgents preserves user-edited rows", () => {
    seedBuiltinAgents(db, "t1", [
      { builtinKey: "k1", kind: "echo", name: "Echo demo v1" },
    ]);
    const seeded = listWorkerAgents(db, "t1")[0];
    updateWorkerAgent(db, "t1", seeded.id, { name: "MyEcho" });

    const after = seedBuiltinAgents(db, "t1", [
      { builtinKey: "k1", kind: "echo", name: "Echo demo v2" },
    ]);
    expect(after).toEqual({ inserted: 0, updated: 0, preserved: 1 });
    expect(listWorkerAgents(db, "t1")[0].name).toBe("MyEcho");
  });

  it("updateWorkerAgent stamps overrides_at and patches fields", () => {
    const a = createUserWorkerAgent(db, "t1", {
      kind: "llm",
      name: "First",
    });
    expect(a.overridesAt).toBeNull();
    const patched = updateWorkerAgent(db, "t1", a.id, {
      name: "Second",
      systemPrompt: "Hello",
    })!;
    expect(patched.name).toBe("Second");
    expect(patched.systemPrompt).toBe("Hello");
    expect(patched.overridesAt).not.toBeNull();
  });

  it("deleteWorkerAgent removes user agents but refuses builtin", () => {
    seedBuiltinAgents(db, "t1", [
      { builtinKey: "k1", kind: "echo", name: "Echo demo" },
    ]);
    const builtin = listWorkerAgents(db, "t1")[0];
    expect(deleteWorkerAgent(db, "t1", builtin.id)).toBe(false);
    expect(listWorkerAgents(db, "t1")).toHaveLength(1);

    const u = createUserWorkerAgent(db, "t1", {
      kind: "llm",
      name: "User one",
    });
    expect(deleteWorkerAgent(db, "t1", u.id)).toBe(true);
    expect(listWorkerAgents(db, "t1")).toHaveLength(1); // builtin still here
  });

  it("scopes to tenant", () => {
    seedBuiltinAgents(db, "t1", [
      { builtinKey: "k1", kind: "echo", name: "T1 echo" },
    ]);
    seedBuiltinAgents(db, "t2", [
      { builtinKey: "k1", kind: "echo", name: "T2 echo" },
    ]);
    expect(listWorkerAgents(db, "t1")).toHaveLength(1);
    expect(listWorkerAgents(db, "t2")).toHaveLength(1);
    expect(listWorkerAgents(db, "t1")[0].name).toBe("T1 echo");
  });

  it("resetBuiltinAgent re-applies seed and clears overrides_at", () => {
    const seeds: SeedAgentSpec[] = [
      { builtinKey: "k1", kind: "echo", name: "Echo demo" },
    ];
    seedBuiltinAgents(db, "t1", seeds);
    const builtin = listWorkerAgents(db, "t1")[0];
    updateWorkerAgent(db, "t1", builtin.id, { name: "MyEcho" });
    expect(getWorkerAgent(db, "t1", builtin.id)?.overridesAt).not.toBeNull();

    const seedsByKey = new Map(seeds.map((s) => [s.builtinKey, s]));
    const r = resetBuiltinAgent(db, "t1", builtin.id, seedsByKey);
    expect(r?.name).toBe("Echo demo");
    expect(r?.overridesAt).toBeNull();
  });

  it("resetBuiltinAgent rejects user-source agents", () => {
    const u = createUserWorkerAgent(db, "t1", { kind: "llm", name: "U" });
    const r = resetBuiltinAgent(db, "t1", u.id, new Map());
    expect(r).toBeNull();
  });

  it("new agents default to enabled=true", () => {
    const a = createUserWorkerAgent(db, "t1", { kind: "llm", name: "A" });
    expect(a.enabled).toBe(true);
  });

  it("updateWorkerAgent flips enabled without stamping overrides_at", () => {
    const a = createUserWorkerAgent(db, "t1", { kind: "llm", name: "A" });
    const off = updateWorkerAgent(db, "t1", a.id, { enabled: false })!;
    expect(off.enabled).toBe(false);
    expect(off.overridesAt).toBeNull();
    const on = updateWorkerAgent(db, "t1", a.id, { enabled: true })!;
    expect(on.enabled).toBe(true);
    expect(on.overridesAt).toBeNull();
  });

  it("updateWorkerAgent that touches name still stamps overrides_at", () => {
    const a = createUserWorkerAgent(db, "t1", { kind: "llm", name: "A" });
    const after = updateWorkerAgent(db, "t1", a.id, {
      name: "B",
      enabled: false,
    })!;
    expect(after.overridesAt).not.toBeNull();
  });

  // Field-allow-list checks live at the route layer, but the DB
  // layer must accept whatever the route passes through — these
  // here are belt-and-suspenders so a future refactor that moves
  // some validation into the DB layer doesn't silently break the
  // existing routes.

  it("seed loop preserves user enabled state across re-seed", () => {
    seedBuiltinAgents(db, "t1", [
      { builtinKey: "k1", kind: "echo", name: "Echo demo" },
    ]);
    const seeded = listWorkerAgents(db, "t1")[0];
    updateWorkerAgent(db, "t1", seeded.id, { enabled: false });

    const r = seedBuiltinAgents(db, "t1", [
      { builtinKey: "k1", kind: "echo", name: "Echo demo v2" },
    ]);
    // Row was only enabled-toggled (no overrides_at stamp), so the
    // seed update path runs and refreshes display fields, but the
    // user's enabled=false survives because the seed loop never
    // writes the enabled column.
    expect(r).toEqual({ inserted: 0, updated: 1, preserved: 0 });
    const after = listWorkerAgents(db, "t1")[0];
    expect(after.name).toBe("Echo demo v2");
    expect(after.enabled).toBe(false);
  });
});
