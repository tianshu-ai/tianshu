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

export interface WireMessage {
  id: string;
  sessionId: string;
  role: ChatMessage["role"];
  content: string;
  createdAt: number;
}

export function toWire(m: ChatMessage): WireMessage {
  return {
    id: m.id,
    sessionId: m.sessionId,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
  };
}
