// The wire protocol persists assistant turns and tool-result turns as
// separate rows so the agent log on the server is faithful. The UI
// however wants to show each tool call as ONE collapsible row that
// already knows its own result — the same pattern the closed-source
// Tianshu used for its `tool_call` pseudo-role.
//
// `mergeToolTurns` walks the message stream once, attaches matching
// tool-result rows to their owning assistant turn (by `callId`), and
// drops the now-redundant `role=tool` rows from the output.

import type { WireMessage, WireToolCall, WireToolResult } from "../types/chat";

/** Assistant turn enriched with the resolved result (if any) for each
 *  of its tool calls. */
export interface MergedToolCall extends WireToolCall {
  /** Result if it has landed; undefined while the call is still running. */
  result?: WireToolResult;
}

export interface MergedMessage extends Omit<WireMessage, "toolCalls" | "toolResult"> {
  /** Assistant tool calls with their resolved results inlined. */
  resolvedToolCalls?: MergedToolCall[];
}

export function mergeToolTurns(messages: WireMessage[]): MergedMessage[] {
  // First pass — index every tool result by its callId so we can attach
  // it to the assistant turn that authored the call.
  const resultsByCallId = new Map<string, WireToolResult>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolResult) {
      resultsByCallId.set(m.toolResult.callId, m.toolResult);
    }
  }

  // Second pass — emit assistant + user rows; drop tool rows.
  const out: MergedMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") continue;
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const resolved: MergedToolCall[] = m.toolCalls.map((c) => ({
        ...c,
        result: resultsByCallId.get(c.id),
      }));
      // Strip the wire-only fields we already lifted into
      // `resolvedToolCalls` and pass the rest through (notably
      // `attachments`, added in PR #51 — dropping them silently is
      // why uploaded files vanished from the user bubble).
      const { toolCalls: _tc, toolResult: _tr, ...rest } = m;
      out.push({ ...rest, resolvedToolCalls: resolved });
      continue;
    }
    const { toolCalls: _tc, toolResult: _tr, ...rest } = m;
    out.push(rest);
  }
  return out;
}
