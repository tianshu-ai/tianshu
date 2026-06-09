// Workboard plugin server entry (ADR-0002 §6 + ADR-0004 §10).
//
// What activate() does:
//   1. Captures the tenant's shared SQLite handle (`ctx.db`). The
//      `tasks` table was already created in the v0 schema migration,
//      so we don't run any DDL here.
//   2. Spins up a single `WorkerPool` with one `EchoWorker`. This is
//      v0.2's deliberate "loop is visible end-to-end" choice — the
//      echo worker just sleeps 30s and stamps a result_summary, but
//      the kanban panel sees the task move through every column.
//      Real worker roles (qianliyan / luban / xihe / nvwa, ADR-0002
//      §1) replace this pool in N+6.2.
//   3. Exposes five agent tools (task_list / task_create / task_update /
//      task_move / task_delete). Tool writes call back into the pool
//      so the worker drains immediately instead of waiting for the
//      next REST nudge.
//   4. Exposes seven REST routes (CRUD + projects + worker status).
//      Routes mounted under /api/p/workboard/*.
//
// `deactivate()` stops the pool. The `ctx.db` handle is owned by the
// host so we never close it.

import type {
  PluginContext,
  PluginServerExports,
  PluginServerModule,
} from "@tianshu/plugin-sdk";
import { EchoWorker, WorkerPool } from "./worker/pool.js";
import {
  buildTaskCreateTool,
  buildTaskDeleteTool,
  buildTaskListTool,
  buildTaskMoveTool,
  buildTaskUpdateTool,
  type ToolDeps,
} from "./tools/index.js";
import { buildRoutes } from "./routes/handlers.js";

interface ActiveState {
  pool: WorkerPool;
  log: PluginContext["log"];
}

let active: ActiveState | null = null;

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    // Per-tenant config:
    //   plugins.workboard.config.echo.enabled  : boolean (default true)
    //   plugins.workboard.config.echo.delayMs  : number  (default 30 000)
    //
    // Tests stub the worker via the new shape; the legacy top-level
    // `echoDelayMs` is honoured for one release (delete after N+6.2).
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

    const workers = echoEnabled ? [new EchoWorker({ delayMs: echoDelayMs })] : [];
    const pool = new WorkerPool({
      db: ctx.db,
      log: ctx.log,
      broadcast: (type, payload) => ctx.broadcast(type, payload),
      workers,
    });
    pool.start();

    active = { pool, log: ctx.log };
    ctx.log.info("workboard activated", {
      echoEnabled,
      echoDelayMs,
      workerCount: workers.length,
    });

    const toolDeps: ToolDeps = {
      db: ctx.db,
      log: ctx.log,
      onTaskWrite: () => pool.nudge(),
    };

    const routes = buildRoutes({
      db: ctx.db,
      log: ctx.log,
      pool,
      onTaskWrite: () => pool.nudge(),
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
