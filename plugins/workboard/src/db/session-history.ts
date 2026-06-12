// Read a worker session's transcript directly out of the shared
// `messages` table.
//
// The table is owned by the host (`packages/server/src/chat/...`)
// but its schema is part of the public migrations (001, 003), so
// reading it from a plugin isn't a layering violation — it's the
// same pattern as workboard reading `users` to look up display
// names.
//
// What we return:
//   - One entry per row, in chronological (created_at, rowid) order.
//   - role mirrored from the DB column.
//   - Raw `content` is JSON for assistant / tool-result rows and
//     either JSON or plain text for user / system rows. We try to
//     parse JSON; on failure we treat the row as plain text. The
//     output shape is opinionated for *display* (kanban Execution
//     tab, agent task_get_history) — not a verbatim re-export of
//     pi-ai's wire format.

import type { TenantDbHandle } from "@tianshu/plugin-sdk";

export type HistoryEntryRole = "user" | "assistant" | "tool" | "system";

export interface HistoryEntry {
  id: string;
  createdAt: number;
  role: HistoryEntryRole;
  /** Best-effort plain-text rendering. */
  text: string;
  /** Set on assistant rows that called tools. */
  toolCalls?: HistoryToolCall[];
  /** Set on tool-result rows. */
  toolResult?: HistoryToolResult;
}

export interface HistoryToolCall {
  callId: string;
  toolName: string;
  /** JSON string of the args (empty when no args). */
  argsJson: string;
}

export interface HistoryToolResult {
  callId: string;
  toolName: string;
  /** Best-effort. Some result envelopes don't carry an explicit ok. */
  ok?: boolean;
  text: string;
}

interface RawRow {
  id: string;
  role: string;
  content: string;
  created_at: number;
}

export function readSessionHistory(
  db: TenantDbHandle,
  sessionId: string,
): HistoryEntry[] {
  const rows = db
    .prepare<[string], RawRow>(
      `SELECT id, role, content, created_at
       FROM messages
       WHERE session_id = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(sessionId);
  return rows.map(rowToEntry);
}

function rowToEntry(row: RawRow): HistoryEntry {
  const base = {
    id: row.id,
    createdAt: row.created_at,
    role: normaliseRole(row.role),
  } as const;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.content);
  } catch {
    return { ...base, text: row.content };
  }

  if (parsed && typeof parsed === "object") {
    const obj = parsed as { content?: unknown };
    const content = obj.content;
    if (typeof content === "string") {
      return { ...base, text: content };
    }
    if (Array.isArray(content)) {
      return contentArrayToEntry(base, content);
    }
  }

  return { ...base, text: safeJson(parsed) };
}

function contentArrayToEntry(
  base: { id: string; createdAt: number; role: HistoryEntryRole },
  parts: unknown[],
): HistoryEntry {
  const textChunks: string[] = [];
  const toolCalls: HistoryToolCall[] = [];
  let toolResult: HistoryToolResult | undefined;

  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const type = typeof p.type === "string" ? p.type : "";
    switch (type) {
      case "text":
        if (typeof p.text === "string") textChunks.push(p.text);
        break;
      case "image":
        textChunks.push(
          `[image${typeof p.mimeType === "string" ? ` ${p.mimeType}` : ""}]`,
        );
        break;
      case "tool_use":
      case "toolUse": {
        const id =
          typeof p.id === "string"
            ? p.id
            : typeof p.toolUseId === "string"
              ? p.toolUseId
              : "";
        const name =
          typeof p.name === "string"
            ? p.name
            : typeof p.toolName === "string"
              ? p.toolName
              : "?";
        const input = p.input ?? p.arguments ?? p.args;
        toolCalls.push({
          callId: id,
          toolName: name,
          argsJson: input === undefined ? "" : safeJson(input),
        });
        break;
      }
      case "tool_result":
      case "toolResult": {
        const id =
          typeof p.tool_use_id === "string"
            ? p.tool_use_id
            : typeof p.toolUseId === "string"
              ? p.toolUseId
              : "";
        const name =
          typeof p.toolName === "string"
            ? p.toolName
            : typeof p.name === "string"
              ? p.name
              : "?";
        const text = renderToolResultBody(p.content);
        const okFlag = typeof p.ok === "boolean" ? p.ok : undefined;
        toolResult = {
          callId: id,
          toolName: name,
          ok: okFlag,
          text,
        };
        if (text) textChunks.push(text);
        break;
      }
      default:
        textChunks.push(`[${type || "?"}]`);
        break;
    }
  }

  return {
    ...base,
    text: textChunks.join("\n"),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(toolResult ? { toolResult } : {}),
  };
}

function renderToolResultBody(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    return content === undefined ? "" : safeJson(content);
  }
  const chunks: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      chunks.push(part);
      continue;
    }
    if (part && typeof part === "object") {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") {
        chunks.push(p.text);
        continue;
      }
    }
    chunks.push(safeJson(part));
  }
  return chunks.join("\n");
}

function normaliseRole(raw: string): HistoryEntryRole {
  if (
    raw === "user" ||
    raw === "assistant" ||
    raw === "tool" ||
    raw === "system"
  ) {
    return raw;
  }
  return "system";
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
