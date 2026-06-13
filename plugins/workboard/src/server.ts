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
  SessionInboxCapability,
  ToolCatalogCapability,
  SkillCatalogCapability,
} from "@tianshu/plugin-sdk";
import {
  EchoWorker,
  LLMWorker,
  WorkerPool,
  type AgentSpec,
  type WorkerHandle,
} from "./worker/pool.js";
import { WORKER_DENY_TOOLS_SET } from "./worker/tool-policy.js";
import {
  buildTaskCompleteTool,
  buildTaskCreateTool,
  buildTaskGetHistoryTool,
  buildTaskDeleteTool,
  buildTaskListTool,
  buildTaskMoveTool,
  buildTaskUpdateTool,
  buildWorkerAgentCreateTool,
  buildWorkerAgentDeleteTool,
  buildWorkerAgentKindsListTool,
  buildWorkerAgentListTool,
  buildWorkerAgentResetTool,
  buildWorkerAgentUpdateTool,
  type AgentToolDeps,
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
import { loadMergedWorkerAgents } from "./fs-worker-agents.js";

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
/**
 * SOUL-style worker prompt. Mirrors the OpenClaw convention
 * (SOUL.md / SKILL.md persona files): an opening identity line,
 * core responsibilities, and a hard contract on the exit signal.
 *
 * Workers are stateless from the user's perspective — the orchestrator
 * agent fans tasks out, each worker takes one task at a time, runs to
 * completion, and reports back via task_complete. The prompt below is
 * what we want EVERY default LLM worker to know without the user
 * having to fill anything in. Per-agent overrides on top of this stay
 * possible (the seed only writes when the row hasn't been edited).
 *
 * Keep this prompt short. Workers don't need to know about the chat
 * shell or other agents — they just need to do one task and finish.
 */
const LLM_WORKER_SOUL = `You are a workboard worker agent.

You were started because the orchestrator dropped a task on the
kanban for you. Each invocation handles ONE task end-to-end and
then exits.

## Your job

- Read the task title and description carefully. The user (the
  asking agent) wrote them; treat them as the spec.
- Use whatever tools you need to do the work. The host's standard
  tool set is available unless the orchestrator restricted you.
- Write deliverables under the user's workspace (./projects/<slug>/
  for finished output, ./tmp/ for scratch).

## Exit contract (important)

When you're done — or if the task is impossible and you've
decided to give up — call the \`task_complete\` tool with a
one-line \`summary\` of what you produced (or, on failure, why
you couldn't). Optionally include \`files\` for paths you wrote.

The orchestrator only sees the summary you pass to task_complete
— prose alone won't reach it. If you finish without calling this
tool, the pool counts the run as stalled and will retry.

Do NOT ask the user clarifying questions: there's no human in
your loop. If the spec is ambiguous, make a reasonable choice,
proceed, and explain the choice in the task_complete summary.

Reply concisely. Don't narrate every tool call — just do the
work.`;

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
      "Default LLM worker. Picks up tasks tagged with worker_role=llm (or unrouted) and runs them to task_complete.",
    systemPrompt: LLM_WORKER_SOUL,
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

    // Resolve the host's current tool / skill catalogs so the
    // Default LLM seed lists every allowed tool/skill explicitly.
    // Capabilities are optional — if the host doesn't expose them
    // (older host, capability disabled), we fall back to null,
    // which the worker treats as "no restriction". Either way the
    // runtime behaviour is the same; the listed form is just
    // friendlier in the settings UI.
    const toolCatalogCap = ctx.capabilities.get<ToolCatalogCapability>(
      "host.toolCatalog",
    );
    const skillCatalogCap = ctx.capabilities.get<SkillCatalogCapability>(
      "host.skillCatalog",
    );
    // Workboard's own tools aren't in the host's tool catalog at
    // *our* activation time — the registry is still mid-activate
    // for this plugin. Seed them from the manifest so the
    // Default LLM agent gets them on the first activation pass.
    //
    // The orchestration tools (task_list / task_create / etc.)
    // are deliberately excluded: those belong to the orchestrator
    // agent (the chat session that calls task_create to delegate),
    // not to the worker that's executing one task. The worker's
    // only board-facing tool is task_complete — its exit signal.
    // Granting the orchestration set to a worker would just be
    // visually misleading; runtime would still reject the call
    // via WORKER_DENY_TOOLS in pool.ts. Mirroring the deny set in
    // the seed keeps the UI honest about what the worker can do.
    // Deny set lives in ./worker/tool-policy.ts (shared with the
    // pool runtime + admin UI).
    const ownTools = ["task_complete"];
    const ownSkills = ["workboard-howto"];

    const catalogTools = toolCatalogCap
      ? toolCatalogCap.list().map((e) => e.name)
      : [];
    const catalogSkills = skillCatalogCap
      ? skillCatalogCap.list().map((e) => e.name)
      : [];

    // Union, dedup, alphabetic. Filter out any orchestration tools
    // the catalog might have (workboard's own tools won't be there
    // mid-activate, but if a future re-seed pass picks them up,
    // we still want them gone for the worker's allow-list).
    const allToolNames =
      catalogTools.length === 0 && !toolCatalogCap
        ? null
        : [...new Set([...catalogTools, ...ownTools])]
            .filter((n) => !WORKER_DENY_TOOLS_SET.has(n))
            .sort((a, b) => a.localeCompare(b));
    const allSkillNames =
      catalogSkills.length === 0 && !skillCatalogCap
        ? null
        : [...new Set([...catalogSkills, ...ownSkills])].sort((a, b) =>
            a.localeCompare(b),
          );

    // Inject the resolved catalogs into the seed for the LLM
    // worker. The seed for the echo worker doesn't carry these
    // fields. We do this on every activate (not just first install)
    // so a plugin enable that adds new tools propagates into the
    // builtin agent's allow-list, as long as the user hasn't
    // edited it themselves (seedBuiltinAgents skips rows whose
    // overrides_at is set).
    const seedsForThisActivation = BUILTIN_AGENT_SEEDS.map((s) =>
      s.builtinKey === "llm-default"
        ? {
            ...s,
            toolsAllow: allToolNames ?? s.toolsAllow,
            skills: allSkillNames ?? s.skills,
          }
        : s,
    );

    const seedResult = seedBuiltinAgents(
      ctx.db,
      ctx.tenantId,
      seedsForThisActivation,
    );
    if (seedResult.inserted > 0 || seedResult.updated > 0) {
      ctx.log.info("seeded worker agents", {
        ...seedResult,
        toolCount: allToolNames?.length ?? null,
        skillCount: allSkillNames?.length ?? null,
      });
    }

    // Owner discovery: agent rows don't pin to a user, but every
    // task does. The factory builds a handle without a task in
    // hand, so we precompute a `defaultUserId` per agent from
    // either `owner_user_id` (if the agent itself was created by
    // a specific user) or fall back to the first user we find in
    // the tenant. The handle uses task.ownerUserId at run-time;
    // this default is only used when the task somehow lacks one.
    const fallbackUser = firstUserId(ctx.db);
    // Worker-agent inventory is read from two sources during the
    // DB → fs migration:
    //   1. fs:  `<tenant>/_tenant/config/workers/<slug>/agent.json`
    //          (the new source of truth, seeded via the manifest's
    //          `agentSeeds[]` contribution)
    //   2. db:  the legacy `worker_agents` table (kept as a
    //          fallback so user-created rows from before the
    //          migration keep running)
    // fs wins on identity collisions; same-slug DB rows are hidden.
    function refreshAgentInventory(): WorkerAgent[] {
      const dbAgents = listWorkerAgents(ctx.db, ctx.tenantId);
      const merged = loadMergedWorkerAgents({
        tenantId: ctx.tenantId,
        tenantHomeDir: ctx.workspaceDir,
        dbAgents,
      });
      for (const e of merged.fsErrors) {
        ctx.log.warn("workboard: fs worker agent has errors", {
          slug: e.slug,
          reasons: e.reasons,
        });
      }
      return merged.agents;
    }
    const agentRowsById = new Map<string, WorkerAgent>();
    for (const a of refreshAgentInventory()) {
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
          db: ctx.db,
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

    // worker_agent_* tools share `toolDeps` and add the
    // tenant/kind/seed context that agent CRUD needs. We build it
    // here (instead of inline in the tool factory list below) so
    // `onAgentsWrite` is in scope by the time the tools are wired.
    const agentToolDeps: AgentToolDeps = {
      ...toolDeps,
      tenantId: ctx.tenantId,
      workerKinds: WORKER_KINDS,
      seedsByKey,
      // Closed-over reference so tool callers go through the same
      // pool-rebuild path the REST handlers use. Defined just below.
      onAgentsWrite: () => onAgentsWrite(),
    };

    const onAgentsWrite = () => {
      const fresh = refreshAgentInventory();
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
        TaskGetHistoryTool: buildTaskGetHistoryTool(toolDeps),
        TaskCompleteTool: buildTaskCompleteTool(),
        WorkerAgentKindsListTool: buildWorkerAgentKindsListTool(agentToolDeps),
        WorkerAgentListTool: buildWorkerAgentListTool(agentToolDeps),
        WorkerAgentCreateTool: buildWorkerAgentCreateTool(agentToolDeps),
        WorkerAgentUpdateTool: buildWorkerAgentUpdateTool(agentToolDeps),
        WorkerAgentDeleteTool: buildWorkerAgentDeleteTool(agentToolDeps),
        WorkerAgentResetTool: buildWorkerAgentResetTool(agentToolDeps),
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
