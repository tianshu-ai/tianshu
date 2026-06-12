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
  /** Skills available this turn (after `when:` filtering). The
   *  assembler registers a meta-tool `load_skill(name)` whose
   *  description lists every skill's name + description; the agent
   *  pulls bodies into context on demand. Empty array → no
   *  meta-tool registered (saves the model from seeing a tool that
   *  does nothing useful). */
  skills: LoadedSkill[];
  /** Context passed to each plugin tool's `available()` and
   *  `execute()`. Required iff `pluginTools` is non-empty. */
  toolContext: BuildToolContext;
}

/** Subset of `AgentToolContext` the host always knows. The handler
 *  fills in `pluginId` per tool when it invokes one. */
export interface BuildToolContext {
  tenantId: string;
  userId: string;
  capabilities: HostCapabilityHandle;
  userHomeDir: string;
  tenantHomeDir: string;
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
}

/**
 * Build a per-request toolset. Plugin tools are registered iff
 * their `available()` hook (default: true) returns truthy.
 */
export async function buildToolset(opts: BuildToolsetOpts): Promise<Toolset> {
  const { pluginTools, toolContext } = opts;

  const schemas: Tool[] = [];
  const executors: Record<string, ToolExecutor> = {};

  // ADR-0004 §11: skill meta-tool. Registered first so the agent
  // sees it ahead of plugin tools when the model lists the toolset.
  if (opts.skills.length > 0) {
    const byName = new Map(opts.skills.map((s) => [s.name, s] as const));
    const skillList = opts.skills
      .map((s) => `  - ${s.name}: ${s.description}`)
      .join("\n");
    schemas.push({
      name: "load_skill",
      description:
        `Load a skill (a markdown how-to) into your context on demand. ` +
        `Skills explain how to use specific tool combinations, the workspace ` +
        `layout, etc. Read one when you're about to do something that the ` +
        `description matches; you can load several. The body is appended to ` +
        `the tool result and remains in context for this turn.\n\n` +
        `Available skills:\n${skillList}`,
      parameters: Type.Object({
        name: Type.String({
          description:
            "The skill name. Must be one of the names listed in this tool's description.",
        }),
      }),
    });
    executors.load_skill = (args) => {
      const name = String((args as { name?: unknown }).name ?? "");
      const skill = byName.get(name);
      if (!skill) {
        return {
          ok: false,
          text: `unknown skill: "${name}". Available: ${[...byName.keys()].join(", ") || "(none)"}`,
        };
      }
      return {
        ok: true,
        text: `# ${skill.name}\n\n${skill.description}\n\n${skill.body}`,
      };
    };
  }

  for (const { pluginId, tool } of pluginTools) {
    const ctx: AgentToolContext = {
      pluginId,
      tenantId: toolContext.tenantId,
      userId: toolContext.userId,
      capabilities: toolContext.capabilities,
      userHomeDir: toolContext.userHomeDir,
      tenantHomeDir: toolContext.tenantHomeDir,
      log: toolContext.log,
      sessionId: toolContext.sessionId,
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
