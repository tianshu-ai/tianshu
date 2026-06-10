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
  PluginContext,
  PluginServerExports,
  PluginServerModule,
} from "@tianshu/plugin-sdk";
import {
  EchoWorker,
  WorkerPool,
  type AgentSpec,
  type WorkerHandle,
} from "./worker/pool.js";
import {
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
    };
    const echoEnabled = cfg.echo?.enabled !== false;
    const echoDelayMs =
      typeof cfg.echo?.delayMs === "number" && cfg.echo.delayMs >= 0
        ? cfg.echo.delayMs
        : typeof cfg.echoDelayMs === "number" && cfg.echoDelayMs >= 0
          ? cfg.echoDelayMs
          : 30_000;

    // Schema first, then seed. Both are idempotent.
    ensureSchema(ctx.db);
    const seedResult = seedBuiltinAgents(ctx.db, ctx.tenantId, BUILTIN_AGENT_SEEDS);
    if (seedResult.inserted > 0 || seedResult.updated > 0) {
      ctx.log.info("seeded worker agents", seedResult);
    }

    const factory = (a: AgentSpec): WorkerHandle | null => {
      if (a.kind === "echo") {
        if (!echoEnabled) return null;
        return new EchoWorker(a.id, a.name, { delayMs: echoDelayMs });
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
      const next = listWorkerAgents(ctx.db, ctx.tenantId)
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

export const activate = plugin.activate.bind(plugin);
export const deactivate = plugin.deactivate?.bind(plugin);
export default plugin;
