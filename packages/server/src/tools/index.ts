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
import type { AgentTool, AgentToolContext, PluginLogger } from "@tianshu/plugin-sdk";
import type { HostCapabilityHandle } from "../core/plugins/registry.js";
import type { LoadedSkill } from "../core/plugins/skills.js";

export type ToolResult = unknown;
export type ToolExecutor = (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

export interface Toolset {
  /** pi-ai Tool schemas to pass to streamSimple/agent loop. */
  schemas: Tool[];
  /** Map of tool name → executor. */
  executors: Record<string, ToolExecutor>;
}

export interface BuildToolsetOpts {
  /** Plugin tools collected from `pluginRegistry.toolsForTenant`. */
  pluginTools: Array<{ pluginId: string; tool: AgentTool }>;
  /** Context passed to each plugin tool's `available()` and
   *  `execute()`. Required iff `pluginTools` is non-empty. */
  toolContext: BuildToolContext;
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
   * Workboard task id this toolset is bound to. Forwarded into
   * every tool's `AgentToolContext.taskId` so per-task tools
   * (microsandbox `exec`) can scope resources to the task
   * lifecycle. Absent for chat sessions.
   */
  taskId?: string;
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

  for (const { pluginId, tool } of pluginTools) {
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
      taskId: toolContext.taskId,
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
    executors[name] = (args) => tool.execute(args, ctx);
  }

  return { schemas, executors };
}
