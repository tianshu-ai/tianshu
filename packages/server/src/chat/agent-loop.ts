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
import { defaultSystemPrompt, loadHostSkills } from "./handler.js";
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
}

export interface AgentLoopResult {
  status: "done" | "stalled" | "aborted" | "error";
  summary: string;
  files: string[];
  sessionId: string;
  turns: number;
  reason:
    | "task_complete"
    | "max_turns"
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
/** Cap assistant turns the same way the legacy worker did. */
const MAX_TURNS = 16;

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
  const session = await repo.create({
    userId,
    kind: "worker",
    workerRole: req.workerRole ?? null,
    parentSessionId: req.parentSessionId ?? null,
    title: req.sessionTitle ?? null,
  });
  const sessionMeta = await session.getMetadata();

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

  // Tools + skills, narrowed by per-agent allow-lists.
  const allPluginTools = pluginRegistry?.toolsForTenant(ctx.tenantId) ?? [];
  const allowSet = req.toolsAllow ? new Set(req.toolsAllow) : null;
  const pluginTools = allowSet
    ? allPluginTools.filter(({ tool }) => allowSet.has(tool.schema.name))
    : allPluginTools;
  const allSkills: LoadedSkill[] = [
    ...loadHostSkills(),
    ...(pluginRegistry?.skillsForTenant(ctx.tenantId) ?? []),
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
    skills,
    toolContext: {
      tenantId: ctx.tenantId,
      userId,
      capabilities: hostCaps,
      userHomeDir: ctx.userHomeDir(userId),
      tenantHomeDir: homeDir ?? "",
      log: {
        info: (msg, meta) => console.log(`[agent-loop] ${msg}`, meta ?? ""),
        warn: (msg, meta) => console.warn(`[agent-loop] ${msg}`, meta ?? ""),
        error: (msg, meta) =>
          console.error(`[agent-loop] ${msg}`, meta ?? ""),
      },
    },
  });
  const adapted = adaptToolset(toolset);

  const systemPrompt = req.systemPrompt ?? defaultSystemPrompt(ctx, userId);
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
  //   1. Reset the watchdog whenever something happens.
  //   2. Detect task_complete tool calls and copy their args into
  //      completionSink so the post-run code can resolve `done`.
  //   3. Count assistant turns to enforce MAX_TURNS.
  const unsubscribe = harness.subscribe((event: AgentHarnessEvent) => {
    lastEventAt = Date.now();
    sawAnyEvent = true;
    const e = event as AgentHarnessOwnEvent;
    if (e.type === "tool_result" && e.toolName === TASK_COMPLETE_TOOL) {
      const input = e.input as { summary?: unknown; files?: unknown };
      if (typeof input.summary === "string") {
        completionSink.summary = input.summary;
      }
      if (Array.isArray(input.files)) {
        completionSink.files = input.files.filter(
          (x): x is string => typeof x === "string",
        );
      }
    }
    if ((event as { type?: string }).type === "turn_end") {
      assistantTurns += 1;
      if (assistantTurns >= MAX_TURNS) {
        innerCtl.abort();
      }
    }
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
    } else if (assistantTurns >= MAX_TURNS) {
      result = {
        status: "stalled",
        summary: `agent loop exceeded ${MAX_TURNS} turns without resolving`,
        files: [],
        sessionId: sessionMeta.id,
        turns: assistantTurns,
        reason: "max_turns",
      };
    } else {
      // Loop ended without task_complete and without hitting any
      // other guard — treat as stalled with whatever the LLM said
      // last (best-effort reading from session).
      const finalText = await lastAssistantText(session);
      result = {
        status: "stalled",
        summary: finalText || "agent stopped without calling task_complete",
        files: [],
        sessionId: sessionMeta.id,
        turns: assistantTurns,
        reason: "max_turns",
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
