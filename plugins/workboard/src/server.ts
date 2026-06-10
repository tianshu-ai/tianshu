// Workboard plugin server entry (ADR-0002 §6).
//
// What activate() does:
//   1. Captures the tenant's shared SQLite handle (`ctx.db`). The
//      `tasks` table was already created in 001-initial; the
//      `workboard_worker_agents` table + the `tasks.worker_agent_id`
//      column are owned by this plugin and ensured idempotently here
//      (see db/agents.ts).
//   2. Seeds the plugin's builtin agents (just the echo demo today)
//      via the seed loop's "insert / update untouched / preserve
//      user-edited" rule.
//   3. Spins up a WorkerPool: one slot per agent whose `kind` we
//      know how to staff. v0.2 ships a single runtime, `echo` —
//      real LLM / tool runtimes ship as separate plugins later.
//   4. Exposes five agent tools (task_list / task_create / task_update /
//      task_move / task_delete). Tool writes call back into the pool
//      so the worker drains immediately instead of waiting for the
//      next REST nudge.
//   5. Exposes 12 REST routes (tasks CRUD + projects + worker status +
//      worker_agents CRUD + reset). Mounted under `/api/p/workboard/*`.
//   6. Registers an `adminPages` entry for the worker-agents UI.
//
// `deactivate()` stops the pool. The `ctx.db` handle is owned by the
// host so we never close it.

import type {
  AgentLoopRunner,
  PluginContext,
  PluginServerExports,
  PluginServerModule,
} from "@tianshu/plugin-sdk";
import {
  EchoWorker,
  LLMWorker,
  WorkerPool,
  type AgentSpec,
  type WorkerHandle,
} from "./worker/pool.js";
import {
  buildTaskCompleteTool,
  buildTaskCreateTool,
  buildTaskDeleteTool,
  buildTaskListTool,
  buildTaskMoveTool,
  buildTaskUpdateTool,
  type ToolDeps,
} from "./tools/index.js";
import { buildRoutes, type WorkerKindDef } from "./routes/handlers.js";
import {
  ensureSchema,
  listWorkerAgents,
  seedBuiltinAgents,
  type SeedAgentSpec,
  type WorkerAgent,
} from "./db/agents.js";

interface ActiveState {
  pool: WorkerPool;
  log: PluginContext["log"];
}

let active: ActiveState | null = null;

/** WorkerKinds the workboard runtime knows how to staff. Kept as
 *  plugin-local data — we no longer surface this as a manifest
 *  contribution because nothing outside this plugin needs to know.
 *  When a future plugin ships, say, a `kind=llm` runtime, it'll
 *  expose its own admin page + factory; cross-plugin worker
 *  composition is a separate design (workboard pool factory
 *  pluggability) we'll do then. */
const WORKER_KINDS: WorkerKindDef[] = [
  {
    id: "echo",
    displayName: "Echo (demo)",
    description:
      "Reflects the task title back as result_summary after a configurable delay. Demo worker — only useful while you're watching the kanban move.",
    userCreatable: false,
    // Echo runtime has no per-agent tunables — every echo agent
    // shares the plugin-wide `echo.delayMs`. Description is the
    // only freeform field worth surfacing.
    fields: ["description"],
  },
  {
    id: "llm",
    displayName: "LLM agent",
    description:
      "Runs a configurable LLM agent loop on the task: spins up a worker session, calls the model with the per-agent system prompt + tool/skill allow-list, and writes the result back when the agent calls `task_complete`.",
    userCreatable: true,
    // Full set — LLM agents are the canonical "configure everything"
    // worker type.
    fields: ["description", "modelId", "systemPrompt", "toolsAllow", "skills"],
  },
];

/** Builtin agents seeded on every activate. The seed loop respects
 *  user edits (rows with `overrides_at IS NOT NULL` are left
 *  alone). */
const BUILTIN_AGENT_SEEDS: SeedAgentSpec[] = [
  {
    builtinKey: "echo-demo",
    kind: "echo",
    name: "Echo demo",
    description: "Sleeps, then echoes the task title. Ships with the workboard plugin.",
  },
  {
    builtinKey: "llm-default",
    kind: "llm",
    name: "Default LLM",
    description:
      "Runs the tenant's default model with the host's standard tool set. Edit me to add a system prompt or restrict tools.",
  },
];

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    // Per-tenant config:
    //   plugins.workboard.config.echo.enabled  : boolean (default true)
    //   plugins.workboard.config.echo.delayMs  : number  (default 30 000)
    //
    // `echo.enabled=false` disables the echo runtime entirely
    // (factory returns null), so even if a worker_agents row of
    // kind=echo exists it just sits unstaffed.
    const cfg = (ctx.pluginConfig ?? {}) as {
      echoDelayMs?: number;
      echo?: { enabled?: boolean; delayMs?: number };
      llm?: {
        enabled?: boolean;
        firstResponseSec?: number;
        idleSec?: number;
        maxRunSec?: number;
      };
    };
    const echoEnabled = cfg.echo?.enabled !== false;
    const echoDelayMs =
      typeof cfg.echo?.delayMs === "number" && cfg.echo.delayMs >= 0
        ? cfg.echo.delayMs
        : typeof cfg.echoDelayMs === "number" && cfg.echoDelayMs >= 0
          ? cfg.echoDelayMs
          : 30_000;
    const llmEnabled = cfg.llm?.enabled !== false;
    const llmTimeouts = {
      firstResponseMs:
        sec(cfg.llm?.firstResponseSec, /* default */ 300) * 1_000,
      idleMs: sec(cfg.llm?.idleSec, /* default */ 600) * 1_000,
      maxRunMs: sec(cfg.llm?.maxRunSec, /* default */ 1_800) * 1_000,
    };

    // host.agentLoop is registered by the host before any plugin
    // activates (see server/index.ts hostCapabilities). If it's
    // missing we still come up — echo agents work without it —
    // but every kind=llm row will be skipped at factory time.
    const agentLoopRunner =
      ctx.capabilities.get<AgentLoopRunner>("host.agentLoop");
    if (!agentLoopRunner) {
      ctx.log.warn(
        "host.agentLoop capability missing — LLM workers will be skipped",
      );
    }

    // Schema first, then seed. Both are idempotent.
    ensureSchema(ctx.db);
    const seedResult = seedBuiltinAgents(ctx.db, ctx.tenantId, BUILTIN_AGENT_SEEDS);
    if (seedResult.inserted > 0 || seedResult.updated > 0) {
      ctx.log.info("seeded worker agents", seedResult);
    }

    // Owner discovery: agent rows don't pin to a user, but every
    // task does. The factory builds a handle without a task in
    // hand, so we precompute a `defaultUserId` per agent from
    // either `owner_user_id` (if the agent itself was created by
    // a specific user) or fall back to the first user we find in
    // the tenant. The handle uses task.ownerUserId at run-time;
    // this default is only used when the task somehow lacks one.
    const fallbackUser = firstUserId(ctx.db);
    const agentRowsById = new Map<string, WorkerAgent>();
    for (const a of listWorkerAgents(ctx.db, ctx.tenantId)) {
      agentRowsById.set(a.id, a);
    }

    const factory = (a: AgentSpec): WorkerHandle | null => {
      if (a.kind === "echo") {
        if (!echoEnabled) return null;
        return new EchoWorker(a.id, a.name, { delayMs: echoDelayMs });
      }
      if (a.kind === "llm") {
        if (!llmEnabled) return null;
        if (!agentLoopRunner) return null;
        const row = agentRowsById.get(a.id);
        const defaultUserId = row?.ownerUserId ?? fallbackUser ?? "unknown";
        return new LLMWorker({
          agentId: a.id,
          name: a.name,
          defaultUserId,
          systemPrompt: row?.systemPrompt ?? null,
          modelId: row?.modelId ?? null,
          toolsAllow: row?.toolsAllow ?? null,
          skillsAllow: row?.skills ?? null,
          timeouts: llmTimeouts,
          runner: agentLoopRunner,
          log: ctx.log,
        });
      }
      return null;
    };

    const initialAgents = listWorkerAgents(ctx.db, ctx.tenantId)
      .filter((row) => row.enabled)
      .map(
        (row): AgentSpec => ({ id: row.id, kind: row.kind, name: row.name }),
      );

    const pool = new WorkerPool({
      db: ctx.db,
      log: ctx.log,
      broadcast: (type, payload) => ctx.broadcast(type, payload),
      agents: initialAgents,
      factory,
    });
    pool.start();

    active = { pool, log: ctx.log };
    ctx.log.info("workboard activated", {
      echoEnabled,
      echoDelayMs,
      agentCount: initialAgents.length,
    });

    const toolDeps: ToolDeps = {
      db: ctx.db,
      log: ctx.log,
      onTaskWrite: () => pool.nudge(),
    };

    const seedsByKey = new Map<string, SeedAgentSpec>(
      BUILTIN_AGENT_SEEDS.map((s) => [s.builtinKey, s]),
    );

    const onAgentsWrite = () => {
      const fresh = listWorkerAgents(ctx.db, ctx.tenantId);
      // Refresh the cached agent rows so the factory rebuilds
      // LLMWorkers with the user's latest settings.
      agentRowsById.clear();
      for (const a of fresh) agentRowsById.set(a.id, a);
      const next = fresh
        .filter((row) => row.enabled)
        .map(
          (row): AgentSpec => ({ id: row.id, kind: row.kind, name: row.name }),
        );
      pool.rebuild(next);
    };

    const routes = buildRoutes({
      db: ctx.db,
      tenantId: ctx.tenantId,
      log: ctx.log,
      pool,
      onTaskWrite: () => pool.nudge(),
      onAgentsWrite,
      workerKinds: WORKER_KINDS,
      seedsByKey,
    });

    return {
      tools: {
        TaskListTool: buildTaskListTool(toolDeps),
        TaskCreateTool: buildTaskCreateTool(toolDeps),
        TaskUpdateTool: buildTaskUpdateTool(toolDeps),
        TaskMoveTool: buildTaskMoveTool(toolDeps),
        TaskDeleteTool: buildTaskDeleteTool(toolDeps),
        TaskCompleteTool: buildTaskCompleteTool(),
      },
      routes,
    };
  },

  async deactivate() {
    active?.pool.stop();
    active?.log.info("workboard deactivated");
    active = null;
  },
};

function sec(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
    ? raw
    : fallback;
}

/** Read one user id from the tenant DB to use as a fallback when a
 *  task lands without an owner. Returns null if the tenant somehow
 *  has zero users — the LLMWorker then can't run. */
function firstUserId(db: PluginContext["db"]): string | null {
  const row = db
    .prepare<[], { id: string }>(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`)
    .get();
  return row?.id ?? null;
}

export const activate = plugin.activate.bind(plugin);
export const deactivate = plugin.deactivate?.bind(plugin);
export default plugin;
