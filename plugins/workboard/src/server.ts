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

import fs from "node:fs";
import path from "node:path";
import type {
  AgentLoopRunner,
  PluginContext,
  PluginServerExports,
  PluginServerModule,
  SessionInboxCapability,
  ToolCatalogCapability,
  SkillCatalogCapability,
  TaskSandboxPool,
} from "@tianshu/plugin-sdk";
import { setAgentEnabled } from "./fs-worker-agents.js";
import {
  EchoWorker,
  LLMWorker,
  WorkerPool,
  type AgentSpec,
  type WorkerHandle,
} from "./worker/pool.js";
import { WORKER_DENY_TOOLS_SET } from "./worker/tool-policy.js";
import {
  buildModelListTool,
  buildTaskAbortTool,
  buildTaskCompleteTool,
  buildTaskContinueTool,
  buildTaskCreateTool,
  buildTaskExtendTimeoutTool,
  buildTaskGetHistoryTool,
  buildTaskRetryFreshTool,
  buildTaskDeleteTool,
  buildTaskListTool,
  buildTaskMoveTool,
  buildTaskUpdateTool,
  type ToolDeps,
} from "./tools/index.js";
import { buildRoutes, type WorkerKindDef } from "./routes/handlers.js";
import { ensureSchema } from "./db/schema.js";
import { loadWorkerAgents } from "./fs-worker-agents.js";
import { computeEffectiveSkillsFor } from "./effective-skills.js";
import type { WorkerAgent } from "./types.js";

interface ActiveState {
  pool: WorkerPool;
  log: PluginContext["log"];
  /** Filesystem watcher on `_tenant/config/workers/` so a new
   *  worker bundle landing on disk (via tenant_config_write or
   *  the user's editor) rebuilds the pool without a host
   *  restart. Closed in deactivate(). */
  workersWatcher: fs.FSWatcher | null;
  /** Debounce timer for the watcher — file editors trigger 3-5
   *  events per save. */
  workersWatcherTimer: NodeJS.Timeout | null;
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

    // Drop the legacy worker_agents table if it's still around;
    // ensure tasks.worker_agent_id (now used as a slug column) exists.
    ensureSchema(ctx.db);

    // Owner discovery: agent rows don't pin to a user, but every
    // task does. The factory builds a handle without a task in
    // hand, so we precompute a `defaultUserId` per agent from
    // either `owner_user_id` (if the agent itself was created by
    // a specific user) or fall back to the first user we find in
    // the tenant. The handle uses task.ownerUserId at run-time;
    // this default is only used when the task somehow lacks one.
    const fallbackUser = firstUserId(ctx.db);
    // Worker-agent inventory is read from disk — each subdirectory
    // under `<tenant>/_tenant/config/workers/<slug>/` is one
    // worker. Filesystem is the only source post-PR-C2; the
    // legacy `workboard_worker_agents` table is gone.
    function refreshAgentInventory(): WorkerAgent[] {
      const r = loadWorkerAgents({
        tenantId: ctx.tenantId,
        tenantHomeDir: ctx.workspaceDir,
      });
      for (const e of r.fsErrors) {
        ctx.log.warn("workboard: fs worker agent has errors", {
          slug: e.slug,
          reasons: e.reasons,
        });
      }
      return r.agents;
    }
    const agentRowsById = new Map<string, WorkerAgent>();
    for (const a of refreshAgentInventory()) {
      agentRowsById.set(a.id, a);
    }

    // Per-task sandbox lifecycle. Resolved up front so the
    // factory closure (below) and the WorkerPool constructor
    // (further down) both see the same value. When microsandbox
    // isn't loaded this is undefined; everything falls back to
    // the long-lived sandbox.shell runner.
    const taskPool = ctx.capabilities.get<TaskSandboxPool>(
      "sandbox.taskPool",
    );

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
          db: ctx.db,
          taskPool,
        });
      }
      return null;
    };

    const initialAgents = [...agentRowsById.values()]
      .filter((row) => row.enabled)
      .map(
        (row): AgentSpec => ({ id: row.id, kind: row.kind, name: row.name }),
      );

    // Capability-driven inbox bridge. Tenant has the
    // `host.sessionInbox` capability iff the host registered it
    // (which it does in packages/server/src/index.ts). Plugin
    // operates fine without — the pool's terminal hook just
    // skips the notification.
    const sessionInbox = ctx.capabilities.get<SessionInboxCapability>(
      "host.sessionInbox",
    );
    const pool = new WorkerPool({
      db: ctx.db,
      log: ctx.log,
      broadcast: (type, payload) => ctx.broadcast(type, payload),
      agents: initialAgents,
      factory,
      taskPool,
      notifyParentSession: sessionInbox
        ? (sessionId, message) => {
            void sessionInbox.enqueue(sessionId, message).catch((err) => {
              ctx.log.warn("workboard: inbox enqueue failed", {
                sessionId,
                err: err instanceof Error ? err.message : String(err),
              });
            });
          }
        : undefined,
    });
    pool.start();

    // Wire the filesystem watcher. Recursive so any change
    // under `<workspace>/_tenant/config/workers/**` triggers a
    // rebuild — new slug, edited agent.json, deleted SOUL.md,
    // anything. Debounced to coalesce the burst of events most
    // editors emit on a single save (write + rename + chmod).
    //
    // Failure to watch (e.g. dir doesn't exist yet on first run)
    // is non-fatal: the workboard still works, just without
    // hot-reload, which is the pre-008 behaviour anyway.
    const workersDir = path.join(
      ctx.workspaceDir,
      "_tenant",
      "config",
      "workers",
    );
    let workersWatcher: fs.FSWatcher | null = null;
    let workersWatcherTimer: NodeJS.Timeout | null = null;
    try {
      // Make sure the directory exists so fs.watch doesn't throw
      // on tenants whose first task hasn't created any workers
      // yet (the agent-seed code creates this lazily).
      fs.mkdirSync(workersDir, { recursive: true });
      workersWatcher = fs.watch(
        workersDir,
        { recursive: true, persistent: false },
        () => {
          if (workersWatcherTimer) return;
          workersWatcherTimer = setTimeout(() => {
            workersWatcherTimer = null;
            try {
              ctx.log.info("workboard: worker bundle changed, rebuilding pool");
              onAgentsWrite();
            } catch (err) {
              ctx.log.warn("workboard: pool rebuild failed", {
                err: err instanceof Error ? err.message : String(err),
              });
            }
          }, 250);
        },
      );
      // Don't keep the process alive just for this watcher.
      workersWatcher.unref?.();
    } catch (err) {
      ctx.log.warn("workboard: workers/ watcher could not start", {
        err: err instanceof Error ? err.message : String(err),
        path: workersDir,
      });
    }

    active = { pool, log: ctx.log, workersWatcher, workersWatcherTimer };
    ctx.log.info("workboard activated", {
      echoEnabled,
      echoDelayMs,
      agentCount: initialAgents.length,
    });

    const toolDeps: ToolDeps = {
      db: ctx.db,
      log: ctx.log,
      onTaskWrite: () => pool.nudge(),
      // task_abort uses this to cancel the in-flight worker run
      // when the main agent gives up. Returns false (no-op) if
      // the task isn't actively running, which is fine — the
      // status update from the abort tool is what counts.
      onTaskCancel: (taskId) => pool.cancelTaskRun(taskId),
      // task_delete reclaims any per-task sandbox lying around.
      // Best-effort: errors are logged but never block the
      // database delete.
      onTaskDelete: taskPool
        ? (taskId) => {
            void taskPool.destroyTask(taskId).catch((err) => {
              ctx.log.warn("workboard: taskPool.destroyTask failed", {
                taskId,
                err: err instanceof Error ? err.message : String(err),
              });
            });
          }
        : undefined,
    };

    // Pool refresh hook. The legacy worker_agent_* REST surface
    // (now retired) used to call this on every CRUD; today the
    // source of truth is the filesystem under
    // `_tenant/config/workers/<slug>/`. We watch that dir and
    // rebuild the pool whenever a bundle is added / removed /
    // edited so newly-created worker agents show up without a
    // host restart.
    const onAgentsWrite = () => {
      const fresh = refreshAgentInventory();
      agentRowsById.clear();
      for (const a of fresh) agentRowsById.set(a.id, a);
      const next = fresh
        .filter((row) => row.enabled)
        .map(
          (row): AgentSpec => ({ id: row.id, kind: row.kind, name: row.name }),
        );
      pool.rebuild(next);
    };

    // host.skillCatalog drives the "effective skills" expansion
    // shipped to the admin UI — plugins ship skills via this
    // capability and the host self-shipped ones live there too.
    // Optional: if the host doesn't expose it (older host /
    // disabled cap), the helper just falls back to the tenant
    // layers.
    const skillCatalog =
      ctx.capabilities.get<SkillCatalogCapability>("host.skillCatalog") ??
      null;
    const tenantConfigDir = path.join(
      ctx.workspaceDir,
      "_tenant",
      "config",
    );

    const routes = buildRoutes({
      db: ctx.db,
      tenantId: ctx.tenantId,
      log: ctx.log,
      pool,
      onTaskWrite: () => pool.nudge(),
      workerKinds: WORKER_KINDS,
      // GET /agents reads through the same fs-first merge the
      // pool uses, so the admin UI sees identical inventory.
      listMergedAgents: () => refreshAgentInventory(),
      // Per-agent effective skill list (resolves toolsAllow=null
      // / skillsAllow=null to a concrete list rooted in the host
      // catalog + the tenant fs layers).
      computeEffectiveSkills: (agent) =>
        computeEffectiveSkillsFor({
          agent,
          hostSkillCatalog: skillCatalog,
          tenantConfigDir,
        }),
      // PATCH /agents/:slug/enabled writes the bundle's agent.json.
      // The fs watcher already in place catches the write and
      // rebuilds the pool, so the toggle takes effect on the next
      // task pickup without a server restart.
      setAgentEnabled: ({ slug, enabled }) =>
        setAgentEnabled({
          tenantHomeDir: ctx.workspaceDir,
          slug,
          enabled,
        }),
    });

    return {
      tools: {
        TaskListTool: buildTaskListTool(toolDeps),
        TaskCreateTool: buildTaskCreateTool(toolDeps),
        TaskUpdateTool: buildTaskUpdateTool(toolDeps),
        TaskMoveTool: buildTaskMoveTool(toolDeps),
        TaskDeleteTool: buildTaskDeleteTool(toolDeps),
        TaskGetHistoryTool: buildTaskGetHistoryTool(toolDeps),
        TaskCompleteTool: buildTaskCompleteTool(),
        // 008+ intervention tools (main-agent-only by access; the
        // worker pool's deny list keeps workers from calling them).
        TaskContinueTool: buildTaskContinueTool(toolDeps),
        TaskRetryFreshTool: buildTaskRetryFreshTool(toolDeps),
        TaskExtendTimeoutTool: buildTaskExtendTimeoutTool(toolDeps),
        TaskAbortTool: buildTaskAbortTool(toolDeps),
        // Model catalog (main agent only — the available() guard
        // and the worker deny-list both block worker access).
        ModelListTool: buildModelListTool(),
      },
      routes,
    };
  },

  async deactivate() {
    if (active?.workersWatcherTimer) {
      clearTimeout(active.workersWatcherTimer);
    }
    try {
      active?.workersWatcher?.close();
    } catch {
      // best-effort
    }
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
