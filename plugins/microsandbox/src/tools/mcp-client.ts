// Minimal MCP client over Streamable HTTP.
//
// @playwright/mcp 0.x supports two transports: legacy SSE (GET /sse +
// POST /messages?sessionId=…) and the newer "Streamable HTTP" single
// endpoint (POST /mcp). We use the latter — it's a single round-trip
// per tool call and the server returns either a JSON body or an SSE
// stream we can read until the response message arrives.
//
// We don't pull in the official @modelcontextprotocol/sdk because:
//   1. it's ~150 KB pulled into the plugin bundle for what is, at
//      this stage, four method calls (initialize, tools/list,
//      tools/call, "notifications/initialized");
//   2. Node 18+ has fetch built-in; reading SSE chunks is ~30 lines.
// If we end up calling more MCP servers we'll switch to the SDK.

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "tianshu-microsandbox", version: "0.1.0" };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result: T;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number | string;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

export interface McpToolResult {
  content?: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "resource"; resource: unknown }
  >;
  isError?: boolean;
  /** Some tools (browser_take_screenshot) return additional fields. */
  [key: string]: unknown;
}

export class McpClientError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "McpClientError";
  }
}

export class McpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private initialised = false;

  constructor(
    /** e.g. http://localhost:6701 (no trailing slash). */
    private readonly baseUrl: string,
    /** Per-call request timeout. Default 30s. */
    private readonly timeoutMs: number = 30_000,
  ) {}

  /** One-shot: open an MCP session, call a tool, close. Caller
   *  doesn't have to manage session lifecycle. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (!this.initialised) await this.initialise();
    const result = await this.request<McpToolResult>("tools/call", {
      name,
      arguments: args,
    });
    return result;
  }

  /** Returns the registered tools advertised by the server. Mostly
   *  useful for diagnostics; the host already knows tool names from
   *  manifest contributions. */
  async listTools(): Promise<{ tools: Array<{ name: string; description?: string }> }> {
    if (!this.initialised) await this.initialise();
    return this.request("tools/list", {});
  }

  // ─── internals ─────────────────────────────────────────────

  private async initialise(): Promise<void> {
    const init = await this.request<{
      protocolVersion: string;
      capabilities: Record<string, unknown>;
      serverInfo: { name: string; version: string };
    }>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: CLIENT_INFO,
    });
    if (!init.protocolVersion) {
      throw new McpClientError(
        `MCP initialize returned no protocolVersion: ${JSON.stringify(init)}`,
      );
    }
    // Send the post-init notification (per MCP spec).
    await this.notify("notifications/initialized", {});
    this.initialised = true;
  }

  private async request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new McpClientError(
        `MCP HTTP ${resp.status}: ${text.slice(0, 400)}`,
        resp.status,
      );
    }

    // Server returns Mcp-Session-Id on the initialize response.
    const newSession = resp.headers.get("Mcp-Session-Id");
    if (newSession) this.sessionId = newSession;

    const ct = resp.headers.get("content-type") ?? "";
    let envelope: JsonRpcResponse<T>;
    if (ct.includes("text/event-stream")) {
      envelope = await readJsonRpcFromSse<T>(resp, id);
    } else {
      envelope = (await resp.json()) as JsonRpcResponse<T>;
    }

    if ("error" in envelope) {
      throw new McpClientError(envelope.error.message, envelope.error.code);
    }
    return envelope.result;
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    // Notifications have no id, no response needed; we still wait
    // for the HTTP 202/200 to make sure the server saw it before
    // we send the next request.
    const resp = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new McpClientError(
        `MCP notify HTTP ${resp.status}: ${text.slice(0, 200)}`,
        resp.status,
      );
    }
    // Drain body so the connection can be reused.
    await resp.text().catch(() => "");
  }
}

/**
 * Read an SSE stream and return the first jsonrpc envelope whose `id`
 * matches the request we sent. The server may emit progress events
 * (notifications/progress) before the final response; we skip those.
 */
async function readJsonRpcFromSse<T>(
  resp: Response,
  expectId: number | string,
): Promise<JsonRpcResponse<T>> {
  if (!resp.body) throw new McpClientError("MCP SSE response had no body");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  // SSE event blocks are separated by blank lines.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let blockEnd: number;
    // eslint-disable-next-line no-cond-assign
    while ((blockEnd = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, blockEnd);
      buf = buf.slice(blockEnd + 2);
      const dataLines = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart());
      if (dataLines.length === 0) continue;
      const payload = dataLines.join("\n");
      try {
        const env = JSON.parse(payload) as JsonRpcResponse<T> & { id?: unknown };
        if (env.id === expectId) {
          // Cancel the stream so the server can drop the connection.
          reader.cancel().catch(() => {});
          return env;
        }
        // Otherwise it's a notification (id missing) or another
        // request we don't care about; keep reading.
      } catch {
        // Malformed event; ignore and keep reading.
      }
    }
  }
  throw new McpClientError("MCP SSE stream ended before response arrived");
}
