// Headless agent loop — same core machinery as the websocket chat
// handler (chat/handler.ts → runPrompt) but without a socket. Used
// by the workboard plugin's LLMWorker to drive a worker session
// from a task description.
//
// What it does, in order:
//   1. Resolve a model (per-call override > tenant default).
//   2. Build a Toolset from the registry, then optionally narrow
//      it to a per-agent allow-list (echo agents have no tools;
//      LLM agents typically allow a small named subset).
//   3. Persist the initial user prompt, then run the
//      streamSimple → toolcall loop with three layered timeouts:
//        - first-response: hard cap on the very first stream event
//        - idle:           hard cap on time-since-last-event mid-run
//        - max-run:        hard cap on total wall clock for the
//                          whole loop
//   4. After each turn, look for a `task_complete` toolcall — if
//      present, capture its arguments as the terminal result.
//   5. Return a structured `AgentLoopResult`. Status is `done`
//      when task_complete fired, `stalled` when MAX_TURNS hit
//      without it, and `error` for any of the timeouts /
//      exceptions.
//
// This module deliberately does not write to the workboard's
// `tasks` table itself — that's the LLMWorker's job. Keeping the
// loop ignorant of \"task\" semantics means a future non-workboard
// caller (a CLI agent, a cron-triggered scheduled prompt) can use
// it without dragging the kanban schema in.

import { streamSimple } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  ToolCall,
  ToolResultMessage,
  TextContent,
} from "@earendil-works/pi-ai";
import type { TenantContext } from "../core/index.js";
import {
  buildModel,
  findModel,
  getDefaultModel,
  resolveApiKey,
} from "../core/index.js";
import { buildToolset, type Toolset } from "../tools/index.js";
import {
  filterSkillsForTenant,
  type LoadedSkill,
} from "../core/plugins/skills.js";
import {
  appendAgentMessage,
  archiveSession,
  createWorkerSession,
  loadAgentHistoryForSession,
} from "./messages.js";
import {
  defaultSystemPrompt,
  loadHostSkills,
  normaliseToolResult,
  prepareMessagesForLlm,
  runOneTool,
} from "./handler.js";
import type { PluginRegistry } from "../core/plugins/registry.js";

const MAX_TURNS = 16;

export interface AgentLoopRequest {
  ctx: TenantContext;
  /** Owner of the worker session. Tasks are owner-scoped, so this
   *  must match the task's owner_user_id. */
  userId: string;
  /** Initial user message. The headline + a Description block work
   *  fine; any well-formed prompt does. */
  initialUserMessage: string;
  /** Optional system-prompt override. When unset, the host's
   *  default system prompt is used. */
  systemPrompt?: string;
  /** Optional model override (model id from tenant config). */
  modelId?: string;
  /** Allow-list of tool names. When set, only tools in the list are
   *  exposed to the LLM. `null` / undefined = all available. */
  toolsAllow?: string[] | null;
  /** Allow-list of skill names. When set, only listed skills are
   *  exposed via the load_skill meta-tool. `null` / undefined =
   *  all available (post-`when:` filter). */
  skillsAllow?: string[] | null;
  /** Friendly title for the worker session (shows in admin UI). */
  sessionTitle?: string | null;
  /** Worker role to stamp on the session row (`worker_role`
   *  column). Use the kind id (e.g. `\"llm\"`) when called from a
   *  worker pool. */
  workerRole?: string | null;
  /** Parent session id (the user's main session that requested
   *  the worker). Lets the UI render worker sessions as children. */
  parentSessionId?: string | null;
  /** Plugin registry for tool/skill discovery. Required iff the
   *  caller wants any tools at all; pass undefined for a pure-LLM
   *  loop with zero tools. */
  pluginRegistry?: PluginRegistry;
  /** Tenant root dir on the host \u2014 fed into AgentToolContext. */
  homeDir?: string;
  /** Soft per-call timeout caps. All defaults match the legacy
   *  closed-source worker. Set any value to 0 to disable that
   *  layer. */
  timeouts?: {
    firstResponseMs?: number;
    idleMs?: number;
    maxRunMs?: number;
  };
  /** External abort signal. When fired, the loop returns with
   *  status=\"aborted\" on the next turn boundary. */
  signal?: AbortSignal;
}

export interface AgentLoopResult {
  status: "done" | "stalled" | "aborted" | "error";
  /** One-line human-readable summary. For `done`, this is the
   *  `summary` argument the LLM passed to `task_complete`; for
   *  failures, it's a short reason string. */
  summary: string;
  /** Output paths the LLM declared via `task_complete.files[]`.
   *  Empty for non-`done` outcomes. */
  files: string[];
  /** Worker session id created for this loop. Persisted even on
   *  failure so the human can inspect the transcript. */
  sessionId: string;
  /** Number of turns the loop actually executed before stopping. */
  turns: number;
  /** Internal reason code, useful for tests and logs. */
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

/** Sentinel tool name the loop watches for. The workboard plugin
 *  contributes the actual tool that emits this name. */
const TASK_COMPLETE_TOOL = "task_complete";

const DEFAULT_FIRST_RESPONSE_MS = 300_000;
const DEFAULT_IDLE_MS = 600_000;
const DEFAULT_MAX_RUN_MS = 1_800_000;

/**
 * Run an agent loop to completion. Creates a `kind=\"worker\"`
 * session, persists every turn into it, returns a terminal result.
 *
 * Throws only on programmer error (missing model config). All
 * runtime failures land in the `AgentLoopResult.status` enum.
 */
export async function runAgentLoop(
  req: AgentLoopRequest,
): Promise<AgentLoopResult> {
  const {
    ctx,
    userId,
    initialUserMessage,
    pluginRegistry,
    homeDir,
    signal,
  } = req;

  const session = createWorkerSession(ctx, {
    userId,
    workerRole: req.workerRole ?? null,
    parentSessionId: req.parentSessionId ?? null,
    title: req.sessionTitle ?? null,
  });

  // Resolve model. Per-call override wins, then tenant default.
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

  // Toolset with optional allow-list filter. We narrow plugin tools
  // BEFORE running buildToolset so available()-gated tools that
  // were filtered out aren't probed at all.
  const allPluginTools =
    pluginRegistry?.toolsForTenant(ctx.tenantId) ?? [];
  const allowSet = req.toolsAllow ? new Set(req.toolsAllow) : null;
  const pluginTools = allowSet
    ? allPluginTools.filter(({ tool }) => allowSet.has(tool.schema.name))
    : allPluginTools;

  const allSkills: LoadedSkill[] = [
    ...loadHostSkills(),
    ...(pluginRegistry?.skillsForTenant(ctx.tenantId) ?? []),
  ];
  const declaredToolNames = new Set(pluginTools.map(({ tool }) => tool.schema.name));
  const hostCaps = pluginRegistry?.hostCapabilities(ctx.tenantId) ?? {
    get: () => undefined,
    has: () => false,
  };
  const skillsAllowed = req.skillsAllow
    ? new Set(req.skillsAllow)
    : null;
  const skills = filterSkillsForTenant(allSkills, {
    hasTool: (n) => declaredToolNames.has(n),
    hasCapability: (n) => hostCaps.has(n as never),
  }).filter((s) => !skillsAllowed || skillsAllowed.has(s.name));

  const userHomeDir = ctx.userHomeDir(userId);
  const toolset = await buildToolset({
    pluginTools,
    skills,
    toolContext: {
      tenantId: ctx.tenantId,
      userId,
      capabilities: hostCaps,
      userHomeDir,
      tenantHomeDir: homeDir ?? "",
      log: {
        info: (msg, meta) => console.log(`[agent-loop] ${msg}`, meta ?? ""),
        warn: (msg, meta) => console.warn(`[agent-loop] ${msg}`, meta ?? ""),
        error: (msg, meta) => console.error(`[agent-loop] ${msg}`, meta ?? ""),
      },
    },
  });

  // Persist initial user prompt so the loop sees it on hydration.
  appendAgentMessage(ctx, session, {
    role: "user",
    content: [{ type: "text", text: initialUserMessage } as TextContent],
    timestamp: Date.now(),
  });

  const systemPrompt = req.systemPrompt ?? defaultSystemPrompt(ctx, userId);
  const firstResponseMs =
    req.timeouts?.firstResponseMs ?? DEFAULT_FIRST_RESPONSE_MS;
  const idleMs = req.timeouts?.idleMs ?? DEFAULT_IDLE_MS;
  const maxRunMs = req.timeouts?.maxRunMs ?? DEFAULT_MAX_RUN_MS;

  const startedAt = Date.now();
  let turns = 0;

  // Hydrate (just the system + user we already wrote, in steady
  // state we'd reload after every turn; pi-ai's Message format is
  // re-derived from disk each time).
  const { messages } = loadAgentHistoryForSession(ctx, session.id, {
    api: modelInfo.api,
    provider: modelInfo.providerId,
    model: modelInfo.modelId,
  });

  let terminal: AgentLoopResult | null = null;
  // task_complete extracts these via a side-channel on the
  // toolset.executors map (see LLMWorker contribution). The agent
  // loop reads them right after each toolcall round.
  const completionSink: { summary?: string; files?: string[] } = {};

  // Wrap every executor so we can intercept task_complete without
  // baking knowledge of it into the host. The plugin contributes
  // the tool; we just notice when it returns the magic shape.
  const wrappedExecutors: typeof toolset.executors = { ...toolset.executors };
  if (wrappedExecutors[TASK_COMPLETE_TOOL]) {
    const inner = wrappedExecutors[TASK_COMPLETE_TOOL]!;
    wrappedExecutors[TASK_COMPLETE_TOOL] = async (args) => {
      const out = await inner(args);
      const norm = normaliseToolResult(out);
      // The plugin's task_complete returns
      //   { ok, text, summary, files }
      // — capture the structured fields if present.
      if (out && typeof out === "object") {
        const r = out as Record<string, unknown>;
        if (typeof r.summary === "string") completionSink.summary = r.summary;
        if (Array.isArray(r.files)) {
          completionSink.files = r.files.filter(
            (x): x is string => typeof x === "string",
          );
        }
      }
      if (!completionSink.summary && typeof args === "object" && args) {
        const a = args as Record<string, unknown>;
        if (typeof a.summary === "string") completionSink.summary = a.summary;
        if (Array.isArray(a.files)) {
          completionSink.files = a.files.filter(
            (x): x is string => typeof x === "string",
          );
        }
      }
      return norm;
    };
  }
  const wrappedToolset: Toolset = {
    schemas: toolset.schemas,
    executors: wrappedExecutors,
  };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (signal?.aborted) {
      terminal = {
        status: "aborted",
        summary: "aborted by caller",
        files: [],
        sessionId: session.id,
        turns,
        reason: "aborted",
      };
      break;
    }

    const elapsed = Date.now() - startedAt;
    if (maxRunMs > 0 && elapsed >= maxRunMs) {
      terminal = {
        status: "error",
        summary: `worker exceeded max-run budget (${Math.round(maxRunMs / 1000)}s)`,
        files: [],
        sessionId: session.id,
        turns,
        reason: "max_run_timeout",
      };
      break;
    }

    const piContext: Context = {
      systemPrompt,
      messages: await prepareMessagesForLlm(messages, userHomeDir, modelInfo),
      tools: wrappedToolset.schemas,
    };

    let final: AssistantMessage | null;
    try {
      final = await consumeStreamWithGuards(
        streamSimple(piModel, piContext, { signal, apiKey }),
        {
          firstResponseMs: turn === 0 ? firstResponseMs : 0,
          idleMs,
          remainingMs:
            maxRunMs > 0 ? Math.max(1, maxRunMs - elapsed) : 0,
        },
      );
    } catch (err) {
      const reason = guardErrorReason(err);
      terminal = {
        status: "error",
        summary: errMessage(err),
        files: [],
        sessionId: session.id,
        turns,
        reason,
      };
      break;
    }
    turns = turn + 1;
    if (!final) {
      terminal = {
        status: "error",
        summary: "stream ended with no message",
        files: [],
        sessionId: session.id,
        turns,
        reason: "stream_error",
      };
      break;
    }

    appendAgentMessage(ctx, session, final);
    messages.push(final);

    if (final.stopReason !== "toolUse") {
      // No tools left to call; loop is done. If the LLM never
      // called task_complete we treat that as stalled \u2014 the worker
      // chose to babble instead of completing.
      terminal = completionSink.summary
        ? {
            status: "done",
            summary: completionSink.summary,
            files: completionSink.files ?? [],
            sessionId: session.id,
            turns,
            reason: "task_complete",
          }
        : {
            status: "stalled",
            summary:
              extractFinalText(final) ||
              "agent stopped without calling task_complete",
            files: [],
            sessionId: session.id,
            turns,
            reason: "max_turns",
          };
      break;
    }

    const toolCalls = final.content.filter(
      (c): c is ToolCall => c.type === "toolCall",
    );
    if (toolCalls.length === 0) {
      terminal = {
        status: "stalled",
        summary: "agent claimed toolUse but emitted no calls",
        files: [],
        sessionId: session.id,
        turns,
        reason: "max_turns",
      };
      break;
    }

    for (const call of toolCalls) {
      const result = await runOneTool(wrappedToolset, call);
      const toolResult: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: result.text } as TextContent],
        isError: !result.ok,
        timestamp: Date.now(),
      };
      appendAgentMessage(ctx, session, toolResult);
      messages.push(toolResult);
    }

    if (completionSink.summary !== undefined) {
      terminal = {
        status: "done",
        summary: completionSink.summary,
        files: completionSink.files ?? [],
        sessionId: session.id,
        turns,
        reason: "task_complete",
      };
      break;
    }
  }

  if (!terminal) {
    terminal = {
      status: "stalled",
      summary: `agent loop exceeded ${MAX_TURNS} turns without resolving`,
      files: [],
      sessionId: session.id,
      turns,
      reason: "max_turns",
    };
  }

  archiveSession(ctx, session.id);
  return terminal;
}

class GuardError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "first_response_timeout"
      | "idle_timeout"
      | "max_run_timeout",
  ) {
    super(message);
  }
}

class StreamError extends Error {}

function guardErrorReason(err: unknown): AgentLoopResult["reason"] {
  if (err instanceof GuardError) return err.reason;
  if (err instanceof StreamError) return "stream_error";
  return "exception";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Drain a streamSimple iterator while enforcing three timeouts.
 * The host's chat-handler version forwards events to a socket; we
 * just collect the final assistant message.
 *
 * `firstResponseMs=0` disables the first-event watchdog (useful
 * for follow-up turns where the LLM has clearly already proven
 * it can talk to us).
 */
async function consumeStreamWithGuards(
  stream: AsyncIterable<AssistantMessageEvent>,
  guards: { firstResponseMs: number; idleMs: number; remainingMs: number },
): Promise<AssistantMessage | null> {
  let final: AssistantMessage | null = null;
  let lastEventAt = Date.now();
  let sawFirstEvent = false;

  let watchdog: NodeJS.Timeout | null = null;
  const failed = new Promise<never>((_, reject) => {
    watchdog = setInterval(() => {
      const now = Date.now();
      if (
        !sawFirstEvent &&
        guards.firstResponseMs > 0 &&
        now - lastEventAt >= guards.firstResponseMs
      ) {
        reject(
          new GuardError(
            `LLM did not respond within ${Math.round(guards.firstResponseMs / 1000)}s`,
            "first_response_timeout",
          ),
        );
        return;
      }
      if (guards.idleMs > 0 && now - lastEventAt >= guards.idleMs) {
        reject(
          new GuardError(
            `no stream events for ${Math.round(guards.idleMs / 1000)}s`,
            "idle_timeout",
          ),
        );
      }
    }, 1_000);
  });
  failed.catch(() => {
    // failure path handled by Promise.race below; this catch
    // exists only to suppress the "unhandled rejection" warning
    // when the stream finishes normally before the watchdog fires.
  });

  try {
    const drained = (async () => {
      for await (const event of stream) {
        lastEventAt = Date.now();
        sawFirstEvent = true;
        if (event.type === "done") {
          final = event.message;
        } else if (event.type === "error") {
          throw new StreamError(
            event.error?.errorMessage ?? "stream_error",
          );
        }
      }
      return final;
    })();
    return await Promise.race([drained, failed]);
  } finally {
    if (watchdog) clearInterval(watchdog);
  }
}

function extractFinalText(msg: AssistantMessage): string {
  for (const block of msg.content) {
    if (block.type === "text" && typeof block.text === "string") {
      return block.text.trim();
    }
  }
  return "";
}
