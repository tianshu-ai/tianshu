/**
 * Progressive-history disclosure transform.
 *
 * Goal: for long sessions, avoid re-sending every tool_call / tool_result
 * on every turn. Keep the most recent K user turns fully intact; for
 * older turns, drop tool call arguments and tool result bodies, leaving
 * only stub markers with the tool_call_id. The agent can recover full
 * details via the `recall_tool_call` / `recall_range` host tools.
 *
 * Design (2026-09-12, agreed with Yu):
 *   - Only kicks in when the branch has >= `minTurnsToEngage` user
 *     turns (default 15). Short sessions are untouched.
 *   - The most recent `recentTurnsToKeep` user turns (default 5) are
 *     returned verbatim.
 *   - Older MessageEntry entries are rewritten:
 *       * UserMessage       → verbatim
 *       * AssistantMessage  → text/thinking verbatim, ToolCall → stub
 *       * ToolResultMessage → single-line stub with tool_call_id
 *   - Non-message entries (compaction, custom, session_info, etc.)
 *     are passed through unchanged.
 *   - The transform is a pure function over SessionTreeEntry[]; it
 *     does NOT mutate the session tree. The stubs are transient and
 *     only affect one turn's model context.
 *
 * Wire this in by passing it to `new PiSession(storage, {
 *   entryTransforms: [progressiveHistoryTransform(config)]
 * })`.
 */

import type {
  SessionTreeEntry,
  MessageEntry,
} from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
} from "@earendil-works/pi-ai";

export interface ProgressiveHistoryConfig {
  /** Turn count below which the transform is a no-op. Default 15. */
  minTurnsToEngage?: number;
  /** How many recent user turns to keep verbatim. Default 5. */
  recentTurnsToKeep?: number;
  /** When true, log a one-liner every time the transform runs. */
  debug?: boolean;
}

const DEFAULTS = {
  minTurnsToEngage: 15,
  recentTurnsToKeep: 5,
} as const;

/**
 * Prefixes tianshu uses when injecting a transient plain-text notice
 * into the session as a `role: "user"` message (plugin enable/disable,
 * tool-catalog refresh, session-recovery status, etc.). These are
 * NOT user-authored turns and must not open a turn boundary for the
 * progressive-history transform — otherwise "turn N" starts drifting
 * off by however many system notes were injected, and the transform's
 * old/new region split lands in the wrong place.
 *
 * If you add another injection site elsewhere in the codebase, add its
 * prefix here so recall_range and this transform stay in agreement.
 */
const SYSTEM_INJECTED_USER_PREFIXES = [
  "[plugin-system]",
  "[system note]",
];

/** True when a MessageEntry is a real user-authored turn (as opposed
 *  to a tianshu-injected `role: "user"` system notice). */
function isRealUserTurn(entry: SessionTreeEntry): boolean {
  if (entry.type !== "message") return false;
  const m = entry.message;
  if (m.role !== "user") return false;
  // Grab the first text chunk of the message and test its prefix.
  // Tianshu's SqliteSessionStorage.parseMessage wraps legacy plain-text
  // rows as `content: [{type:"text", text:"..."}]`, so this reaches
  // both the legacy shape and the modern one.
  let firstText: string | null = null;
  if (typeof m.content === "string") {
    firstText = m.content;
  } else if (Array.isArray(m.content)) {
    for (const p of m.content) {
      if (p && typeof p === "object" && "type" in p && (p as { type: string }).type === "text") {
        const t = (p as { text?: unknown }).text;
        if (typeof t === "string") {
          firstText = t;
          break;
        }
      }
    }
  }
  if (firstText === null) return true; // no text — treat as real turn conservatively
  const head = firstText.trimStart();
  for (const prefix of SYSTEM_INJECTED_USER_PREFIXES) {
    if (head.startsWith(prefix)) return false;
  }
  return true;
}

/**
 * Count the user turns represented by a branch. A "user turn" is
 * any MessageEntry that passes `isRealUserTurn` — tianshu-injected
 * `role: "user"` system notices don't count.
 */
function countUserTurns(entries: readonly SessionTreeEntry[]): number {
  let n = 0;
  for (const e of entries) {
    if (isRealUserTurn(e)) n++;
  }
  return n;
}

/**
 * Find the index of the Nth-most-recent real user MessageEntry
 * (0-indexed from the end). If N exceeds the number of user turns,
 * returns 0. System-injected user notices are skipped.
 *
 * Used to split the branch into (older, recent) at a user-turn boundary.
 */
function indexOfNthRecentUserTurn(
  entries: readonly SessionTreeEntry[],
  n: number,
): number {
  let seen = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (isRealUserTurn(e)) {
      seen++;
      if (seen === n) return i;
    }
  }
  return 0;
}

/**
 * Rewrite an AssistantMessage: keep text/thinking verbatim, replace
 * each ToolCall with a compact stub.
 *
 * Stub format: `TextContent` blob "[archived call: <name>(id=<id>)]".
 * That's enough for the model to know a call happened AND to recall
 * it by id if it needs the arguments or result.
 */
function stubAssistantToolCalls(msg: AssistantMessage): AssistantMessage {
  const content = msg.content;
  if (!Array.isArray(content)) return msg;
  let hasToolCall = false;
  for (const p of content) {
    if (p.type === "toolCall") {
      hasToolCall = true;
      break;
    }
  }
  if (!hasToolCall) return msg;

  const newContent: (TextContent | ThinkingContent | ToolCall)[] = [];
  for (const p of content) {
    if (p.type === "toolCall") {
      const stub: TextContent = {
        type: "text",
        text: `[archived call: ${p.name}(id=${p.id})]`,
      };
      newContent.push(stub);
    } else {
      newContent.push(p);
    }
  }
  return { ...msg, content: newContent };
}

/**
 * Rewrite a ToolResultMessage into a stub. We MUST preserve the
 * role="toolResult" shape (Anthropic / OpenAI require tool_use blocks
 * to be paired with tool_result blocks in the same request), so we
 * keep toolCallId + toolName intact and replace the content with a
 * single short TextContent.
 */
function stubToolResult(msg: ToolResultMessage): ToolResultMessage {
  const stubText: TextContent = {
    type: "text",
    text:
      `[archived result: ${msg.toolName}(id=${msg.toolCallId}). ` +
      `Use recall_tool_call to retrieve the full arguments + output.]`,
  };
  return { ...msg, content: [stubText] };
}

/**
 * The transform. Wrap it once with your config and pass into
 * `new PiSession(storage, { entryTransforms: [...] })`.
 */
export function progressiveHistoryTransform(
  config: ProgressiveHistoryConfig = {},
) {
  const minTurns = config.minTurnsToEngage ?? DEFAULTS.minTurnsToEngage;
  const recentTurns = config.recentTurnsToKeep ?? DEFAULTS.recentTurnsToKeep;

  return function progressiveHistoryTransformImpl(
    entries: readonly SessionTreeEntry[],
  ): readonly SessionTreeEntry[] {
    const userTurns = countUserTurns(entries);
    if (userTurns < minTurns) return entries;

    // The boundary is the index of the (recentTurns)-th most recent
    // user turn. Entries at or after this index are the "recent
    // region"; entries before are the "old region" that gets stubbed.
    const boundary = indexOfNthRecentUserTurn(entries, recentTurns);

    if (config.debug) {
      // eslint-disable-next-line no-console
      console.log(
        `[progressive-history] engage: userTurns=${userTurns} ` +
          `recentKeep=${recentTurns} boundary=${boundary} ` +
          `oldEntries=${boundary} recentEntries=${entries.length - boundary}`,
      );
    }

    const result: SessionTreeEntry[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (i >= boundary) {
        // Recent region: verbatim
        result.push(e);
        continue;
      }
      // Old region: rewrite messages, pass through everything else.
      if (e.type !== "message") {
        result.push(e);
        continue;
      }
      const m = e.message;
      if (m.role === "user") {
        // User verbatim
        result.push(e);
      } else if (m.role === "assistant") {
        const rewritten = stubAssistantToolCalls(m);
        if (rewritten === m) {
          result.push(e);
        } else {
          const newEntry: MessageEntry = { ...e, message: rewritten };
          result.push(newEntry);
        }
      } else if (m.role === "toolResult") {
        const rewritten = stubToolResult(m);
        const newEntry: MessageEntry = { ...e, message: rewritten };
        result.push(newEntry);
      } else {
        result.push(e);
      }
    }
    return result;
  };
}
