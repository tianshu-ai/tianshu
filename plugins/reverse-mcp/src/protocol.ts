// Reverse-MCP wire protocol.
//
// Transport: the existing authenticated chat WebSocket (`/ws`). The
// bridge client connects with `Authorization: Bearer <token>` so the
// host's identity resolver chain already knows (tenantId, userId) — we
// never invent our own auth here. On top of that channel we exchange a
// THIN envelope around standard MCP JSON-RPC, so the same payloads can
// later move to a dedicated endpoint (route 2) unchanged.
//
// Direction is inverted vs. normal MCP: the SERVER is the JSON-RPC
// client (sends tools/list, tools/call), the dialed-in BRIDGE is the
// JSON-RPC server (executes locally, replies).
//
// Message types (all ride the shared /ws channel):
//   client → server:
//     reverse_mcp_register    { deviceId, tools: McpToolDescriptor[] }
//     reverse_mcp_response    { id, result? , error? }        // JSON-RPC reply
//     reverse_mcp_unregister  { }                              // graceful bye
//   server → client:
//     reverse_mcp_request     { id, method, params }           // JSON-RPC call
//     reverse_mcp_registered  { ok, deviceId }                 // ack

export const MSG = {
  register: "reverse_mcp_register",
  unregister: "reverse_mcp_unregister",
  response: "reverse_mcp_response",
  request: "reverse_mcp_request",
  registered: "reverse_mcp_registered",
  /** client → server: partial result during a streaming tool call. */
  progress: "reverse_mcp_progress",
} as const;

/** A tool the bridge advertises at register time. Mirrors the MCP
 *  `Tool` shape (name + description + JSON-schema input). */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** Whether this tool supports streaming progress updates.
   *  Declared at registration time so the host knows whether to
   *  expect `reverse_mcp_progress` messages during execution.
   *  Old bridge versions omit this (treated as false). */
  streaming?: boolean;
}

/** client → server: announce this device + the tools it offers. */
export interface RegisterMsg {
  type: typeof MSG.register;
  deviceId: string;
  /** Human label for the device, shown in the panel. */
  label?: string;
  tools: McpToolDescriptor[];
}

/** server → client: a JSON-RPC request to execute locally. */
export interface RequestMsg {
  type: typeof MSG.request;
  id: string;
  method: string; // e.g. "tools/call"
  params?: Record<string, unknown>;
}

/** client → server: a JSON-RPC reply. */
export interface ResponseMsg {
  type: typeof MSG.response;
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** client → server: partial result during a streaming tool call.
 *  The `id` matches the outstanding request. Multiple progress
 *  messages may arrive before the final `response`. */
export interface ProgressMsg {
  type: typeof MSG.progress;
  /** Request id this progress belongs to. */
  id: string;
  /** Partial result payload — opaque to the protocol layer.
   *  Typically `{ text: string }` or `{ content: [...] }`. */
  data: unknown;
}

/** Standard MCP `tools/call` params. */
export interface ToolsCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

/** Standard MCP `tools/call` result: a list of content blocks. We
 *  flatten text blocks for the agent. */
export interface ToolsCallResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
}
