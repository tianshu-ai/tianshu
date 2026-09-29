// Setup agent tools — shared between the CLI wizard (cli-agent.ts) and
// the in-browser setup agent (maintenance tenant in handler.ts).
//
// Wraps cli-agent's buildTools into the plugin-sdk AgentTool shape so
// the chat handler can inject them alongside (or instead of) normal
// plugin tools. The file-based execution path (serverUrl=undefined)
// is used because the setup agent runs inside the server process.

import { buildTools, SETUP_SYSTEM_PROMPT } from "./cli-agent.js";
import { getTianshuHome } from "../core/paths.js";
import type { Tool } from "@earendil-works/pi-ai";

export { SETUP_SYSTEM_PROMPT };

/**
 * Minimal AgentTool shape — structurally compatible with
 * `@tianshu-ai/plugin-sdk`'s AgentTool without importing the
 * package (avoids a circular dep from setup/ → plugin-sdk).
 */
export interface SetupAgentTool {
  schema: Tool;
  execute: (
    args: Record<string, unknown>,
    ctx?: unknown,
  ) => Promise<{ ok: boolean; text: string }>;
}

/**
 * Build the setup agent's tool set for use inside the running server.
 *
 * Uses cli-agent's buildTools with `serverUrl=undefined` so every tool
 * goes through the file-based path (no HTTP self-call needed — we're
 * already inside the process). Sandbox-related tools that require a
 * running HTTP endpoint will return helpful "server_not_running" errors;
 * the setup agent can surface these and suggest the CLI path instead.
 *
 * @param home - TIANSHU_HOME directory (defaults to `getTianshuHome()`)
 */
export function buildSetupAgentTools(
  home: string = getTianshuHome(),
): SetupAgentTool[] {
  const handlers = buildTools(home, undefined);
  return Object.values(handlers).map((handler) => ({
    schema: handler.schema,
    async execute(args: Record<string, unknown>) {
      const text = await handler.execute(args);
      return { ok: true, text };
    },
  }));
}
