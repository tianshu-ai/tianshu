// Headless agent loop for the workboard worker pool, built on
// pi-agent-core's `AgentHarness`.
//
// Why AgentHarness instead of the lower-level runAgentLoop?
//   * harness drives auto-compact, tool gating, session-tree
//     persistence, and steer/follow-up queues for free;
//   * we already implement `SessionStorage` against SQLite so the
//     transcript lives in the same `messages` table as user chat;
//   * sharing harness with the chat handler means tianshu only has
//     one agent runtime.
//
// The headless wrapper here adds:
//   * a worker session created on entry, archived on exit;
//   * three-layer timeouts (first-response / idle / max-run) on
//     top of harness's per-turn semantics;
//   * a `task_complete` capture path so the LLM's terminal call
//     resolves the loop with status='done' + summary + files.
//
// Plugin authors don't see any of this; their tools come from the
// regular plugin registry, run through `agent-tool-adapter`, and
// land in the harness as the same AgentTool[] the chat handler
// uses.

import {
  AgentHarness,
  type AgentHarnessEvent,
  type AgentHarnessOwnEvent,
} from "@earendil-works/pi-agent-core";
import type { TenantContext } from "../core/index.js";
import {
  buildModel,
  findModel,
  getDefaultModel,
  resolveApiKey,
} from "../core/index.js";
import { buildToolset } from "../tools/index.js";
import { dumpSystemPrompt } from "./dump-system-prompt.js";
import { requireHomeDir } from "./require-home-dir.js";
import {
  filterSkillsForTenant,
  type LoadedSkill,
} from "../core/plugins/skills.js";
import {
  defaultSystemPrompt,
  formatAvailableSkillsBlock,
  formatExecutionBiasBlock,
  formatPluginPromptFragments,
  formatRuntimeContextBlock,
  formatWorkerAgentContextBlock,
  substituteUserIdPlaceholders,
  tryAutoCompact,
} from "./handler.js";
import { loadTenantSkills } from "../core/tenant-skills.js";
import { loadWorkerExecutionBiasOverride } from "../core/worker-agents-fs.js";
import type { PluginRegistry } from "../core/plugins/registry.js";
import { adaptToolset } from "./agent-tool-adapter.js";
import { SqliteSessionRepo } from "./sqlite-session-repo.js";
import { makeStubExecutionEnv } from "./stub-execution-env.js";

export interface AgentLoopRequest {
  ctx: TenantContext;
  /** Owner of the worker session. */
  userId: string;
  /** Initial user message. */
  initialUserMessage: string;
  /** Optional system-prompt override. */
  systemPrompt?: string;
  /** Optional model override. */
  modelId?: string;
  /** Allow-list of tool names. `null` / undefined = all available. */
  toolsAllow?: string[] | null;
  /** Deny-list applied AFTER `toolsAllow`; see `AgentLoopRunnerRequest`. */
  toolsDeny?: string[] | null;
  /** Allow-list of skill names. */
  skillsAllow?: string[] | null;
  /** Friendly title for the worker session row. */
  sessionTitle?: string | null;
  /** Worker role to stamp on the session row. */
  workerRole?: string | null;
  /** Worker filesystem slug (matches `_tenant/config/workers/<slug>/`).
   *  Forwarded to `agentScope.slug` so `tenant_config_write` can
   *  scope writes to this worker's own bundle. */
  workerSlug?: string | null;
  /** Parent (user) session id. */
  parentSessionId?: string | null;
  /** Workboard task id when this run is driven by a task. Plumbed
   *  through to `AgentToolContext.taskId` so per-task tools (most
   *  importantly the microsandbox `exec` route) can scope their
   *  resources to the task lifecycle. */
  taskId?: string | null;
  /** Project slug the task belongs to. Plumbed through to
   *  `AgentToolContext.projectSlug` so tools that stage result
   *  files on disk (e.g. openshell `sync_down`) can default to
   *  the project tree without the agent passing it. */
  projectSlug?: string | null;
  /** Task title at run start. Plumbed through to
   *  `AgentToolContext.taskTitle`. User-supplied text — plugins
   *  MUST slugify before routing it into a filesystem path. */
  taskTitle?: string | null;
  /** Plugin registry for tool/skill discovery. */
  pluginRegistry?: PluginRegistry;
  /** Tenant root dir on the host. */
  homeDir?: string;
  /** Soft per-call timeout caps. 0 disables a layer. */
  timeouts?: {
    firstResponseMs?: number;
    idleMs?: number;
    maxRunMs?: number;
  };
  /** External abort signal. */
  signal?: AbortSignal;
  /** Fires once after the worker session row has been inserted. */
  onSessionStart?: (sessionId: string) => void;
  /**
   * Resume an existing worker session instead of creating a fresh
   * one. When set, `initialUserMessage` is treated as a follow-up
   * prompt within the existing transcript.
   */
  resumeSessionId?: string;
}

export interface AgentLoopResult {
  status: "done" | "stalled" | "aborted" | "error";
  summary: string;
  files: string[];
  sessionId: string;
  turns: number;
  reason:
    | "task_complete"
    | "no_completion"
    | "first_response_timeout"
    | "idle_timeout"
    | "max_run_timeout"
    | "aborted"
    | "stream_error"
    | "exception";
}

const TASK_COMPLETE_TOOL = "task_complete";
const DEFAULT_FIRST_RESPONSE_MS = 300_000;
const DEFAULT_IDLE_MS = 600_000;
const DEFAULT_MAX_RUN_MS = 1_800_000;
// Note: no turn cap. The harness has three time-based watchdogs
// (first-response / idle / max-run) which are sufficient for runaway
// detection. A turn cap was inherited from the pre-N+6.4 worker and
// caused legitimate multi-step browser tasks to stall mid-flight.
// If we ever observe a model burning turns without burning time
// (tool-call thrashing without latency), revisit — but that's
// hypothetical, and the chat handler doesn't impose one either, so
// the worker shouldn't either.

export async function runAgentLoop(
  req: AgentLoopRequest,
): Promise<AgentLoopResult> {
  const {
    ctx,
    userId,
    initialUserMessage,
    pluginRegistry,
    homeDir,
    signal: externalSignal,
  } = req;

  const repo = new SqliteSessionRepo(ctx);
  // Resume vs. fresh:
  //   - When the caller (e.g. workboard's retry path) passes
  //     `resumeSessionId` AND that session still exists in this
  //     tenant's DB, we open it. The LLM sees the prior turns
  //     as context and `initialUserMessage` is appended as a
  //     follow-up prompt — think "continue from where we left
  //     off".
  //   - Otherwise (fresh task, or stale id) we create a brand
  //     new session row.
  // We catch errors from `open` rather than letting them throw,
  // so a stale id doesn't kill the run — we silently fall back
  // to fresh and log a warning.
  let session: Awaited<ReturnType<typeof repo.create>> | null = null;
  let resumed = false;
  if (req.resumeSessionId) {
    try {
      // `repo.open` only consumes metadata.id internally (see
      // SqliteSessionRepo.open). The other fields are required by
      // the type but ignored at runtime; we pass plausible values
      // sourced from the request so we don't accidentally load a
      // session belonging to another tenant.
      session = await repo.open({
        id: req.resumeSessionId,
        createdAt: new Date(0).toISOString(),
        tenantId: ctx.tenantId,
        userId,
        kind: "worker",
        workerRole: req.workerRole ?? null,
        parentSessionId: req.parentSessionId ?? null,
        title: req.sessionTitle ?? null,
      });
      resumed = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[agent-loop] resumeSessionId=${req.resumeSessionId} not found; creating fresh session`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (!session) {
    session = await repo.create({
      userId,
      kind: "worker",
      workerRole: req.workerRole ?? null,
      parentSessionId: req.parentSessionId ?? null,
      title: req.sessionTitle ?? null,
    });
  }
  const sessionMeta = await session.getMetadata();
  // Notify caller of the freshly-created session row so callers
  // (e.g. the workboard plugin) can link long-running tasks to
  // their session id before the LLM loop runs. We swallow errors
  // because a misbehaving callback shouldn't abort the run.
  if (req.onSessionStart) {
    try {
      req.onSessionStart(sessionMeta.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[agent-loop] onSessionStart callback threw", err);
    }
  }

  // Resolve model.
  const modelInfo =
    (req.modelId ? findModel(ctx.config, req.modelId) : undefined) ??
    getDefaultModel(ctx.config);
  if (!modelInfo) {
    return {
      status: "error",
      summary: "no model configured",
      files: [],
      sessionId: sessionMeta.id,
      turns: 0,
      reason: "exception",
    };
  }
  const piModel = buildModel(modelInfo);
  const apiKey = resolveApiKey(modelInfo);

  // Tools + skills, narrowed by per-agent allow-lists then by an
  // optional deny-list. The deny-list is for cases where the host
  // wants to forbid certain tools regardless of what the agent's
  // allow-list says — worker pools use it to scrub e.g. task_create
  // out of an LLM worker so it can't accidentally manage other
  // tasks while running its own.
  //
  // Refresh stale dynamic toolsets (Playwright MCP, user MCP
  // servers) before snapshotting them. Without this, a worker
  // session that starts before the plugin's initial refresh
  // succeeds (sidecar still booting, or sandbox just reset)
  // sees an empty MCP tool list for the entire run — the chat
  // handler refreshes per turn but workers don't, so they were
  // simply never seeing browser_* tools.
  if (pluginRegistry) {
    try {
      await pluginRegistry.refreshStaleToolsets(ctx.tenantId, 1500);
    } catch (err) {
      // refreshStaleToolsets swallows per-toolset errors itself;
      // an outer throw is unexpected but shouldn't block the run.
      console.warn(
        `[agent-loop] refreshStaleToolsets failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  const allPluginTools = pluginRegistry?.toolsForTenant(ctx.tenantId) ?? [];
  const allowSet = req.toolsAllow ? new Set(req.toolsAllow) : null;
  const denySet = req.toolsDeny ? new Set(req.toolsDeny) : null;
  const pluginTools = allPluginTools.filter(({ tool }) => {
    const name = tool.schema.name;
    if (allowSet && !allowSet.has(name)) return false;
    if (denySet && denySet.has(name)) return false;
    return true;
  });
  // Worker-scoped tenant skills: shared `_tenant/config/skills/`
  // plus the per-worker layer at
  // `_tenant/config/workers/<slug>/skills/`. We prefer `req.workerSlug`
  // when present (matches the on-disk directory exactly); the
  // workerKind fallback is for legacy callers that don't yet
  // forward the slug.
  const tenantWorkerScope = req.workerRole
    ? {
        kind: "worker" as const,
        workerKind: req.workerRole,
        slug: req.workerSlug ?? undefined,
      }
    : { kind: "worker" as const, workerKind: "" };
  const allSkills: LoadedSkill[] = [
    // mirrored = host + plugin skills, all carrying
    // tenant-config:/// paths the worker's tenant_config_read can
    // open. See registry.mirroredSkillsForTenant.
    ...(pluginRegistry?.mirroredSkillsForTenant(ctx.tenantId) ?? []),
    ...loadTenantSkills({
      tenantId: ctx.tenantId,
      scope: tenantWorkerScope,
      onFailure: (f) =>
        console.warn(
          `[tenant-skills:${f.scope}] ${f.filePath}: ${f.reason}`,
        ),
    }),
  ];
  const declaredToolNames = new Set(
    pluginTools.map(({ tool }) => tool.schema.name),
  );
  const hostCaps = pluginRegistry?.hostCapabilities(ctx.tenantId) ?? {
    get: () => undefined,
    has: () => false,
  };
  // skillsAllow scopes only host + plugin skills (the kind that
  // appear in `host.skillCatalog`, which is what the worker-agent
  // ChipPicker is built from). Tenant skills don't participate in
  // that catalog — they're discovered live from
  // `_tenant/config/.../skills/` every turn. Letting allowlist
  // filtering see them would silently hide every newly-dropped
  // tenant skill until the user re-saves the worker_agent row,
  // which is exactly the bug Yu hit (test-shared / test-llm gone
  // from the worker's <available_skills>). So: tenant skills pass
  // through unconditionally; if a user wants to hide one from a
  // worker, they remove the skill directory.
  const skillsAllowed = req.skillsAllow ? new Set(req.skillsAllow) : null;
  const skills = filterSkillsForTenant(allSkills, {
    hasTool: (n) => declaredToolNames.has(n),
    hasCapability: (n) => hostCaps.has(n as never),
    agentScope: "worker",
  }).filter((s) => {
    if (!skillsAllowed) return true;
    if (s.source.pluginId.startsWith("tenant-")) return true;
    return skillsAllowed.has(s.name);
  });
  // Create the inner abort controller before the toolset so we
  // can pipe its signal into AgentToolContext. The signal lets
  // long-running tools (microsandbox `exec`, MCP fetches) bail
  // out the moment a watchdog timeout / external `task_abort`
  // fires, instead of waiting for their own internal timeout.
  // Without this, an aborted run still has to wait for the
  // current tool call to drain, and the worker session shows
  // 'busy' for up to that tool's timeout budget.
  const innerCtl = new AbortController();
  const onExternalAbort = () => innerCtl.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const toolset = await buildToolset({
    pluginTools,
    toolContext: {
      tenantId: ctx.tenantId,
      userId,
      capabilities: hostCaps,
      userHomeDir: ctx.userHomeDir(userId),
      tenantHomeDir: requireHomeDir(homeDir, ctx, "runAgentLoop"),
      // Worker scope. `workerRole` is the worker_agent kind id
      // (e.g. "llm"); `workerSlug` is the fs directory name. Drives
      // `tenant_config_write` boundary so a worker can write under
      // its own `workers/<slug>/skills/` (and read everything).
      agentScope: req.workerRole
        ? {
            kind: "worker",
            workerKind: req.workerRole,
            slug: req.workerSlug ?? undefined,
          }
        : { kind: "main" },
      log: {
        info: (msg, meta) => console.log(`[agent-loop] ${msg}`, meta ?? ""),
        warn: (msg, meta) => console.warn(`[agent-loop] ${msg}`, meta ?? ""),
        error: (msg, meta) =>
          console.error(`[agent-loop] ${msg}`, meta ?? ""),
      },
      // Worker session id — currently no worker tool needs this,
      // but future plugins (e.g. a sub-task spawner) will, and
      // it costs nothing to plumb through.
      sessionId: sessionMeta.id,
      // Optional task binding: lets per-task tools (microsandbox
      // `exec`) scope resources to the task lifecycle.
      taskId: req.taskId ?? undefined,
      // Workboard plumbing: project + title travel alongside
      // taskId so plugins that stage files on disk can default
      // their destinations to the project tree. Null/empty
      // strings normalised to undefined so consumers can use
      // simple truthy checks.
      projectSlug: req.projectSlug || undefined,
      taskTitle: req.taskTitle || undefined,
      // Cancellation signal piped from the agent loop's inner
      // abort controller. Tools that do long-running work
      // (microsandbox `exec`, MCP) read this and bail when the
      // run is aborted from the outside (`task_abort`, watchdog
      // timeout, idle timeout).
      signal: innerCtl.signal,
    },
  });
  const adapted = adaptToolset(toolset);

  // Plugin-contributed system prompt fragments (ADR-0006). Workers
  // need these for the same reason main does: when a plugin ships a
  // tool, the rules for using that tool live in the plugin manifest.
  // Without this block, every worker re-derives "don't run a foreground
  // server in exec", "call read_file before edit_file", etc., from its
  // SOUL prompt — versions drift, and any plugin-update prompt fix
  // misses workers entirely.
  //
  // ADR-0006 originally only wired the chat handler; the worker path
  // here was deferred to a follow-up. ADR-0007 PR-B closes that gap.
  // Filtering by `scope` (`main` | `worker` | `all`) is owned by the
  // registry; this site asks for fragments and renders whatever it
  // gets back. Workers can request a subset ("worker" only) once
  // ADR-0006's `scope` field ships in PR-C; until then we render
  // every contributed fragment, which matches main's behaviour.
  const pluginFragments =
    pluginRegistry?.systemPromptFragmentsForTenant(ctx.tenantId) ?? [];
  const fragmentBlock = formatPluginPromptFragments(pluginFragments);

  // Two paths into the worker system prompt:
  //   * `req.systemPrompt` set — the worker_agent table provided a
  //     kind-specific SOUL-style prompt. Stitch:
  //         <SOUL>
  //         <plugin guidance fragments>
  //         <available skills>
  //     The order matters: SOUL is who-the-worker-is (highest
  //     priority), fragments are how-to-use-tools (lower than
  //     identity, higher than discoverable skills), skills are
  //     situational reference. Same ordering as `defaultSystemPrompt`
  //     for the main agent.
  //   * Otherwise fall back to the host default, which already
  //     includes both the fragment and skill blocks via
  //     `defaultSystemPrompt`.
  let systemPrompt: string;
  if (req.systemPrompt) {
    // Worker SOUL path. Order:
    //   <SOUL>                  identity / who-the-worker-is
    //   <Execution Bias>         host-level behaviour rules — same
    //                            text the main agent gets, so a
    //                            stalled-on-no-completion failure
    //                            mode hits both paths uniformly.
    //   <Workspace Context>      AGENTS.md / USER.md from the
    //                            worker's user home (SOUL.md is
    //                            already covered by req.systemPrompt;
    //                            inject the rest so user prefs reach
    //                            workers too).
    //   <plugin fragments>       how-to-use-tools (lower than
    //                            identity, higher than discoverable
    //                            skills).
    //   <available skills>       situational reference.
    const skillBlock = formatAvailableSkillsBlock(skills);
    // Worker prompts get the same runtime-context injection the
    // main agent gets — time / timezone / host / identity. A
    // long-running worker that needs "what's today's date?" or
    // "am I on Linux for these shell flags?" should not have to
    // call a tool to find out.
    // Execution bias: a worker may carry its own host-block
    // override (Solution apply writes workers/<slug>/agent.json +
    // execution-bias.md). Independent of the main agent's override
    // — we resolve the worker's own sidecar here, falling back to
    // the host default when absent. Read fresh each run so an
    // applied solution takes effect without a restart.
    const workerExecutionBias = req.workerSlug
      ? loadWorkerExecutionBiasOverride(ctx.tenantId, req.workerSlug, ctx.home)
      : null;
    const parts = [
      req.systemPrompt,
      formatRuntimeContextBlock({ tenantId: ctx.tenantId, userId }),
      workerExecutionBias ?? formatExecutionBiasBlock(),
    ];
    // Worker context: only the worker's own AGENTS.md / MEMORY.md
    // bundle plus the caller's USER.md. SOUL.md is already in
    // req.systemPrompt above; tenant-shared AGENTS/SOUL/MEMORY are
    // explicitly NOT injected for workers — each worker has its
    // own scoped working notes.
    if (req.workerSlug) {
      const ctxBlock = formatWorkerAgentContextBlock(
        ctx.workspaceDir,
        ctx.userHomeDir(userId),
        req.workerSlug,
      );
      if (ctxBlock) parts.push(ctxBlock);
    }
    if (fragmentBlock) parts.push(fragmentBlock);
    if (skillBlock) parts.push(skillBlock);
    systemPrompt = parts.join("\n\n");
  } else {
    systemPrompt = defaultSystemPrompt(ctx, userId, skills, pluginFragments);
  }
  // Bind `<self>` / `<userId>` placeholders in the assembled
  // prompt to the worker's concrete userId. `defaultSystemPrompt`
  // applies the same pass internally; we repeat it here for the
  // worker-SOUL path because that branch builds the prompt
  // manually rather than going through defaultSystemPrompt.
  // Idempotent and cheap, so double-application is harmless.
  systemPrompt = substituteUserIdPlaceholders(systemPrompt, userId);
  // Off-by-default debug dump (see `dump-system-prompt.ts`). Slug
  // tag uses workerSlug when present, falling back to the role kind
  // ("llm", etc.) and finally to a generic "worker" so callers
  // without a slug still produce a stable filename.
  dumpSystemPrompt({
    ctx,
    role: `worker:${req.workerSlug ?? req.workerRole ?? "unknown"}`,
    userId,
    systemPrompt,
  });
  const firstResponseMs =
    req.timeouts?.firstResponseMs ?? DEFAULT_FIRST_RESPONSE_MS;
  const idleMs = req.timeouts?.idleMs ?? DEFAULT_IDLE_MS;
  const maxRunMs = req.timeouts?.maxRunMs ?? DEFAULT_MAX_RUN_MS;

  const startedAt = Date.now();
  let lastEventAt = startedAt;
  let sawAnyEvent = false;
  let assistantTurns = 0;
  let timedOutReason: AgentLoopResult["reason"] | null = null;
  const completionSink: { summary?: string; files?: string[] } = {};

  // (innerCtl created earlier so AgentToolContext.signal can
  //  reference it; the watchdog below still drives it.)

  const TICK_MS = 100;
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (
      !sawAnyEvent &&
      firstResponseMs > 0 &&
      now - startedAt >= firstResponseMs
    ) {
      timedOutReason = "first_response_timeout";
      innerCtl.abort();
      return;
    }
    if (sawAnyEvent && idleMs > 0 && now - lastEventAt >= idleMs) {
      timedOutReason = "idle_timeout";
      innerCtl.abort();
      return;
    }
    if (maxRunMs > 0 && now - startedAt >= maxRunMs) {
      timedOutReason = "max_run_timeout";
      innerCtl.abort();
      return;
    }
  }, TICK_MS);

  const harness = new AgentHarness({
    env: makeStubExecutionEnv(homeDir ?? ctx.userHomeDir(userId)),
    session,
    tools: adapted.tools,
    systemPrompt,
    model: piModel,
    getApiKeyAndHeaders: async () => ({ apiKey }),
  });

  // Watch harness events for two purposes:
  //   1. Reset the watchdog whenever something happens (timestamps
  //      drive first-response / idle timeouts below).
  //   2. Detect task_complete tool calls and copy their args into
  //      completionSink so the post-run code can resolve `done`.
  // We also count assistant turns so the result row reports a
  // useful number, but no turn-based abort happens — see the note
  // on the constants block.
  // Heartbeat + turn counter on the broadcast channel. `subscribe`
  // delivers anything the harness `emitAny`/`emitOwn`s; we use it
  // for watchdog-resetting and counting assistant turns. The
  // `tool_result` hook below is on a SEPARATE channel — see comment.
  // Reentrancy guard for the auto-compact path. compact() runs
  // its own LLM call (= more turn_end events emitted while we're
  // mid-compaction). Without the guard those nested events would
  // re-trigger compact() forever; see also handler.ts where the
  // chat path is naturally serial because the turn loop drains
  // before the next turn_end fires.
  let compactInFlight = false;
  const unsubscribe = harness.subscribe((event: AgentHarnessEvent) => {
    lastEventAt = Date.now();
    sawAnyEvent = true;
    if ((event as { type?: string }).type === "turn_end") {
      assistantTurns += 1;
      // Auto-compact for workers: fire-and-forget after every
      // assistant turn. Same threshold as the chat path; the
      // worker had been stalling on no_completion when a single
      // task accumulated >70% of the model's context window
      // (e.g. a research worker reading 5 large source files).
      // We reach for compact ASAP rather than waiting for the
      // next prompt because the worker is autonomously chaining
      // turns — if we let context grow until the next call, the
      // call itself fails.
      if (!compactInFlight && modelInfo.contextWindow) {
        compactInFlight = true;
        void (async () => {
          try {
            const r = await tryAutoCompact({
              piSession: session!,
              harness,
              contextWindow: modelInfo.contextWindow,
            });
            if (r.compacted) {
              console.log(
                `[agent-loop] worker auto-compact ran (tokensBefore=${r.tokensBefore})`,
              );
            } else if (r.error) {
              console.warn(
                `[agent-loop] worker auto-compact failed: ${r.error}`,
              );
            }
          } finally {
            compactInFlight = false;
          }
        })();
      }
    }
  });

  // Detect task_complete tool calls and capture the agent's args
  // into completionSink so the post-run code can resolve `done`.
  //
  // IMPORTANT: tool_result is dispatched via `emitHook` (the
  // hook channel) and NOT via `emitAny` (the subscribe channel).
  // pi-agent-core's `harness.subscribe(...)` listener never sees
  // tool_result events — only `harness.on("tool_result", ...)`
  // does. We learned this the hard way: a successful task_complete
  // call would land in the DB but `completionSink.summary` stayed
  // undefined, the run terminated as `no_completion`, and the
  // pool re-queued the task forever.
  const unhookToolResult = harness.on("tool_result", (e) => {
    if (e.toolName !== TASK_COMPLETE_TOOL) return;
    const input = e.input as { summary?: unknown; files?: unknown };
    if (typeof input.summary === "string") {
      completionSink.summary = input.summary;
    }
    if (Array.isArray(input.files)) {
      completionSink.files = input.files.filter(
        (x): x is string => typeof x === "string",
      );
    }
    // Also bump the watchdog — a tool_result counts as activity.
    lastEventAt = Date.now();
    sawAnyEvent = true;
    return undefined;
  });

  let result: AgentLoopResult;
  try {
    // Wire the abort signal: when innerCtl aborts (timeout / turn
    // cap / external), tell the harness.
    const onAbort = () => void harness.abort();
    innerCtl.signal.addEventListener("abort", onAbort, { once: true });

    await harness.prompt(initialUserMessage);
    await harness.waitForIdle();

    if (timedOutReason) {
      result = {
        status: "error",
        summary: timeoutMessage(timedOutReason, {
          firstResponseMs,
          idleMs,
          maxRunMs,
        }),
        files: [],
        sessionId: sessionMeta.id,
        turns: assistantTurns,
        reason: timedOutReason,
      };
    } else if (externalSignal?.aborted) {
      result = {
        status: "aborted",
        summary: "aborted by caller",
        files: [],
        sessionId: sessionMeta.id,
        turns: assistantTurns,
        reason: "aborted",
      };
    } else if (completionSink.summary !== undefined) {
      result = {
        status: "done",
        summary: completionSink.summary,
        files: completionSink.files ?? [],
        sessionId: sessionMeta.id,
        turns: assistantTurns,
        reason: "task_complete",
      };
    } else {
      // Loop ended without task_complete and without hitting any
      // timeout — treat as stalled with whatever the LLM said last
      // (best-effort reading from session). This used to be the
      // "max_turns" branch when the worker capped turns; now it's
      // the only "agent quietly gave up" path.
      const finalText = await lastAssistantText(session);
      result = {
        status: "stalled",
        summary: finalText || "agent stopped without calling task_complete",
        files: [],
        sessionId: sessionMeta.id,
        turns: assistantTurns,
        reason: "no_completion",
      };
    }
  } catch (err) {
    if (timedOutReason) {
      result = {
        status: "error",
        summary: timeoutMessage(timedOutReason, {
          firstResponseMs,
          idleMs,
          maxRunMs,
        }),
        files: [],
        sessionId: sessionMeta.id,
        turns: assistantTurns,
        reason: timedOutReason,
      };
    } else {
      result = {
        status: "error",
        summary: err instanceof Error ? err.message : String(err),
        files: [],
        sessionId: sessionMeta.id,
        turns: assistantTurns,
        reason: "exception",
      };
    }
  } finally {
    clearInterval(watchdog);
    unsubscribe();
    unhookToolResult();
    externalSignal?.removeEventListener("abort", onExternalAbort);
    // Mark the worker session archived so admin tooling stops
    // showing it as active.
    ctx.db
      .prepare<[number, string], unknown>(
        `UPDATE sessions SET status = 'archived', ended_at = ? WHERE id = ?`,
      )
      .run(Date.now(), sessionMeta.id);
  }

  return result;
}

async function lastAssistantText(
  session: import("@earendil-works/pi-agent-core").Session,
): Promise<string> {
  const entries = await session.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type !== "message") continue;
    const m = e.message;
    if (m.role !== "assistant") continue;
    for (const block of m.content as Array<{ type: string; text?: string }>) {
      if (block.type === "text" && typeof block.text === "string") {
        return block.text.trim();
      }
    }
  }
  return "";
}

function timeoutMessage(
  reason: AgentLoopResult["reason"],
  budgets: { firstResponseMs: number; idleMs: number; maxRunMs: number },
): string {
  if (reason === "first_response_timeout") {
    return `LLM did not respond within ${Math.round(budgets.firstResponseMs / 1000)}s`;
  }
  if (reason === "idle_timeout") {
    return `no stream events for ${Math.round(budgets.idleMs / 1000)}s`;
  }
  if (reason === "max_run_timeout") {
    return `worker exceeded max-run budget (${Math.round(budgets.maxRunMs / 1000)}s)`;
  }
  return "timeout";
}
