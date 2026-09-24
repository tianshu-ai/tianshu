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
 *   - Only kicks in when the transcript has >= `minTurnsToEngage` user
 *     turns (default 15). Short sessions are untouched.
 *   - The most recent `recentTurnsToKeep` user turns (default 5) are
 *     returned verbatim.
 *   - Older messages are rewritten:
 *       * UserMessage       → verbatim + `[turn N]` prefix
 *       * AssistantMessage  → text/thinking verbatim, ToolCall → stub
 *       * ToolResultMessage → single-line stub with tool_call_id
 *   - The transform is a pure function over AgentMessage[]; it
 *     does NOT mutate the session tree. The stubs are transient and
 *     only affect one turn's model context.
 *
 * pi 0.85 migration:
 *   - Previous versions injected this via
 *     `new PiSession(storage, { entryTransforms: [...] })`.
 *   - pi 0.85 removed `entryTransforms`. The equivalent hook is
 *     `AgentHarnessOptions.toProviderMessages`, which pi invokes on
 *     every provider request (execution/assistant.js:67) with the
 *     assembled `AgentMessage[]` before conversion to `Message[]`.
 *   - `AgentMessage = Message | CustomAgentMessages[K]`. We only
 *     rewrite the three known `Message` roles; any custom message
 *     shape passes through unchanged.
 *   - Wire this in via `AgentHarness.create({ toProviderMessages:
 *     progressiveHistoryTransform(config), ... })`.
 */

import type {
  AgentMessage,
} from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Message,
  UserMessage,
  ToolCall,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
} from "@earendil-works/pi-ai";
import { isKnownMessage, isRealUserAgentMessage } from "./real-user-turn.js";

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
 * If you add another injection site elsewhere in the codebase, add
 * its prefix to real-user-turn.ts's SYSTEM_INJECTED_USER_PREFIXES
 * so this transform, recall_range, and the storage-side turn_number
 * writer stay in agreement.
 */
// The predicate + prefix list moved to ./real-user-turn.ts so
// storage, recall, and this transform share one source of truth.
const isRealUserTurn = isRealUserAgentMessage;

/**
 * Count the user turns represented by a message list. A "user turn"
 * is any UserMessage that passes `isRealUserTurn` — tianshu-injected
 * `role: "user"` system notices don't count.
 */
function countUserTurns(messages: readonly AgentMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (isRealUserTurn(m)) n++;
  }
  return n;
}

/**
 * Find the index of the Nth-most-recent real user message
 * (0-indexed from the end). If N exceeds the number of user turns,
 * returns 0. System-injected user notices are skipped.
 *
 * Used to split the transcript into (older, recent) at a user-turn
 * boundary.
 */
function indexOfNthRecentUserTurn(
  messages: readonly AgentMessage[],
  n: number,
): number {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (isRealUserTurn(m)) {
      seen++;
      if (seen === n) return i;
    }
  }
  return 0;
}

/**
 * Rewrite an AssistantMessage: keep text/thinking verbatim, and
 * shrink each ToolCall's arguments to a placeholder marker.
 *
 * IMPORTANT: we CANNOT delete the ToolCall block or convert it to
 * text — Anthropic (and OpenAI) require every `tool_use` block in
 * an assistant message to be paired with a matching `tool_result`
 * block in a subsequent user/tool message. Breaking that invariant
 * yields `400 status code (no body)` from the provider.
 *
 * So the structural shape stays intact (same id, same name, same
 * type="toolCall") and only the `arguments` payload is elided.
 * A short text hint prefix in the assistant message tells the model
 * "this call is archived; use recall_tool_call to get the real args".
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
      // Preserve id + name + type="toolCall" so the provider still
      // sees a valid tool_use block; shrink arguments to a marker.
      const stubbed: ToolCall = {
        type: "toolCall",
        id: p.id,
        name: p.name,
        arguments: { __archived: true, hint: `call recall_tool_call("${p.id}") for original args` },
      };
      newContent.push(stubbed);
    } else {
      newContent.push(p);
    }
  }
  return { ...msg, content: newContent };
}

/**
 * Prefix an old-region UserMessage with `[turn N]` so the agent can
 * see its absolute turn number when it wants to call recall_range.
 * Only real user turns get this — injected system notices are already
 * filtered out by isRealUserTurn.
 *
 * Non-destructive: the original text is preserved verbatim after the
 * marker. If content is a plain string (legacy), we wrap it in a
 * TextContent array. If it's already a mixed content array, we prepend
 * one small TextContent block — that keeps other block types (images,
 * tool blocks the SDK might add later) intact.
 */
function prefixUserWithTurnNumber(
  msg: UserMessage,
  turnNumber: number,
): UserMessage {
  const marker: TextContent = {
    type: "text",
    text: `[turn ${turnNumber}]`,
  };
  if (typeof msg.content === "string") {
    // Legacy shape — upgrade to array. The runtime treats string and
    // array as equivalent input at the provider layer.
    return {
      ...msg,
      content: [marker, { type: "text", text: msg.content }],
    };
  }
  if (!Array.isArray(msg.content)) return msg;
  return {
    ...msg,
    content: [marker, ...msg.content],
  };
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
 * `AgentHarness.create({ toProviderMessages: progressiveHistoryTransform(config), ... })`.
 *
 * pi 0.85 signature: `(messages: AgentMessage[], context: Context) => Message[]`.
 * We ignore the context arg — the transform is a pure sync function
 * over the message list, no I/O needed.
 */
export function progressiveHistoryTransform(
  config: ProgressiveHistoryConfig = {},
): (messages: AgentMessage[]) => Message[] {
  const minTurns = config.minTurnsToEngage ?? DEFAULTS.minTurnsToEngage;
  const recentTurns = config.recentTurnsToKeep ?? DEFAULTS.recentTurnsToKeep;

  return function progressiveHistoryTransformImpl(
    messages: AgentMessage[],
  ): Message[] {
    // Narrow AgentMessage[] to Message[]. Custom message shapes (plugin-
    // defined AgentMessage variants) are not something we can rewrite —
    // pass them through as-is by upcasting; pi will convert via its
    // default converter downstream.
    const known: Message[] = messages.filter(isKnownMessage);
    // Non-Message custom shapes — kept for pass-through emission
    // after the known-message transform. Preserving relative order
    // is not critical; provider-facing messages are the known ones.
    const custom = messages.filter((m) => !isKnownMessage(m)) as unknown as Message[];

    const userTurns = countUserTurns(known);
    if (userTurns < minTurns) return [...known, ...custom];

    // The boundary is the index of the (recentTurns)-th most recent
    // user turn. Messages at or after this index are the "recent
    // region"; messages before are the "old region" that gets stubbed.
    const boundary = indexOfNthRecentUserTurn(known, recentTurns);

    if (config.debug) {
      // eslint-disable-next-line no-console
      console.log(
        `[progressive-history] engage: userTurns=${userTurns} ` +
          `recentKeep=${recentTurns} boundary=${boundary} ` +
          `oldMessages=${boundary} recentMessages=${known.length - boundary}`,
      );
    }

    const result: Message[] = [];
    // Walk once to compute the absolute turn number for each real
    // user message (1-indexed, spanning both old and new region).
    // Only real user turns advance the counter; system-injected user
    // notices are numbered 0 (never referenced).
    let userTurnCounter = 0;
    let metaInserted = false;

    for (let i = 0; i < known.length; i++) {
      const msg = known[i]!;
      const isRealUser = isRealUserTurn(msg);
      if (isRealUser) userTurnCounter++;

      if (i >= boundary) {
        // Recent region: verbatim (agent already has the context in
        // full; adding turn markers would only add noise).
        result.push(msg);
        continue;
      }

      // --- Old region ---
      // The first time we see a message in the old region, insert
      // a `[system note]`-prefixed UserMessage explaining what
      // follows. Reusing the `[system note]` prefix means
      // isRealUserTurn excludes it from turn counting — safe if
      // this transform accidentally runs on already-transformed
      // output (idempotent-ish; the note is a no-op).
      if (!metaInserted) {
        metaInserted = true;
        const metaMsg: UserMessage = {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `[system note] Progressive-history disclosure engaged: ` +
                `turns 1–${userTurns - recentTurns} below are archived. ` +
                `Each user message is tagged with its absolute turn number ([turn N]); ` +
                `tool call arguments and tool result bodies are elided — ` +
                `call recall_tool_call(id) for a single call's original args + output, ` +
                `or recall_range(from, to) for a user-turn range's full transcript. ` +
                `The last ${recentTurns} turns are unchanged.`,
            },
          ],
          timestamp: 0,
        };
        result.push(metaMsg);
      }

      // Old region: rewrite messages by role.
      if (msg.role === "user") {
        if (isRealUser) {
          result.push(prefixUserWithTurnNumber(msg, userTurnCounter));
        } else {
          // System-injected notice — pass through unchanged.
          result.push(msg);
        }
      } else if (msg.role === "assistant") {
        result.push(stubAssistantToolCalls(msg));
      } else if (msg.role === "toolResult") {
        result.push(stubToolResult(msg));
      } else {
        result.push(msg);
      }
    }

    // Emit any custom (non-Message) shapes at the tail so we don't
    // silently drop them. In practice pi 0.85's default converter
    // handles them; letting them ride along preserves that path.
    return [...result, ...custom];
  };
}
