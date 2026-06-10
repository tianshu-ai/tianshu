// Headless agent loop, built on pi-agent-core's `runAgentLoop`.
//
// Why pi-agent-core: ADR follow-up — the workboard's LLM workers
// share the same agent runtime as the user-facing chat handler, so
// both call paths land on the same well-tested loop in
// @earendil-works/pi-agent-core. Tianshu's contribution is just
// the framing around it: a worker session, a `task_complete`
// terminal hook, three layered timeouts, and per-tenant tool/skill
// allow-lists.
//
// Lifecycle:
//   1. Resolve a model (per-call override > tenant default) + tool/
//      skill set, narrowed by the worker agent's allow-lists.
//   2. Open a `kind='worker'` session and persist the initial user
//      prompt.
//   3. Hand the prompt off to pi's `runAgentLoop()` with an `emit`
//      callback that:
//        - persists every assistant / toolResult message back to
//          the messages table as it lands;
//        - watches for a `task_complete` toolcall and captures its
//          summary/files so the worker can resolve `done`.
//   4. Wrap the whole thing in a watchdog that enforces three
//      timeouts (first-response / idle / max-run, same shape as
//      the legacy closed-source worker).
//   5. Archive the worker session and return a structured result.
//
// The watchdog approach: pi's loop has no built-in idle/first-event
// timeouts, but it accepts an AbortSignal that aborts mid-stream
// gracefully. We piggyback on emit() to track when the LLM is
// actually doing things — every emitted event resets the idle
// counter. A short setInterval polls and aborts when a deadline
// hits.

import { runAgentLoop as piRunAgentLoop } from "@earendil-works/pi-agent-core";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
} from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Message,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
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
  appendAgentMessage,
  archiveSession,
  createWorkerSession,
} from "./messages.js";
import { defaultSystemPrompt, loadHostSkills } from "./handler.js";
import type { PluginRegistry } from "../core/plugins/registry.js";
import { adaptToolset, isAdapterError } from "./agent-tool-adapter.js";

export interface AgentLoopRequest {
  ctx: TenantContext;
  /** Owner of the worker session. Tasks are owner-scoped, so this
   *  must match the task's owner_user_id. */
  userId: string;
  /** Initial user message. */
  initialUserMessage: string;
  /** Optional system-prompt override. Defaults to host default. */
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
  /** Plugin registry for tool/skill discovery. Required iff the
   *  caller wants any tools at all. */
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
/** pi's loop doesn't cap turns itself; we apply our own ceiling
 *  via shouldStopAfterTurn so a runaway model can't burn budget
 *  forever. */
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

  const session = createWorkerSession(ctx, {
    userId,
    workerRole: req.workerRole ?? null,
    parentSessionId: req.parentSessionId ?? null,
    title: req.sessionTitle ?? null,
  });

  // Resolve model.
  const modelInfo =
    (req.modelId ? findModel(ctx.config, req.modelId) : undefined) ??
    getDefaultModel(ctx.config);
  if (!modelInfo) {
    archiveSession(ctx, session.id);
    return {
      status: "error",
      summary: "no model configured",
      files: [],
      sessionId: session.id,
      turns: 0,
      reason: "exception",
    };
  }
  const piModel = buildModel(modelInfo);
  const apiKey = resolveApiKey(modelInfo);

  // Tools + skills.
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

  // Persist the initial user prompt.
  const initialPrompt: Message = {
    role: "user",
    content: [{ type: "text", text: initialUserMessage } as TextContent],
    timestamp: Date.now(),
  };
  appendAgentMessage(ctx, session, initialPrompt);

  // Watchdog state — every emitted event resets `lastEventAt`.
  const startedAt = Date.now();
  let lastEventAt = startedAt;
  let sawAnyEvent = false;
  let turns = 0;

  const completionSink: { summary?: string; files?: string[] } = {};
  let timedOutReason: AgentLoopResult["reason"] | null = null;

  const innerCtl = new AbortController();
  const onExternalAbort = () => innerCtl.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  // Watchdog tick is 100ms in tests-ish: a 1s interval is fine
  // for production runs but means a 1ms maxRunMs (used by tests)
  // would never fire. 100ms keeps timeouts honest without loading
  // the event loop in real use.
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

  const agentContext: AgentContext = {
    systemPrompt,
    messages: [],
    tools: adapted.tools,
  };
  const config: AgentLoopConfig = {
    model: piModel,
    apiKey,
    convertToLlm: (messages: AgentMessage[]) =>
      messages.filter(
        (m): m is Message =>
          m.role === "user" || m.role === "assistant" || m.role === "toolResult",
      ),
    shouldStopAfterTurn: ({ newMessages }) => {
      // Each completed turn = one assistant message + zero/more
      // toolResults. We count "turns" as the number of assistant
      // messages so far so MAX_TURNS matches the legacy semantics.
      const assistantCount = newMessages.filter(
        (m) => m.role === "assistant",
      ).length;
      turns = assistantCount;
      return assistantCount >= MAX_TURNS;
    },
    afterToolCall: async ({ toolCall, result }) => {
      // task_complete → capture summary/files. We read from the
      // raw plugin return (`details`) AND the toolcall arguments;
      // either is good enough.
      if (toolCall.name === TASK_COMPLETE_TOOL) {
        const args = toolCall.arguments as {
          summary?: unknown;
          files?: unknown;
        };
        if (typeof args.summary === "string")
          completionSink.summary = args.summary;
        if (Array.isArray(args.files)) {
          completionSink.files = args.files.filter(
            (x): x is string => typeof x === "string",
          );
        }
        // Tell the loop to wind up after this batch.
        return { terminate: true };
      }
      // For non-completion tools, propagate the plugin's `ok=false`
      // by flipping isError. The adapter stamps `__ok=false` on the
      // result when the plugin returned `{ ok:false, ... }`.
      if (isAdapterError(result.details)) {
        return { isError: true };
      }
      return undefined;
    },
  };

  // Subscribe-style sink: persist messages + reset watchdog.
  const emit = (event: AgentEvent): void => {
    lastEventAt = Date.now();
    sawAnyEvent = true;
    if (event.type === "message_end") {
      const msg = event.message;
      if (
        msg.role === "user" ||
        msg.role === "assistant" ||
        msg.role === "toolResult"
      ) {
        // The initial user prompt was already persisted above; skip
        // it on the way back in.
        if (
          msg.role === "user" &&
          (msg as Message).timestamp === initialPrompt.timestamp
        ) {
          return;
        }
        appendAgentMessage(ctx, session, msg as
          | AssistantMessage
          | ToolResultMessage
          | { role: "user" } & Message);
      }
    }
  };

  let result: AgentLoopResult;
  try {
    await piRunAgentLoop(
      [initialPrompt as AgentMessage],
      agentContext,
      config,
      emit,
      innerCtl.signal,
    );

    if (timedOutReason) {
      result = {
        status: "error",
        summary: timeoutMessage(timedOutReason, {
          firstResponseMs,
          idleMs,
          maxRunMs,
        }),
        files: [],
        sessionId: session.id,
        turns,
        reason: timedOutReason,
      };
    } else if (externalSignal?.aborted) {
      result = {
        status: "aborted",
        summary: "aborted by caller",
        files: [],
        sessionId: session.id,
        turns,
        reason: "aborted",
      };
    } else if (completionSink.summary !== undefined) {
      result = {
        status: "done",
        summary: completionSink.summary,
        files: completionSink.files ?? [],
        sessionId: session.id,
        turns,
        reason: "task_complete",
      };
    } else if (turns >= MAX_TURNS) {
      result = {
        status: "stalled",
        summary: `agent loop exceeded ${MAX_TURNS} turns without resolving`,
        files: [],
        sessionId: session.id,
        turns,
        reason: "max_turns",
      };
    } else {
      // pi's loop ended naturally (no tool calls) without
      // task_complete — the LLM walked off.
      const finalText = lastAssistantText(agentContext.messages);
      result = {
        status: "stalled",
        summary: finalText || "agent stopped without calling task_complete",
        files: [],
        sessionId: session.id,
        turns,
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
        sessionId: session.id,
        turns,
        reason: timedOutReason,
      };
    } else if (externalSignal?.aborted) {
      result = {
        status: "aborted",
        summary: "aborted by caller",
        files: [],
        sessionId: session.id,
        turns,
        reason: "aborted",
      };
    } else {
      result = {
        status: "error",
        summary: err instanceof Error ? err.message : String(err),
        files: [],
        sessionId: session.id,
        turns,
        reason: "exception",
      };
    }
  } finally {
    clearInterval(watchdog);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    archiveSession(ctx, session.id);
  }

  return result;
}

function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    for (const block of (m as AssistantMessage).content) {
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
