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
  if (opts.broadcast) {
    tools.push(switchPanelTool(opts.broadcast));
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

const KNOWN_PANELS: Record<string, string> = {
  board: "board.main",
  boards: "board.main",
  tasks: "workboard.main",
  workboard: "workboard.main",
  kanban: "workboard.main",
  wiki: "wiki.main",
  cron: "cron.main",
  scheduler: "cron.main",
  files: "files.main",
  browser: "microsandbox.browser",
  sandbox: "microsandbox.browser",
  bridge: "reverse-mcp.main",
  wechat: "wechat.main",
};

function switchPanelTool(
  broadcast: (event: string, payload: unknown) => void,
): { schema: Tool; executor: ToolExecutor } {
  return {
    schema: {
      name: "switch_panel",
      description:
        "Switch the Tianshu UI right panel to a specific plugin tab. " +
        "Available panels: board, tasks, wiki, cron, files, browser, bridge, wechat. " +
        "Use 'close' to close the panel.",
      parameters: Type.Object({
        panel: Type.String({
          description:
            "Panel name (board|tasks|wiki|cron|files|browser|bridge|wechat) or 'close' to hide the panel.",
        }),
      }),
    },
    executor: (args: unknown) => {
      const { panel } = args as { panel: string };
      const key = panel.toLowerCase().trim();
      if (key === "close" || key === "none" || key === "hide") {
        broadcast("ui:switch_panel", { panelId: null });
        return { ok: true, message: "Panel closed." };
      }
      const panelId = KNOWN_PANELS[key] ?? key;
      broadcast("ui:switch_panel", { panelId });
      return { ok: true, message: `Switched to ${panelId}.` };
    },
  };
}
