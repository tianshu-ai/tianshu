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
import {
  filterSkillsForTenant,
  type LoadedSkill,
} from "../core/plugins/skills.js";
import {
  defaultSystemPrompt,
  formatAvailableSkillsBlock,
  loadHostSkills,
} from "./handler.js";
import { loadTenantSkills } from "../core/tenant-skills.js";
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
  /** Parent (user) session id. */
  parentSessionId?: string | null;
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
  const allPluginTools = pluginRegistry?.toolsForTenant(ctx.tenantId) ?? [];
  const allowSet = req.toolsAllow ? new Set(req.toolsAllow) : null;
  const denySet = req.toolsDeny ? new Set(req.toolsDeny) : null;
  const pluginTools = allPluginTools.filter(({ tool }) => {
    const name = tool.schema.name;
    if (allowSet && !allowSet.has(name)) return false;
    if (denySet && denySet.has(name)) return false;
    return true;
  });
  // Worker-scoped tenant skills: shared `_tenant/config/skills/` plus
  // the kind-specific override at `_tenant/config/workers/<kind>/skills/`.
  // We pin scope by `req.workerRole` (= the worker_agent kind id, e.g.
  // "llm" / "echo"); when no role is provided we still pick up the
  // shared layer so generic worker runs see user-written skills.
  const tenantWorkerScope = req.workerRole
    ? { kind: "worker" as const, workerKind: req.workerRole }
    : { kind: "worker" as const, workerKind: "" };
  const allSkills: LoadedSkill[] = [
    ...loadHostSkills(),
    ...(pluginRegistry?.skillsForTenant(ctx.tenantId) ?? []),
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
  const skillsAllowed = req.skillsAllow ? new Set(req.skillsAllow) : null;
  const skills = filterSkillsForTenant(allSkills, {
    hasTool: (n) => declaredToolNames.has(n),
    hasCapability: (n) => hostCaps.has(n as never),
  }).filter((s) => !skillsAllowed || skillsAllowed.has(s.name));
  const toolset = await buildToolset({
    pluginTools,
    toolContext: {
      tenantId: ctx.tenantId,
      userId,
      capabilities: hostCaps,
      userHomeDir: ctx.userHomeDir(userId),
      tenantHomeDir: homeDir ?? "",
      // Worker scope. `workerRole` is the worker_agent kind id
      // (e.g. "llm"). Drives `tenant_config_write` boundary so a
      // worker can only write to its own `workers/<kind>/skills/`.
      agentScope: req.workerRole
        ? { kind: "worker", workerKind: req.workerRole }
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
    },
  });
  const adapted = adaptToolset(toolset);

  // Two paths into the worker system prompt:
  //   * `req.systemPrompt` set — the worker_agent table provided a
  //     kind-specific SOUL-style prompt; we use it verbatim and
  //     append the available-skills block so the worker can still
  //     discover tenant skills.
  //   * Otherwise fall back to the host default, which already
  //     includes the block.
  let systemPrompt: string;
  if (req.systemPrompt) {
    const skillBlock = formatAvailableSkillsBlock(skills);
    systemPrompt = skillBlock
      ? `${req.systemPrompt}\n\n${skillBlock}`
      : req.systemPrompt;
  } else {
    systemPrompt = defaultSystemPrompt(ctx, userId, skills);
  }
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

  const innerCtl = new AbortController();
  const onExternalAbort = () => innerCtl.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

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
  const unsubscribe = harness.subscribe((event: AgentHarnessEvent) => {
    lastEventAt = Date.now();
    sawAnyEvent = true;
    if ((event as { type?: string }).type === "turn_end") {
      assistantTurns += 1;
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
