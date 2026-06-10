// Adapter: tianshu plugin `AgentTool` (sdk shape) → pi-agent-core `AgentTool`.
//
// Why this exists:
//   * Plugin authors keep using the simpler tianshu shape:
//       execute(args, ctx) → { ok, text, ... }
//     which we don't want to break or re-architect across every
//     plugin in this repo (files, microsandbox, workboard).
//   * The agent loop uses pi-agent-core, whose tool contract is
//     richer:
//       execute(toolCallId, params, signal, onUpdate) → AgentToolResult
//   * The adapter wraps each plugin tool into the pi shape: it
//     forwards args, normalises return shapes via the same
//     `normaliseToolResult` the chat handler already uses, and
//     translates `ok=false` returns into AgentToolResult `isError`.
//
// One subtlety worth flagging: pi's contract says `execute()` should
// THROW on failure rather than encode errors in the content array.
// Our plugin tools, by long-standing convention, return
// `{ ok: false, text: "..." }` instead of throwing. The adapter
// converts that pattern into an AgentToolResult with the same text
// content but does NOT throw — pi's `runAgentLoop` already supports
// "soft failures" via the ToolResultMessage's `isError` flag, but
// tianshu plugins want them to be visible to the LLM verbatim.
// Tracked in workers.md §7.2.

import type {
  AgentTool as PiAgentTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { Toolset } from "../tools/index.js";

export interface AnyToolResult {
  ok: boolean;
  text: string;
}

/**
 * Normalise an executor's structured return value to `{ ok, text }`.
 * Two shapes are accepted:
 *
 *   1. Fs-style: `{ ok: boolean, text: string, ...extras }` — used
 *      as-is.
 *   2. Anything else: JSON-encoded into `text`. `ok` is derived
 *      from common hints (`ok`, `exit_code`, `state`) and defaults
 *      to true when there's no clear signal.
 *
 *  Lives in the adapter file because it's the only consumer now
 *  that the host's chat handler runs through pi-agent-core.
 */
export function normaliseToolResult(out: unknown): AnyToolResult {
  if (
    out &&
    typeof out === "object" &&
    typeof (out as { text?: unknown }).text === "string" &&
    typeof (out as { ok?: unknown }).ok === "boolean"
  ) {
    const r = out as { ok: boolean; text: string };
    return { ok: r.ok, text: r.text };
  }
  if (out && typeof out === "object") {
    const r = out as Record<string, unknown>;
    let ok = true;
    if (typeof r.ok === "boolean") ok = r.ok;
    else if (typeof r.exit_code === "number") ok = r.exit_code === 0;
    else if (typeof r.state === "string")
      ok = r.state !== "error" && r.state !== "failed";
    return { ok, text: JSON.stringify(out) };
  }
  return { ok: true, text: String(out ?? "") };
}

export interface AdaptedToolset {
  /** pi-agent-core tools, ready to drop into AgentContext.tools. */
  tools: PiAgentTool[];
  /** Tool name → original plugin executor. Useful when the host
   *  needs to peek (e.g. agent-loop's task_complete capture). */
  executors: Toolset["executors"];
}

export function adaptToolset(toolset: Toolset): AdaptedToolset {
  const tools: PiAgentTool[] = toolset.schemas.map((schema) => {
    const exec = toolset.executors[schema.name];
    const piTool: PiAgentTool = {
      ...schema,
      // pi-agent-core requires a `label` (UI display); fall back to
      // the schema name. Plugin-side schema doesn't carry one yet.
      label: schema.name,
      // Default execution mode "sequential" matches the legacy
      // tianshu chat handler behaviour (one tool at a time). We can
      // flip individual plugin tools to "parallel" later when their
      // contract documents thread-safety.
      executionMode: "sequential",
      execute: async (
        _toolCallId: string,
        params: unknown,
        _signal?: AbortSignal,
      ): Promise<AgentToolResult<unknown>> => {
        const args =
          params && typeof params === "object"
            ? (params as Record<string, unknown>)
            : {};
        if (!exec) {
          // Should be unreachable — schema came from the same map.
          return {
            content: [
              { type: "text", text: `unknown tool: ${schema.name}` } as TextContent,
            ],
            details: undefined,
          };
        }
        // Plugin tools are sync OR async; both are fine.
        const raw = await Promise.resolve(exec(args));
        const norm = normaliseToolResult(raw);
        const result: AgentToolResult<unknown> = {
          content: [{ type: "text", text: norm.text } as TextContent],
          // Stash the raw tool result on `details` so future UI
          // bits (chat panel rendering) can introspect it without
          // re-parsing the text.
          details: raw,
        };
        if (!norm.ok) {
          // pi-agent-core has no boolean on AgentToolResult itself
          // — it routes "isError" via the afterToolCall hook or
          // via promise rejection. We piggyback on the surrounding
          // run's afterToolCall to flip isError when this happens
          // (caller wires that up).
          (result as AgentToolResult<unknown> & { __ok: boolean }).__ok = false;
        }
        return result;
      },
    };
    return piTool;
  });
  return { tools, executors: toolset.executors };
}

/** Helper for the surrounding agent run: detect whether a finished
 *  AgentToolResult came from a `{ ok:false }` plugin return, so
 *  pi-agent's `afterToolCall` can mark it as an error to the LLM. */
export function isAdapterError(result: unknown): boolean {
  return Boolean(
    (result as { __ok?: boolean } | null | undefined)?.__ok === false,
  );
}
