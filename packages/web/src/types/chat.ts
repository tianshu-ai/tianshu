// Wire shape mirrors `WireMessage` in packages/server/src/chat/ws-protocol.ts.
// Keep the two in lockstep when the server side changes.

export interface WireToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface WireToolResult {
  callId: string;
  name: string;
  ok: boolean;
  text: string;
}

export interface WireAttachment {
  /** User-home-relative path, always starts with "/". */
  path: string;
  /** RFC 6838 mime type. */
  mimeType: string;
  /** Original filename for display. */
  name?: string;
  /** Byte size on disk, when known. */
  size?: number;
}

/** Display-only metadata stamped on assistant messages. The chat
 *  shell renders these as a small line under the bubble (mirrors the
 *  closed-source predecessor). */
export interface WireMessageMeta {
  /** Provider/model id (e.g. "claude-sonnet-4-6"). */
  model?: string;
  usage?: {
    input: number;
    output: number;
    totalTokens: number;
  };
  /** Active model's context window so the client can show "X% ctx". */
  contextWindow?: number;
}

export interface WireMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "tool" | "system";
  /** Human-readable text body. May be empty for tool-only assistant turns. */
  text: string;
  /** Tool calls authored by the assistant in this message, if any. */
  toolCalls?: WireToolCall[];
  /** When this message is a tool result, the structured details. */
  toolResult?: WireToolResult;
  /** Files attached to this user message (the bytes themselves stay
   *  on disk; this is metadata for chip rendering). */
  attachments?: WireAttachment[];
  /** Assistant-only display metadata (model, token usage, context
   *  window). Undefined for user/tool rows. */
  meta?: WireMessageMeta;
  createdAt: number;
}
