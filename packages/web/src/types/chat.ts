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
  createdAt: number;
}
