// Host-owned tools: `recall_tool_call` and `recall_range`.
//
// Paired with `progressive-history.ts`: when a long session enters
// progressive-disclosure mode, older tool_call arguments and tool_result
// bodies are replaced with short stubs in the model's context. These
// tools let the agent pull the full original text back on demand from
// the tenant's SQLite `messages` table (which always keeps the raw
// content — the transform is a projection, not a mutation).
//
// Design (2026-09-12, agreed with Yu):
//   - `recall_tool_call(tool_call_id)`: return the assistant's original
//      tool_call arguments PLUS the paired tool_result content, joined
//      as a single readable text block.
//   - `recall_range(from_turn, to_turn)`: return the full original
//      messages (user + assistant + tool_result, tool calls verbatim)
//      spanning a range of user-turn numbers within the current session.
//   - Both are read-only against tianshu's messages table; they never
//      mutate branch state and never inject anything into the session.
//   - Available on main AND worker agents — recall of one's own history
//      is not a privileged operation.

import { Type } from "typebox";
import type {
  AgentTool,
  AgentToolContext,
} from "@tianshu-ai/plugin-sdk";

export interface RecallToolsDeps {
  /** Resolves a TenantContext-lite (just enough to hit the messages
   *  table) from a tenantId. Same shape as tool-catalog-refresh so
   *  callers can pass one shared `openTenant` shim. */
  openTenant: (tenantId: string) => {
    db: import("better-sqlite3").Database;
    tenantId: string;
  };
}

export const RECALL_TOOL_CALL_NAME = "recall_tool_call";
export const RECALL_RANGE_NAME = "recall_range";

// ─── recall_tool_call ─────────────────────────────────────────────

interface RecallToolCallArgs {
  tool_call_id: string;
}

interface MessageRow {
  id: string;
  role: string;
  content: string;
  created_at: number;
}

/**
 * Extract text and arguments blocks from a stored JSON message row.
 * Each row's `content` column is a JSON blob shaped like an
 * AgentMessage (see sqlite-session-storage.ts).
 */
function extractToolCallByCallId(
  rawContent: string,
  toolCallId: string,
): { name: string; arguments: unknown } | null {
  try {
    const j = JSON.parse(rawContent) as {
      role?: string;
      content?: Array<{
        type?: string;
        id?: string;
        name?: string;
        arguments?: unknown;
      }>;
    };
    if (j.role !== "assistant" || !Array.isArray(j.content)) return null;
    for (const part of j.content) {
      if (part?.type === "toolCall" && part.id === toolCallId) {
        return {
          name: part.name ?? "?",
          arguments: part.arguments ?? {},
        };
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

function extractToolResult(
  rawContent: string,
): { toolName: string; toolCallId: string; text: string; isError?: boolean } | null {
  try {
    const j = JSON.parse(rawContent) as {
      role?: string;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (j.role !== "toolResult") return null;
    const chunks: string[] = [];
    if (Array.isArray(j.content)) {
      for (const part of j.content) {
        if (part?.type === "text" && typeof part.text === "string") {
          chunks.push(part.text);
        }
      }
    }
    return {
      toolName: j.toolName ?? "?",
      toolCallId: j.toolCallId ?? "?",
      text: chunks.join("\n"),
      isError: j.isError,
    };
  } catch {
    return null;
  }
}

export function buildRecallToolCallTool(deps: RecallToolsDeps): AgentTool {
  return {
    schema: {
      name: RECALL_TOOL_CALL_NAME,
      description:
        "Retrieve the full arguments AND result of a specific archived tool call " +
        "by its id. Use this when older history in this session shows entries like " +
        "`[archived call: <tool_name>(id=<tc_xxx>)]` or `[archived result: ...]` " +
        "and you need the actual arguments / output to answer the user's current " +
        "question. Returns arguments + result joined as one text block.",
      parameters: Type.Object({
        tool_call_id: Type.String({
          description:
            "The tool_call_id extracted from an archived stub (e.g. `toolu_abc123`).",
        }),
      }),
    },
    execute: (raw, ctx: AgentToolContext) => {
      const args = (raw ?? {}) as unknown as RecallToolCallArgs;
      const tcid = args.tool_call_id;
      if (!tcid || typeof tcid !== "string") {
        return { ok: false, text: "recall_tool_call requires a tool_call_id string." };
      }
      const sessionId = ctx.sessionId;
      if (!sessionId) {
        return {
          ok: false,
          text: "recall_tool_call requires a chat session context.",
        };
      }
      let owning: ReturnType<typeof deps.openTenant>;
      try {
        owning = deps.openTenant(ctx.tenantId);
      } catch (err) {
        return {
          ok: false,
          text: `recall_tool_call: cannot open tenant ${ctx.tenantId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }

      // Two rows to find:
      //   - the assistant message containing the toolCall id (arguments)
      //   - the tool result message matching the same id (output)
      // Both live in `messages` under this session_id. We match by
      // scanning; the JSON is not indexed, but in practice sessions
      // rarely exceed a few thousand rows and this is a rare call.
      let rows: MessageRow[];
      try {
        rows = owning.db
          .prepare<[string, string], MessageRow>(
            `SELECT id, role, content, created_at
               FROM messages
               WHERE session_id = ?
                 AND (role = 'assistant' OR role = 'tool')
                 AND content LIKE ?
               ORDER BY created_at`,
          )
          .all(sessionId, `%${tcid}%`);
      } catch (err) {
        return {
          ok: false,
          text: `recall_tool_call: db query failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }

      let callInfo: { name: string; arguments: unknown } | null = null;
      let resultInfo:
        | { toolName: string; toolCallId: string; text: string; isError?: boolean }
        | null = null;
      for (const row of rows) {
        if (!callInfo && row.role === "assistant") {
          callInfo = extractToolCallByCallId(row.content, tcid);
        }
        if (!resultInfo && row.role === "tool") {
          const parsed = extractToolResult(row.content);
          if (parsed && parsed.toolCallId === tcid) resultInfo = parsed;
        }
        if (callInfo && resultInfo) break;
      }

      if (!callInfo && !resultInfo) {
        return {
          ok: false,
          text: `recall_tool_call: no messages in this session contain tool_call_id=${tcid}.`,
        };
      }

      const parts: string[] = [];
      if (callInfo) {
        parts.push(`## Tool call: ${callInfo.name}(id=${tcid})`);
        parts.push("");
        parts.push("### Arguments");
        parts.push("```json");
        parts.push(JSON.stringify(callInfo.arguments, null, 2));
        parts.push("```");
      } else {
        parts.push(`## Tool call: (id=${tcid}) — arguments not found`);
      }
      parts.push("");
      if (resultInfo) {
        parts.push(
          `### Result${resultInfo.isError ? " (error)" : ""} — ${resultInfo.toolName}`,
        );
        parts.push(resultInfo.text || "(empty)");
      } else {
        parts.push("### Result — not found in session");
      }

      return {
        ok: true,
        text: parts.join("\n"),
        data: {
          tool_call_id: tcid,
          hasArgs: !!callInfo,
          hasResult: !!resultInfo,
          resultBytes: resultInfo?.text.length ?? 0,
        },
      };
    },
    available(ctx: AgentToolContext) {
      // Sessionless tool invocations (unit tests) get hidden.
      return typeof ctx.sessionId === "string";
    },
  };
}

// ─── recall_range ─────────────────────────────────────────────────

interface RecallRangeArgs {
  from_turn: number;
  to_turn: number;
}

/**
 * Format one raw DB message into a readable chunk. We reconstruct the
 * essential text; tool_call arguments and tool_result bodies come back
 * verbatim (the whole point of recall_range).
 */
function formatMessageForRecall(row: MessageRow, turnIdx: number): string {
  const lines: string[] = [];
  const roleTag = row.role.toUpperCase();
  lines.push(`─── turn ${turnIdx}: ${roleTag} ───`);
  let j: {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
  };
  try {
    j = JSON.parse(row.content);
  } catch {
    lines.push(row.content);
    return lines.join("\n");
  }
  if (j.role === "user") {
    if (Array.isArray(j.content)) {
      for (const part of j.content as Array<{ type?: string; text?: string }>) {
        if (part?.type === "text" && typeof part.text === "string") lines.push(part.text);
      }
    } else if (typeof j.content === "string") {
      lines.push(j.content);
    }
  } else if (j.role === "assistant" && Array.isArray(j.content)) {
    for (const part of j.content as Array<{
      type?: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      arguments?: unknown;
    }>) {
      if (part?.type === "text" && typeof part.text === "string") {
        lines.push(part.text);
      } else if (part?.type === "toolCall") {
        lines.push(
          `[toolCall ${part.name}(id=${part.id})] ${JSON.stringify(
            part.arguments ?? {},
          )}`,
        );
      }
    }
  } else if (j.role === "toolResult") {
    lines.push(
      `[toolResult ${j.toolName}(id=${j.toolCallId})${j.isError ? " ERROR" : ""}]`,
    );
    if (Array.isArray(j.content)) {
      for (const part of j.content as Array<{ type?: string; text?: string }>) {
        if (part?.type === "text" && typeof part.text === "string") lines.push(part.text);
      }
    }
  }
  return lines.join("\n");
}

export function buildRecallRangeTool(deps: RecallToolsDeps): AgentTool {
  return {
    schema: {
      name: RECALL_RANGE_NAME,
      description:
        "Retrieve the full original messages for a range of user turns in this " +
        "session, including tool_call arguments and tool_result bodies. Use when " +
        "you need broader context than a single archived tool_call — e.g. the user " +
        "references \"the discussion from earlier\" or \"what we tried before\". " +
        "Turn 1 is the first user message. from_turn/to_turn are inclusive.",
      parameters: Type.Object({
        from_turn: Type.Number({
          description: "First user turn (1-indexed).",
        }),
        to_turn: Type.Number({
          description: "Last user turn (1-indexed, inclusive).",
        }),
      }),
    },
    execute: (raw, ctx: AgentToolContext) => {
      const args = (raw ?? {}) as unknown as RecallRangeArgs;
      const fromTurn = Math.floor(args.from_turn);
      const toTurn = Math.floor(args.to_turn);
      if (!Number.isFinite(fromTurn) || !Number.isFinite(toTurn) || fromTurn < 1) {
        return { ok: false, text: "recall_range: from_turn/to_turn must be positive integers." };
      }
      if (toTurn < fromTurn) {
        return { ok: false, text: "recall_range: to_turn must be >= from_turn." };
      }
      const sessionId = ctx.sessionId;
      if (!sessionId) return { ok: false, text: "recall_range requires a chat session." };

      let owning: ReturnType<typeof deps.openTenant>;
      try {
        owning = deps.openTenant(ctx.tenantId);
      } catch (err) {
        return {
          ok: false,
          text: `recall_range: cannot open tenant ${ctx.tenantId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }

      // Read the whole session in order; count user turns to locate
      // the desired range. Small sessions: fine. Very large sessions
      // (>10k rows) will be slow — that's acceptable given recall is
      // a rare operation.
      let rows: MessageRow[];
      try {
        rows = owning.db
          .prepare<[string], MessageRow>(
            `SELECT id, role, content, created_at FROM messages
              WHERE session_id = ? ORDER BY created_at`,
          )
          .all(sessionId);
      } catch (err) {
        return {
          ok: false,
          text: `recall_range: db read failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }

      // Walk messages; assign turnIdx to each row based on the number
      // of user messages seen so far (a user message opens a new turn).
      const chunks: string[] = [];
      let turnIdx = 0;
      let capturedBytes = 0;
      const MAX_BYTES = 200_000; // hard ceiling to protect the context
      let truncated = false;
      for (const row of rows) {
        if (row.role === "user") turnIdx++;
        if (turnIdx < fromTurn) continue;
        if (turnIdx > toTurn) break;
        const chunk = formatMessageForRecall(row, turnIdx);
        if (capturedBytes + chunk.length > MAX_BYTES) {
          truncated = true;
          break;
        }
        chunks.push(chunk);
        capturedBytes += chunk.length + 1;
      }

      if (chunks.length === 0) {
        return {
          ok: false,
          text: `recall_range: no messages found in turns ${fromTurn}-${toTurn} of this session.`,
        };
      }

      const trailer = truncated
        ? `\n\n[recall_range truncated at ${MAX_BYTES} bytes. Ask for a narrower range if you need the rest.]`
        : "";
      return {
        ok: true,
        text: chunks.join("\n\n") + trailer,
        data: {
          from_turn: fromTurn,
          to_turn: toTurn,
          messages: chunks.length,
          bytes: capturedBytes,
          truncated,
        },
      };
    },
    available(ctx: AgentToolContext) {
      return typeof ctx.sessionId === "string";
    },
  };
}
