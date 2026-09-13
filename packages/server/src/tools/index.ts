// Agent toolset assembler.
//
// All agent tools live in plugins now (ADR-0004 N+3): file ops in
// the `files` plugin, sandbox ops in the `microsandbox` plugin,
// future plugins (web search, knowledge base, …) in their own
// plugins. The host's role here is to:
//
//   - collect every active plugin's tools from the registry
//   - run each tool's `available()` gate (tools may be hidden when
//     a backing capability is unhealthy)
//   - assemble pi-ai schemas + name → executor map for the chat
//     handler
//
// If no plugin contributes tools (e.g. fresh install with the
// `files` plugin disabled and no microsandbox), the agent simply
// gets an empty toolset \u2014 it can still answer questions, just
// can't touch files or run commands.

import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentTool, AgentToolContext, PluginLogger } from "@tianshu-ai/plugin-sdk";
import type { HostCapabilityHandle } from "../core/plugins/registry.js";
import type { LoadedSkill } from "../core/plugins/skills.js";

export type ToolResult = unknown;
export type ToolExecutor = (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

/**
 * Wrap a raw tool executor with a safety net that:
 *   1. Honors an aborted signal before invoking the tool.
 *   2. Catches any throw / promise rejection from the tool body
 *      — including from inner async code paths the caller might
 *      have overlooked — and rethrows a normalized error message
 *      that reads as "tool X failed: <cause>. You may retry with
 *      different arguments or take an alternative approach."
 *
 * Why not just let pi handle it? pi-agent-core's executePreparedToolCall
 * already catches sync/async throws and turns them into a
 * `{ result: ErrorToolResult, isError: true }` for the agent — but
 * the resulting `tool_result` content is just the bare Error.message,
 * which for cases like bridge exec / network SSH failures reads as
 * something opaque like "ECONNRESET" or "aborted" and the agent
 * doesn't always realize the sensible next move is "try again" or
 * "tell the user what failed".
 *
 * This wrapper does NOT swallow the error — it re-throws. pi still
 * takes the standard path (isError=true tool_result gets sent back
 * to the model). We only enrich the message so the model has
 * enough context to decide what to do next instead of stalling.
 */
function wrapExecutorWithErrorGuard(
  toolName: string,
  origin: string,
  toolContext: { signal?: AbortSignal; log: PluginLogger },
  raw: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult,
): ToolExecutor {
  return async (args) => {
    if (toolContext.signal?.aborted) {
      throw new Error("aborted by user");
    }
    try {
      // Await here (rather than returning the Promise directly) so
      // async rejections land in our catch block, not on the caller.
      return await raw(args);
    } catch (err) {
      const causeMessage = err instanceof Error ? err.message : String(err);
      const causeStack = err instanceof Error && err.stack ? err.stack : undefined;
      // Detailed context in the server log — the agent doesn't need
      // stack traces, but a human debugging bridge/tool crashes does.
      toolContext.log.warn(
        `[tool-guard] ${origin}:${toolName} threw: ${causeMessage}${
          causeStack ? `\n${causeStack.split("\n").slice(0, 6).join("\n")}` : ""
        }`,
      );
      // Rethrow with an agent-actionable message. pi's tool-loop
      // catches this and returns it as isError=true tool_result,
      // so the model sees this text as its next input.
      const guidance = deriveRecoveryHint(toolName, causeMessage);
      throw new Error(
        `${toolName} failed: ${causeMessage}. ${guidance}`,
      );
    }
  };
}

/**
 * Best-effort tool-specific guidance strings that tell the agent
 * what a plausible recovery move looks like. Keeps the message
 * short (<200 chars) so it doesn't dominate the tool_result.
 */
function deriveRecoveryHint(toolName: string, causeMessage: string): string {
  const lower = causeMessage.toLowerCase();
  // Bridge exec / SSH / remote tools — usually transient network
  // or process-crash failures.
  if (/^bridge_.*_exec$|bridge_.*_shell$/i.test(toolName)) {
    if (/econnrefused|econnreset|etimedout|network|socket|hang up|closed/i.test(lower)) {
      return "The bridge connection may have dropped. You may retry the command once; if it still fails, tell the user the bridge is unreachable and stop retrying.";
    }
    if (/exit(ed)? .*(1|127|130|137)|non-zero exit|failed with code/i.test(lower)) {
      return "The command completed but exited non-zero. Read the output above (if any) to decide whether to fix the arguments, run a different command, or report the failure to the user.";
    }
    return "Retry once with the same or corrected arguments; if it fails a second time, describe the failure to the user rather than looping.";
  }
  if (/aborted by user/i.test(lower)) {
    return "The user cancelled this turn. Stop working and wait for the next user message.";
  }
  // Generic default — don't over-promise a fix.
  return "You may retry with different arguments or take an alternative approach; do not repeat the exact same call more than twice in a row.";
}

export interface Toolset {
  /** pi-ai Tool schemas to pass to streamSimple/agent loop. */
  schemas: Tool[];
  /** Map of tool name → executor. */
  executors: Record<string, ToolExecutor>;
}

export interface BuildToolsetOpts {
  /** Plugin tools collected from `pluginRegistry.toolsForTenant`. */
  pluginTools: Array<{ pluginId: string; tool: AgentTool; access?: "member" | "admin" }>;
  /** Context passed to each plugin tool's `available()` and
   *  `execute()`. Required iff `pluginTools` is non-empty. */
  toolContext: BuildToolContext;
  /**
   * Host-level tools injected by the caller (handler / agent-loop).
   * Always available regardless of plugins. Used for fundamental
   * capabilities like context compaction.
   */
  hostTools?: Array<{ schema: Tool; executor: ToolExecutor }>;
  /**
   * Deprecated. Used to feed a `read_skill` meta-tool; the
   * registry now mirrors host / plugin SKILL.md into the tenant
   * config tree so `tenant_config_read` reaches every skill
   * source via its <available_skills> URI. Kept on the type one
   * release for back-compat with old callers.
   *
   * @deprecated
   */
  skills?: readonly LoadedSkill[];
}

/** Subset of `AgentToolContext` the host always knows. The handler
 *  fills in `pluginId` per tool when it invokes one. */
export interface BuildToolContext {
  tenantId: string;
  userId: string;
  capabilities: HostCapabilityHandle;
  userHomeDir: string;
  tenantHomeDir: string;
  /** See `AgentToolContext.agentScope`. Defaults to `{kind:"main"}`
   *  inside `buildToolset` if the caller doesn't pass it. */
  agentScope?:
    | { kind: "main" }
    | { kind: "worker"; workerKind: string; slug?: string };
  log: PluginLogger;
  /** Role of the user in the current tenant. Used to enforce
   *  tool-level access control (manifest tools[].access). */
  userRole?: "admin" | "member";
  /**
   * Session this toolset belongs to. Plumbed through to every
   * tool's `AgentToolContext.sessionId` so plugins can attribute
   * side-effects (e.g. workboard's task_create stamping
   * `tasks.parent_session_id`) back to the asking session.
   *
   * Optional: tools instantiated outside any chat / worker
   * context (e.g. unit tests) may skip it.
   */
  sessionId?: string;
  /**
   * Channel-session tagging (wechat / telegram / ...) when this
   * toolset is built for a session bound to a chat platform. Used
   * by channel-aware tools' `available()` to hide themselves on
   * webchat sessions. Absent for plain webchat / no-session
   * invocations — see `AgentToolContext.channelSession` for the
   * full doc.
   */
  channelSession?: AgentToolContext["channelSession"];
  /**
   * Workboard task id this toolset is bound to. Forwarded into
   * every tool's `AgentToolContext.taskId` so per-task tools
   * (microsandbox `exec`) can scope resources to the task
   * lifecycle. Absent for chat sessions.
   */
  taskId?: string;
  /**
   * Project slug the task belongs to. Forwarded to
   * `AgentToolContext.projectSlug` so plugins that stage files
   * on disk (openshell `sync_down`) default to the project's
   * result subtree.
   */
  projectSlug?: string;
  /**
   * Task title at run start. Forwarded to
   * `AgentToolContext.taskTitle`. User-supplied text — plugins
   * must slugify before using it in filesystem paths.
   */
  taskTitle?: string;
  /**
   * Cancellation signal piped from the agent loop's inner abort
   * controller. Forwarded into every tool's
   * `AgentToolContext.signal` so long-running tools can bail
   * early on watchdog timeout / external `task_abort`. Optional
   * because unit tests instantiating a toolset don't need it.
   */
  signal?: AbortSignal;
}

/**
 * Build a per-request toolset. Plugin tools are registered iff
 * their `available()` hook (default: true) returns truthy.
 */
export async function buildToolset(opts: BuildToolsetOpts): Promise<Toolset> {
  const { pluginTools, toolContext } = opts;

  const schemas: Tool[] = [];
  const executors: Record<string, ToolExecutor> = {};

  // No skill meta-tool. The registry mirrors host / plugin
  // SKILL.md into `<tenant>/_tenant/config/skills/_host/<pid>/
  // <id>/SKILL.md` at activation time, so the agent reads any
  // skill (tenant-authored, plugin-shipped, or host-shipped)
  // via `tenant_config_read` against the URI advertised in
  // `<available_skills>`. One tool, one path shape, no
  // special case. `opts.skills` is kept on the type one
  // release for back-compat but is intentionally ignored here.
  void opts.skills;

  const agentScope = toolContext.agentScope ?? { kind: "main" as const };

  for (const { pluginId, tool, access: toolAccess } of pluginTools) {
    const ctx: AgentToolContext = {
      pluginId,
      tenantId: toolContext.tenantId,
      userId: toolContext.userId,
      capabilities: toolContext.capabilities,
      userHomeDir: toolContext.userHomeDir,
      tenantHomeDir: toolContext.tenantHomeDir,
      agentScope,
      log: toolContext.log,
      sessionId: toolContext.sessionId,
      channelSession: toolContext.channelSession,
      taskId: toolContext.taskId,
      projectSlug: toolContext.projectSlug,
      taskTitle: toolContext.taskTitle,
      signal: toolContext.signal,
    };
    let available = true;
    if (tool.available) {
      try {
        available = (await tool.available(ctx)) === true;
      } catch (err) {
        toolContext.log.warn(
          `[plugin:${pluginId}] tool "${tool.schema.name}" available() threw \u2014 hiding tool: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        available = false;
      }
    }
    if (!available) continue;

    const name = tool.schema.name;
    if (executors[name]) {
      toolContext.log.warn(
        `[plugin:${pluginId}] tool "${name}" collides with an existing tool name; skipping`,
      );
      continue;
    }
    schemas.push(tool.schema);
    // Skip admin-only tools for member users — don't even expose to LLM
    const effectiveAccess = toolAccess ?? "member";
    if (effectiveAccess === "admin" && toolContext.userRole === "member") continue;

    executors[name] = wrapExecutorWithErrorGuard(
      name,
      pluginId,
      toolContext,
      (args) => tool.execute(args, ctx),
    );
  }

  // Host-level tools (always available, not from plugins).
  for (const { schema, executor } of opts.hostTools ?? []) {
    if (!executors[schema.name]) {
      schemas.push(schema);
      executors[schema.name] = wrapExecutorWithErrorGuard(
        schema.name,
        "host",
        toolContext,
        (args) => executor(args),
      );
    }
  }

  return { schemas, executors };
}
