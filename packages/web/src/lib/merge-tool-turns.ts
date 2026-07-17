// The wire protocol persists assistant turns and tool-result turns as
// separate rows so the agent log on the server is faithful. The UI
// however wants to show each tool call as ONE collapsible row that
// already knows its own result — the same pattern the closed-source
// Tianshu used for its `tool_call` pseudo-role.
//
// `mergeToolTurns` walks the message stream once, attaches matching
// tool-result rows to their owning assistant turn (by `callId`), and
// drops the now-redundant `role=tool` rows from the output.

import type {
  WireAssistantBlock,
  WireMessage,
  WireToolCall,
  WireToolResult,
} from "../types/chat";

/** Assistant turn enriched with the resolved result (if any) for each
 *  of its tool calls. */
export interface MergedToolCall extends WireToolCall {
  /** Result if it has landed; undefined while the call is still running. */
  result?: WireToolResult;
}

/** Same shape as `WireAssistantBlock` but tool-call blocks now carry
 *  their resolved result. UI renders these in author order. */
export type MergedAssistantBlock =
  | { kind: "text"; text: string }
  | (Extract<WireAssistantBlock, { kind: "toolCall" }> & { result?: WireToolResult });

export interface MergedMessage
  extends Omit<WireMessage, "toolCalls" | "toolResult" | "blocks"> {
  /** Assistant tool calls with their resolved results inlined. */
  resolvedToolCalls?: MergedToolCall[];
  /** Author-ordered text + tool-call blocks with results inlined.
   *  Populated whenever the wire message had `blocks`. UI prefers
   *  this when set; falls back to `text + resolvedToolCalls` for
   *  legacy rows. */
  resolvedBlocks?: MergedAssistantBlock[];
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
    if (
      m.role === "assistant" &&
      ((m.toolCalls && m.toolCalls.length > 0) || (m.blocks && m.blocks.length > 0))
    ) {
      const resolved: MergedToolCall[] = (m.toolCalls ?? []).map((c) => ({
        ...c,
        result: resultsByCallId.get(c.id),
      }));
      const resolvedBlocks: MergedAssistantBlock[] | undefined = m.blocks?.map(
        (b): MergedAssistantBlock =>
          b.kind === "toolCall"
            ? { ...b, result: resultsByCallId.get(b.id) }
            : b,
      );
      // Strip the wire-only fields we already lifted into
      // `resolvedBlocks` / `resolvedToolCalls` and pass the rest
      // through (notably `attachments`).
      const { toolCalls: _tc, toolResult: _tr, blocks: _b, ...rest } = m;
      out.push({
        ...rest,
        resolvedToolCalls: resolved.length > 0 ? resolved : undefined,
        resolvedBlocks,
      });
      continue;
    }
    const { toolCalls: _tc, toolResult: _tr, blocks: _b, ...rest } = m;
    out.push(rest);
  }
  return coalesceAssistantTurns(out);
}

/**
 * Fold a tool-only assistant turn into the assistant turn that
 * immediately follows it, so a "call a tool → then narrate" sequence
 * renders as ONE bubble (one TIANSHU header + timestamp) with the tool
 * card and the narration stacked, instead of two separate bubbles.
 *
 * We only merge when the earlier assistant turn carries tool calls
 * (its blocks are all toolCall / empty text) and the next row is also
 * an assistant turn with no user/tool row in between. The merged row
 * keeps the LATER turn's metadata (final usage/model) and concatenates
 * blocks in author order. Conservative by design: unrelated back-to-
 * back narration turns (no tool call in the first) are left alone.
 */
function coalesceAssistantTurns(rows: MergedMessage[]): MergedMessage[] {
  const toBlocks = (m: MergedMessage): MergedAssistantBlock[] => {
    if (m.resolvedBlocks && m.resolvedBlocks.length > 0) return m.resolvedBlocks;
    const blocks: MergedAssistantBlock[] = [];
    if (m.text && m.text.length > 0) blocks.push({ kind: "text", text: m.text });
    for (const c of m.resolvedToolCalls ?? [])
      blocks.push({ kind: "toolCall", ...c });
    return blocks;
  };
  const hasToolCall = (blocks: MergedAssistantBlock[]) =>
    blocks.some((b) => b.kind === "toolCall");

  const out: MergedMessage[] = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.role === "assistant" &&
      row.role === "assistant" &&
      hasToolCall(toBlocks(prev))
    ) {
      // Fold this assistant turn into the previous one.
      const mergedBlocks = [...toBlocks(prev), ...toBlocks(row)];
      out[out.length - 1] = {
        ...prev,
        // Keep the later turn's metadata (final model/usage) + newest
        // timestamp so the merged bubble reads as the completed turn.
        meta: row.meta ?? prev.meta,
        createdAt: row.createdAt ?? prev.createdAt,
        text: "",
        resolvedToolCalls: undefined,
        resolvedBlocks: mergedBlocks,
      };
      continue;
    }
    out.push(row);
  }
  return out;
}
