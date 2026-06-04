// WebSocket protocol for the (PR #21) minimal chat surface.
//
// Server → Client events follow the pi-ai naming so we can pass deltas
// through with zero translation later when worker streams arrive.
//
// Wire format is JSON, one message per WebSocket frame.

import type { ChatMessage } from "./messages.js";

// ─── Client → Server ──────────────────────────────────────────────

export type ClientMsg =
  | { type: "hello" }
  | { type: "history" }
  | {
      type: "prompt";
      content: string;
      /** Optional model id (e.g. 'anthropic/claude-sonnet-4-6'). When
       *  absent the server falls back to config.defaultModel. */
      modelId?: string;
    }
  | { type: "abort" };

// ─── Server → Client ──────────────────────────────────────────────

export type ServerMsg =
  | { type: "connected"; tenantId: string; userId: string }
  | { type: "history"; messages: WireMessage[] }
  | { type: "message_added"; message: WireMessage }
  | { type: "stream_start" }
  | { type: "stream_delta"; delta: string }
  | { type: "stream_end"; message: WireMessage }
  | { type: "stream_error"; reason: string }
  /** Agent invoked a tool. Sent before the tool runs so the UI can
   *  render an in-progress chip. */
  | {
      type: "tool_call";
      callId: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  /** Tool finished. `text` is the human-readable summary the LLM will
   *  see; `ok` lets the UI tint failures. */
  | {
      type: "tool_result";
      callId: string;
      name: string;
      ok: boolean;
      text: string;
    };

/** Single tool call inside an assistant message. */
export interface WireToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Tool result content surfaced for one tool call. */
export interface WireToolResult {
  callId: string;
  name: string;
  ok: boolean;
  text: string;
}

/**
 * Wire shape for one persisted message. The DB stores either a plain
 * string (legacy) or a JSON-serialised pi-ai Message; on the wire we
 * always present a clean `{ text, toolCalls?, toolResult? }` triple
 * so the UI never has to JSON.parse content itself.
 */
export interface WireMessage {
  id: string;
  sessionId: string;
  role: ChatMessage["role"];
  /** Human-readable text. Empty string for tool-only assistant turns. */
  text: string;
  /** Tool calls authored by the assistant in this message, if any. */
  toolCalls?: WireToolCall[];
  /** When this message is a tool result, the structured details. */
  toolResult?: WireToolResult;
  createdAt: number;
}

export function toWire(m: ChatMessage): WireMessage {
  const base = {
    id: m.id,
    sessionId: m.sessionId,
    role: m.role,
    createdAt: m.createdAt,
  };
  // Try parsing the content as a structured pi-ai Message; fall back
  // to treating it as plain text (legacy path).
  const parsed = tryParse(m.content);
  if (parsed && typeof parsed === "object" && parsed !== null && "role" in parsed) {
    const obj = parsed as Record<string, unknown>;
    if (obj.role === "assistant" && Array.isArray(obj.content)) {
      const text = (obj.content as Array<Record<string, unknown>>)
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      const toolCalls = (obj.content as Array<Record<string, unknown>>)
        .filter((c) => c.type === "toolCall")
        .map((c) => ({
          id: String(c.id ?? ""),
          name: String(c.name ?? ""),
          arguments: (c.arguments as Record<string, unknown>) ?? {},
        }));
      return {
        ...base,
        text,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    }
    if (obj.role === "toolResult") {
      const content = Array.isArray(obj.content) ? (obj.content as Array<Record<string, unknown>>) : [];
      const text = content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      return {
        ...base,
        text,
        toolResult: {
          callId: String(obj.toolCallId ?? ""),
          name: String(obj.toolName ?? ""),
          ok: !obj.isError,
          text,
        },
      };
    }
    if (obj.role === "user" && Array.isArray(obj.content)) {
      const text = (obj.content as Array<Record<string, unknown>>)
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      return { ...base, text };
    }
  }
  // Legacy: content is a bare string.
  return { ...base, text: m.content };
}

function tryParse(s: string): unknown {
  if (!s || s[0] !== "{") return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
