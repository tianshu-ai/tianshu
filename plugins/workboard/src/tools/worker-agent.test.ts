// Coverage for the worker_agent_* tools surfaced to the chat
// orchestrator. We exercise the happy path of each tool plus the
// per-kind validation contract — most of the actual CRUD is
// already covered by db/agents.test.ts; here we want to lock
// down the *tool* layer (kind validation, error envelopes, the
// onAgentsWrite call). The same tools also flow through the REST
// surface so handlers.test.ts gives us the routing parity check.

import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { up as runInitialMigration } from "../../../../packages/server/src/core/migrations/001-initial.js";
import { up as runDepsMigration } from "../../../../packages/server/src/core/migrations/002-task-dependencies.js";
import {
  ensureSchema,
  seedBuiltinAgents,
  type SeedAgentSpec,
} from "../db/agents.js";
import type { AgentToolContext } from "@tianshu/plugin-sdk";
import type { WorkerKindDef } from "../routes/handlers.js";
import {
  buildWorkerAgentCreateTool,
  buildWorkerAgentDeleteTool,
  buildWorkerAgentKindsListTool,
  buildWorkerAgentListTool,
  buildWorkerAgentResetTool,
  buildWorkerAgentUpdateTool,
  type AgentToolDeps,
} from "./index.js";

const KINDS: WorkerKindDef[] = [
  {
    id: "echo",
    displayName: "Echo (demo)",
    userCreatable: false,
    fields: ["description"],
  },
  {
    id: "llm",
    displayName: "LLM agent",
    userCreatable: true,
    fields: ["description", "modelId", "systemPrompt", "toolsAllow", "skills"],
  },
];

const ECHO_SEED: SeedAgentSpec = {
  builtinKey: "echo-demo",
  kind: "echo",
  name: "Demo Echo",
  description: "Original description",
};

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = MEMORY");
  runInitialMigration(db);
  runDepsMigration(db);
  ensureSchema(db);
  // Seed an echo row so reset / delete-builtin behaviour is
  // exercisable.
  seedBuiltinAgents(db, "t1", [ECHO_SEED]);
  return db;
}

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const noopCtx: AgentToolContext = {
  userId: "u1",
  tenantId: "t1",
};

function deps(db: Database.Database): {
  d: AgentToolDeps;
  onWrite: ReturnType<typeof vi.fn>;
} {
  const onWrite = vi.fn();
  return {
    onWrite,
    d: {
      db,
      log: noopLog,
      tenantId: "t1",
      onTaskWrite: () => {},
      onAgentsWrite: onWrite,
      workerKinds: KINDS,
      seedsByKey: new Map([[ECHO_SEED.builtinKey, ECHO_SEED]]),
    },
  };
}

describe("worker_agent_kinds_list", () => {
  it("returns one row per registered kind", () => {
    const db = freshDb();
    const { d } = deps(db);
    const r = buildWorkerAgentKindsListTool(d).execute({}, noopCtx);
    expect(r.ok).toBe(true);
    const data = r.data as { kinds: { id: string }[] };
    expect(data.kinds.map((k) => k.id).sort()).toEqual(["echo", "llm"]);
  });
});

describe("worker_agent_list", () => {
  it("filters by kind and enabled flag", () => {
    const db = freshDb();
    const { d } = deps(db);
    // Seed has 1 echo row enabled by default. Add an llm row.
    buildWorkerAgentCreateTool(d).execute(
      { kind: "llm", name: "Coder", modelId: "x" },
      noopCtx,
    );
    const all = buildWorkerAgentListTool(d).execute({}, noopCtx);
    expect((all.data as { agents: unknown[] }).agents).toHaveLength(2);
    const llmOnly = buildWorkerAgentListTool(d).execute(
      { kind: "llm" },
      noopCtx,
    );
    expect((llmOnly.data as { agents: { kind: string }[] }).agents.map((a) => a.kind)).toEqual([
      "llm",
    ]);
    const disabled = buildWorkerAgentListTool(d).execute(
      { enabled: false },
      noopCtx,
    );
    expect((disabled.data as { agents: unknown[] }).agents).toHaveLength(0);
  });
});

describe("worker_agent_create", () => {
  it("creates an llm agent and triggers onAgentsWrite", () => {
    const db = freshDb();
    const { d, onWrite } = deps(db);
    const r = buildWorkerAgentCreateTool(d).execute(
      {
        kind: "llm",
        name: "Sonnet researcher",
        modelId: "sap-proxy/claude-sonnet-4-6",
        toolsAllow: ["web_search"],
      },
      noopCtx,
    );
    expect(r.ok).toBe(true);
    const created = (r.data as { agent: { id: string; modelId: string } }).agent;
    expect(created.modelId).toBe("sap-proxy/claude-sonnet-4-6");
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it("rejects userCreatable=false kinds", () => {
    const db = freshDb();
    const { d, onWrite } = deps(db);
    const r = buildWorkerAgentCreateTool(d).execute(
      { kind: "echo", name: "Another echo" },
      noopCtx,
    );
    expect(r.ok).toBe(false);
    expect((r.data as { code: string }).code).toBe("kind_not_user_creatable");
    expect(onWrite).not.toHaveBeenCalled();
  });

  it("rejects fields that the kind didn't opt into", () => {
    const db = freshDb();
    const { d } = deps(db);
    const r = buildWorkerAgentCreateTool(d).execute(
      {
        kind: "llm",
        name: "ok",
        // llm DOES allow systemPrompt, but pretend caller passed a
        // field the kind didn't opt into. We simulate by pretending
        // `description` is restricted via a kinds list mismatch.
        // Easier: try the inverse — give echo kind a systemPrompt
        // even though echo isn't userCreatable. Use an alt kinds
        // list to make echo userCreatable for the duration of this
        // assertion.
      },
      noopCtx,
    );
    // Sanity: well-formed call passes
    expect(r.ok).toBe(true);

    const altKinds: WorkerKindDef[] = [
      { id: "echo", displayName: "echo", userCreatable: true, fields: ["description"] },
    ];
    const altDeps: AgentToolDeps = {
      ...d,
      workerKinds: altKinds,
    };
    const r2 = buildWorkerAgentCreateTool(altDeps).execute(
      { kind: "echo", name: "x", systemPrompt: "nope" },
      noopCtx,
    );
    expect(r2.ok).toBe(false);
    expect((r2.data as { code: string }).code).toBe(
      "field_not_allowed_for_kind",
    );
  });

  it("rejects unknown kinds", () => {
    const db = freshDb();
    const { d } = deps(db);
    const r = buildWorkerAgentCreateTool(d).execute(
      { kind: "no-such-kind", name: "x" },
      noopCtx,
    );
    expect(r.ok).toBe(false);
    expect((r.data as { code: string }).code).toBe("unknown_kind");
  });
});

describe("worker_agent_update", () => {
  it("patches name and toggles enabled", () => {
    const db = freshDb();
    const { d } = deps(db);
    const created = buildWorkerAgentCreateTool(d).execute(
      { kind: "llm", name: "v1" },
      noopCtx,
    );
    const id = (created.data as { agent: { id: string } }).agent.id;

    const r = buildWorkerAgentUpdateTool(d).execute(
      { id, name: "v2", enabled: false },
      noopCtx,
    );
    expect(r.ok).toBe(true);
    const patched = (r.data as { agent: { name: string; enabled: boolean } }).agent;
    expect(patched.name).toBe("v2");
    expect(patched.enabled).toBe(false);
  });

  it("rejects fields not allowed for the row's kind", () => {
    const db = freshDb();
    const { d } = deps(db);
    // Seeded echo row — only `description` allowed.
    const list = buildWorkerAgentListTool(d).execute({ kind: "echo" }, noopCtx);
    const echoId = (list.data as { agents: { id: string }[] }).agents[0]!.id;
    const r = buildWorkerAgentUpdateTool(d).execute(
      { id: echoId, modelId: "nope" },
      noopCtx,
    );
    expect(r.ok).toBe(false);
    expect((r.data as { code: string }).code).toBe(
      "field_not_allowed_for_kind",
    );
  });
});

describe("worker_agent_delete", () => {
  it("deletes user rows", () => {
    const db = freshDb();
    const { d, onWrite } = deps(db);
    const created = buildWorkerAgentCreateTool(d).execute(
      { kind: "llm", name: "scratch" },
      noopCtx,
    );
    const id = (created.data as { agent: { id: string } }).agent.id;
    onWrite.mockClear();

    const r = buildWorkerAgentDeleteTool(d).execute({ id }, noopCtx);
    expect(r.ok).toBe(true);
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it("refuses to delete builtin rows", () => {
    const db = freshDb();
    const { d } = deps(db);
    const list = buildWorkerAgentListTool(d).execute({ kind: "echo" }, noopCtx);
    const echoId = (list.data as { agents: { id: string }[] }).agents[0]!.id;
    const r = buildWorkerAgentDeleteTool(d).execute({ id: echoId }, noopCtx);
    expect(r.ok).toBe(false);
    expect((r.data as { code: string }).code).toBe("cannot_delete_builtin");
  });
});

describe("worker_agent_reset", () => {
  it("rolls a builtin row back to its seed", () => {
    const db = freshDb();
    const { d } = deps(db);
    const list = buildWorkerAgentListTool(d).execute({ kind: "echo" }, noopCtx);
    const echoId = (list.data as { agents: { id: string }[] }).agents[0]!.id;

    // Mutate the row first.
    buildWorkerAgentUpdateTool(d).execute(
      { id: echoId, description: "edited" },
      noopCtx,
    );

    const r = buildWorkerAgentResetTool(d).execute({ id: echoId }, noopCtx);
    expect(r.ok).toBe(true);
    const after = (r.data as { agent: { description: string | null; overridesAt: number | null } }).agent;
    expect(after.description).toBe("Original description");
    expect(after.overridesAt).toBeNull();
  });

  it("refuses to reset user rows", () => {
    const db = freshDb();
    const { d } = deps(db);
    const created = buildWorkerAgentCreateTool(d).execute(
      { kind: "llm", name: "user-row" },
      noopCtx,
    );
    const id = (created.data as { agent: { id: string } }).agent.id;
    const r = buildWorkerAgentResetTool(d).execute({ id }, noopCtx);
    expect(r.ok).toBe(false);
    expect((r.data as { code: string }).code).toBe("not_builtin");
  });
});
