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
   * Skills the agent can see this turn. When non-empty, we expose
   * a `read_skill(name)` meta-tool that returns the skill body
   * verbatim. Without this, the agent would have to guess which
   * tool to use for which skill family (host skills aren't in any
   * plugin's read scope; plugin skills aren't either; tenant
   * skills are reachable via tenant_config_read but the agent
   * has to construct the path correctly). One tool, one
   * argument, one return shape — same UX no matter where the
   * skill lives.
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
}

/**
 * Build a per-request toolset. Plugin tools are registered iff
 * their `available()` hook (default: true) returns truthy.
 */
export async function buildToolset(opts: BuildToolsetOpts): Promise<Toolset> {
  const { pluginTools, toolContext } = opts;

  const schemas: Tool[] = [];
  const executors: Record<string, ToolExecutor> = {};

  // ─── read_skill meta-tool ──────────────────────────────────
  //
  // Backstory: we used to expose `load_skill(name)` and removed
  // it in favour of "read the SKILL.md file directly". That
  // works for tenant skills (the chat agent reads them via
  // tenant_config_read with a `tenant-config:///` URI). It does
  // NOT work for plugin / host skills — they live outside the
  // tenant config tree, so neither read_file nor tenant_config_read
  // can fetch them, and a worker that tries
  // `read_file('/Users/.../builtinConfig/.../SKILL.md')` gets a
  // 404. Bring back a small meta-tool keyed by skill name; it's
  // the simplest stable surface across all three skill sources.
  if (opts.skills && opts.skills.length > 0) {
    const byName = new Map<string, LoadedSkill>();
    for (const s of opts.skills) {
      // Last-writer-wins on collisions — the same merge order
      // the system prompt's <available_skills> block uses.
      byName.set(s.name, s);
    }
    schemas.push({
      name: "read_skill",
      description:
        "Load a skill's SKILL.md body into your context by its `name` (the value in <available_skills>'s <name> tag). Use this for any skill source — host, plugin, or tenant. The body comes back verbatim, including frontmatter. Use sparingly; one skill up front is the right cadence.",
      parameters: Type.Object({
        name: Type.String({
          description: "Skill name as listed in <available_skills>.",
        }),
      }),
    });
    executors.read_skill = (args) => {
      const name = String((args as { name?: unknown }).name ?? "").trim();
      if (!name) return { ok: false, text: "name is required" };
      const skill = byName.get(name);
      if (!skill) {
        return {
          ok: false,
          text: `unknown skill: "${name}". Available: ${[...byName.keys()].sort().join(", ") || "(none)"}`,
        };
      }
      return {
        ok: true,
        text: `# ${skill.name}\n\n${skill.description}\n\n${skill.body}`,
      };
    };
  }

  // Skills are now discovered via the per-tenant filesystem layer
  // (`<tenant>/_tenant/config/...`) and announced in the system
  // prompt's <available_skills> block. The agent reads them via
  // the files plugin's `tenant_config_*` tools — plus the
  // `read_skill` meta-tool above for any-source loading. There is no
  // host meta-tool for skill loading anymore.

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
