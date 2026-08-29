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
import type { AgentHarness, Session as PiSession, CompactionSettings } from "@earendil-works/pi-agent-core";
import { tryAutoCompact } from "./compact-decision.js";
import type { ToolExecutor } from "../tools/index.js";

export interface HostToolsOpts {
  contextWindow: number | undefined;
  compactionSettings: CompactionSettings & { triggerPercent?: number };
  /** Callback to broadcast a WS event to the user. Used by switch_panel. */
  broadcast?: (event: string, payload: unknown) => void;
  /** Returns available panel ids from active plugins. */
  listPanels?: () => Array<{ panelId: string; pluginId: string; displayName: string }>;
}

/**
 * Mutable ref filled after harness creation. The compact tool's
 * executor reads from this at call-time (never at build-time).
 */
export interface CompactToolRef {
  piSession?: PiSession;
  harness?: AgentHarness;
}

/**
 * Build host tools + return a ref object the caller must populate
 * once `piSession` and `harness` are available.
 */
export function buildHostTools(opts: HostToolsOpts): Array<{ schema: Tool; executor: ToolExecutor }> {
  // The ref is shared with the executor closure. Caller sets
  // ref.piSession / ref.harness after harness creation.
  const ref: CompactToolRef = {};
  const tools: Array<{ schema: Tool; executor: ToolExecutor }> = [compactContextTool(opts, ref)];
  if (opts.broadcast && opts.listPanels) {
    tools.push(switchPanelTool(opts.broadcast, opts.listPanels));
  }
  // Attach ref to the array so the caller can grab it.
  (tools as unknown as { _compactRef: CompactToolRef })._compactRef = ref;
  return tools;
}

/** Extract the CompactToolRef from a hostTools array. */
export function getCompactRef(hostTools: Array<{ schema: Tool; executor: ToolExecutor }>): CompactToolRef {
  return (hostTools as unknown as { _compactRef: CompactToolRef })._compactRef;
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
      const result = await tryAutoCompact({
        piSession: ref.piSession,
        harness: ref.harness,
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
