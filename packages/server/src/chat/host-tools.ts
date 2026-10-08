/**
 * Host-level tools — fundamental capabilities available to ALL agents
 * (main chat + workers), independent of plugins.
 *
 * Injected via `buildToolset({ hostTools })`.
 *
 * The compact tool uses a deferred binding: the executor captures a
 * mutable `ref` object whose `.piSession` / `.harness` fields are
 * filled in after harness creation (tools are assembled before the
 * harness in both handler.ts and agent-loop.ts). The executor runs
 * only during a turn — by which time the ref is guaranteed populated.
 */

import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import type {
  AgentHarness,
  AgentLane,
} from "@earendil-works/pi-agent-core";
import type {
  CompactionSettings,
  Context,
  Session as PiSession,
} from "./pi-compat/index.js";
import type { AgentTool } from "@tianshu-ai/plugin-sdk";
import { tryAutoCompact } from "./compact-decision.js";
import type { ToolExecutor } from "../tools/index.js";
import { buildRecallToolCallTool, buildRecallRangeTool } from "./host-tools/recall-tools.js";
import {
  buildGenerateImageHostTool,
  isImageGenEnabled,
  listImageGenModels,
} from "./host-tools/generate-image.js";
import { buildAskUserTool } from "./host-tools/ask-user.js";
import type { ResolvedConfig } from "../core/config.js";

export { listImageGenModels, isImageGenEnabled };

export interface HostToolsOpts {
  contextWindow: number | undefined;
  compactionSettings: CompactionSettings & { triggerPercent?: number };
  /** Callback to broadcast a WS event to the user. Used by switch_panel and ask_user. */
  broadcast?: (event: string, payload: unknown) => void;
  /** Callback to send a raw ServerMsg to the client. Used by ask_user. */
  sendRaw?: (msg: unknown) => void;
  /** Current session id. Needed by ask_user to tag interactions. */
  sessionId?: string;
  /** Returns available panel ids from active plugins. */
  listPanels?: () => Array<{ panelId: string; pluginId: string; displayName: string }>;
  /** Opens the tenant DB for the recall_* tools. Optional: when absent,
   *  the recall tools are skipped (unit tests / non-chat contexts). */
  openTenant?: (tenantId: string) => {
    db: import("better-sqlite3").Database;
    tenantId: string;
  };
  /** Tenant config. When present and it has at least one image-gen
   *  model, we register the built-in `generate_image` tool. */
  config?: ResolvedConfig;
  /** Optional AbortSignal forwarded to generate_image's fetch calls. */
  signal?: AbortSignal;
  /** User home dir (workspace/users/<userId>) for saving generated images. */
  userHomeDir?: string;
}

/**
 * Mutable ref filled after harness creation. The compact tool's
 * executor reads from this at call-time (never at build-time).
 */
/**
 * Mutable ref filled after harness creation. The activate_tools
 * executor reads from this at call-time (never at build-time).
 */
export interface ActivateToolsRef {
  lane?: AgentLane;
  context?: Context;
  /** On-demand group id → tool names, populated from Toolset. */
  ondemandGroups?: Map<string, string[]>;
}

export interface CompactToolRef {
  piSession?: PiSession;
  harness?: AgentHarness;
  /** pi 0.85: compact() moved from harness to lane. */
  lane?: AgentLane;
  /** pi 0.85: every session/lane call requires a Context. */
  context?: Context;
  /** Set by the compact_context tool when called mid-turn.
   *  The post-turn maybeAutoCompact checks this and forces compaction. */
  requestedByAgent?: boolean;
}

/**
 * Build host tools + return a ref object the caller must populate
 * once `piSession` and `harness` are available.
 */
export function buildHostTools(opts: HostToolsOpts): Array<{ schema: Tool; executor: ToolExecutor }> {
  // The ref is shared with the executor closure. Caller sets
  // ref.piSession / ref.harness after harness creation.
  const ref: CompactToolRef = {};
  const activateRef: ActivateToolsRef = {};
  const tools: Array<{ schema: Tool; executor: ToolExecutor }> = [
    compactContextTool(opts, ref),
    activateToolsTool(activateRef),
  ];
  if (opts.broadcast && opts.listPanels) {
    tools.push(switchPanelTool(opts.broadcast, opts.listPanels));
  }
  // generate_image only when the tenant explicitly picked an image-gen
  // model. Leaving imageGenModelId empty disables the tool entirely
  // — agents don't see it, regardless of what's in the catalog.
  if (opts.config && isImageGenEnabled(opts.config)) {
    tools.push(buildGenerateImageHostTool(opts.config, opts.userHomeDir, opts.signal));
  }
  // ask_user: available when we can push events to the client
  if (opts.sendRaw && opts.sessionId) {
    tools.push(buildAskUserTool({
      sessionId: opts.sessionId,
      broadcast: opts.sendRaw,
      signal: opts.signal,
    }));
  }
  // Attach refs to the array so the caller can grab them.
  (tools as unknown as { _compactRef: CompactToolRef })._compactRef = ref;
  (tools as unknown as { _activateRef: ActivateToolsRef })._activateRef = activateRef;
  return tools;
}

/**
 * Progressive-history recall tools (paired with `progressive-history.ts`).
 *
 * Returned as `AgentTool[]` (not the raw hostTools shape) because they
 * need an AgentToolContext to reach tenant.db + sessionId. Callers pass
 * them into `buildToolset` via `pluginTools` (with a synthetic pluginId
 * of `_host`) rather than `hostTools` — that reuses the same
 * tenant/session/log wiring plugin tools already get.
 */
export function buildRecallHostTools(deps: {
  openTenant: (tenantId: string) => {
    db: import("better-sqlite3").Database;
    tenantId: string;
  };
}): AgentTool[] {
  return [
    buildRecallToolCallTool(deps),
    buildRecallRangeTool(deps),
  ];
}

/** Extract the CompactToolRef from a hostTools array. */
export function getCompactRef(hostTools: Array<{ schema: Tool; executor: ToolExecutor }>): CompactToolRef {
  return (hostTools as unknown as { _compactRef: CompactToolRef })._compactRef;
}

/** Extract the ActivateToolsRef from a hostTools array. */
export function getActivateRef(hostTools: Array<{ schema: Tool; executor: ToolExecutor }>): ActivateToolsRef {
  return (hostTools as unknown as { _activateRef: ActivateToolsRef })._activateRef;
}

function compactContextTool(
  opts: HostToolsOpts,
  ref: CompactToolRef,
): { schema: Tool; executor: ToolExecutor } {
  return {
    schema: {
      name: "compact_context",
      description:
        "Compress the conversation history by summarising older messages. " +
        "Call this when context usage is high (>70%) and you need room to continue working. " +
        "After compaction, older messages are replaced with a concise summary while recent " +
        "context is preserved verbatim. Returns the result of the compaction attempt.",
      parameters: Type.Object({}),
    },
    executor: async () => {
      if (!ref.piSession || !ref.harness) {
        return { ok: false, message: "Compaction not available (session not initialized)." };
      }
      // Try immediate compaction (works if harness is idle, e.g. during followUp gaps).
      if (!ref.lane || !ref.context) {
        return { ok: false, message: "Compaction not available (lane/context not initialized)." };
      }
      const result = await tryAutoCompact({
        piSession: ref.piSession,
        harness: ref.harness,
        lane: ref.lane,
        context: ref.context,
        contextWindow: opts.contextWindow,
        settings: {
          enabled: true,
          reserveTokens: opts.contextWindow ?? 999999,
          keepRecentTokens: opts.compactionSettings.keepRecentTokens,
        },
      });
      if (result.compacted) {
        return { ok: true, message: "Context compacted successfully.", tokensBefore: result.tokensBefore };
      }
      if (result.reason === "nothing_to_compact") {
        return { ok: false, message: "Nothing to compact — conversation is too short or was just compacted." };
      }
      // Harness busy (mid-turn): schedule compaction for right after this turn ends.
      if (result.error && /idle|busy/i.test(result.error)) {
        ref.requestedByAgent = true;
        return { ok: true, message: "Compaction scheduled — will run automatically when the current turn finishes." };
      }
      return { ok: false, message: result.error ?? "Compaction failed." };
    },
  };
}

// ─── switch_panel ──────────────────────────────────────────────

function switchPanelTool(
  broadcast: (event: string, payload: unknown) => void,
  listPanels: () => Array<{ panelId: string; pluginId: string; displayName: string }>,
): { schema: Tool; executor: ToolExecutor } {
  return {
    schema: {
      name: "switch_panel",
      description:
        "Switch the Tianshu UI right panel to a specific plugin tab. " +
        "Pass a panel id (e.g. 'wiki.main', 'workboard.main') or a short name " +
        "(e.g. 'wiki', 'tasks'). Use 'close' to close the panel. " +
        "Call with panel='list' to see all available panels.",
      parameters: Type.Object({
        panel: Type.String({
          description:
            "Panel id, short name, 'list' to list available panels, or 'close' to hide.",
        }),
      }),
    },
    executor: (args: unknown) => {
      const { panel } = args as { panel: string };
      const key = panel.toLowerCase().trim();

      if (key === "list") {
        const panels = listPanels();
        if (panels.length === 0) return { ok: true, message: "No panels available." };
        const list = panels.map((p) => `- ${p.panelId} (${p.displayName})`).join("\n");
        return { ok: true, message: `Available panels:\n${list}` };
      }

      if (key === "close" || key === "none" || key === "hide") {
        broadcast("ui:switch_panel", { panelId: null });
        return { ok: true, message: "Panel closed." };
      }

      // Try exact match first, then fuzzy match by short name
      const panels = listPanels();
      const exact = panels.find((p) => p.panelId === key);
      if (exact) {
        broadcast("ui:switch_panel", { panelId: exact.panelId });
        return { ok: true, message: `Switched to ${exact.displayName} (${exact.panelId}).` };
      }
      // Match by plugin id prefix or display name
      const fuzzy = panels.find((p) =>
        p.pluginId === key ||
        p.displayName.toLowerCase().includes(key) ||
        p.panelId.startsWith(key + ".")
      );
      if (fuzzy) {
        broadcast("ui:switch_panel", { panelId: fuzzy.panelId });
        return { ok: true, message: `Switched to ${fuzzy.displayName} (${fuzzy.panelId}).` };
      }

      // Fallback: try as-is (might be a custom panel id)
      broadcast("ui:switch_panel", { panelId: key });
      return { ok: true, message: `Switched to ${key} (unrecognized — sent as-is).` };
    },
  };
}

// ─── activate_tools ────────────────────────────────────────────

function activateToolsTool(
  ref: ActivateToolsRef,
): { schema: Tool; executor: ToolExecutor } {
  return {
    schema: {
      name: "activate_tools",
      description:
        "Load on-demand tool groups into the active tool set. " +
        "Some tool groups are not loaded by default to save context. " +
        "Call this when you need tools from a specific group. " +
        "The available groups are listed in <available_tool_groups> in your system prompt. " +
        "After activation, the tools are immediately available for use.",
      parameters: Type.Object({
        groups: Type.Array(Type.String(), {
          description:
            'Tool group names to activate, e.g. ["wiki", "workboard"]. ' +
            "See <available_tool_groups> for the full list.",
        }),
      }),
    },
    executor: async (args: unknown) => {
      const { groups } = args as { groups: string[] };
      if (!ref.lane || !ref.context || !ref.ondemandGroups) {
        return {
          ok: false,
          message: "activate_tools not available (session not initialized).",
        };
      }

      // Resolve requested groups → tool names.
      const newToolNames: string[] = [];
      const unknownGroups: string[] = [];
      const alreadyActiveGroups: string[] = [];

      // Read current active set.
      let currentActive: string[];
      try {
        currentActive = await ref.lane.getActiveTools(ref.context);
      } catch {
        currentActive = [];
      }
      const activeSet = new Set(currentActive);

      for (const groupId of groups) {
        const toolNames = ref.ondemandGroups.get(groupId);
        if (!toolNames) {
          unknownGroups.push(groupId);
          continue;
        }
        // Check if already active.
        const allActive = toolNames.every((n) => activeSet.has(n));
        if (allActive) {
          alreadyActiveGroups.push(groupId);
          continue;
        }
        for (const name of toolNames) {
          if (!activeSet.has(name)) {
            newToolNames.push(name);
            activeSet.add(name);
          }
        }
      }

      if (newToolNames.length === 0 && unknownGroups.length === 0) {
        return {
          ok: true,
          message: `All requested groups are already active: ${alreadyActiveGroups.join(", ")}.`,
        };
      }

      if (newToolNames.length > 0) {
        try {
          await ref.lane.setActiveTools([...activeSet], ref.context);
        } catch (err) {
          return {
            ok: false,
            message: `Failed to activate tools: ${
              err instanceof Error ? err.message : String(err)
            }`,
          };
        }
      }

      const parts: string[] = [];
      if (newToolNames.length > 0) {
        parts.push(
          `Activated ${newToolNames.length} tool(s): ${newToolNames.join(", ")}.`,
        );
      }
      if (alreadyActiveGroups.length > 0) {
        parts.push(
          `Already active: ${alreadyActiveGroups.join(", ")}.`,
        );
      }
      if (unknownGroups.length > 0) {
        parts.push(
          `Unknown group(s): ${unknownGroups.join(", ")}. Available: ${[...ref.ondemandGroups.keys()].join(", ")}.`,
        );
      }
      parts.push("You can now use the activated tools.");
      return { ok: unknownGroups.length === 0, message: parts.join(" ") };
    },
  };
}
