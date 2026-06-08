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
//   2. node:http reads SSE chunks in ~30 lines.
// If we end up calling more MCP servers we'll switch to the SDK.
//
// Why node:http and not Node's built-in fetch? Playwright MCP
// validates the Host request header against its bound address
// (default "localhost:<port>") and 403's mismatches with
// `Access is only allowed at localhost:<port>`. We're behind a
// per-tenant microsandbox port forward, so the upstream host
// (e.g. 127.0.0.1:58474) is never "localhost:3200". Setting
// `Host: localhost:3200` is the right answer — but Node's undici
// fetch implementation silently overrides any caller-supplied Host
// header with the URL's host (see undici's `Request` validation).
// node:http lets us set Host explicitly, so we use that. The MCP
// server itself can stay locked to localhost — no need to widen
// `--allowed-hosts` in the sandboxfile.

import { request as httpRequest, type IncomingMessage } from "node:http";

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
  private readonly host: string;
  private readonly port: number;
  /** Host header to send. Always the MCP server's bound address
   *  inside the sandbox (default localhost:3200), regardless of
   *  whatever forwarded port we connect to from the host. */
  private readonly hostHeader: string;

  constructor(
    /** e.g. http://localhost:6701 (no trailing slash). */
    private readonly baseUrl: string,
    /** Per-call request timeout. Default 30s. */
    private readonly timeoutMs: number = 30_000,
    /** Override the upstream MCP server's bound Host. Defaults to
     *  `localhost:3200` which is what the supervisord-managed
     *  Playwright MCP listens on inside browser.yaml's VM. */
    upstreamHost: string = "localhost:3200",
  ) {
    const u = new URL(baseUrl);
    this.host = u.hostname;
    this.port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    this.hostHeader = upstreamHost;
  }

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

    const { res, status, headers: respHeaders } = await this.send(
      headers,
      JSON.stringify(body),
    );

    if (status < 200 || status >= 300) {
      const text = await drain(res).catch(() => "");
      throw new McpClientError(
        `MCP HTTP ${status}: ${text.slice(0, 400)}`,
        status,
      );
    }

    // Server returns Mcp-Session-Id on the initialize response.
    const newSession = respHeaders["mcp-session-id"];
    if (typeof newSession === "string") this.sessionId = newSession;

    const ct = (respHeaders["content-type"] ?? "") as string;
    let envelope: JsonRpcResponse<T>;
    if (ct.includes("text/event-stream")) {
      envelope = await readJsonRpcFromSse<T>(res, id);
    } else {
      const buf = await drain(res);
      envelope = JSON.parse(buf) as JsonRpcResponse<T>;
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
    const { res, status } = await this.send(
      headers,
      JSON.stringify({ jsonrpc: "2.0", method, params }),
    );
    if (status < 200 || status >= 300) {
      const text = await drain(res).catch(() => "");
      throw new McpClientError(
        `MCP notify HTTP ${status}: ${text.slice(0, 200)}`,
        status,
      );
    }
    // Drain body so the connection can be reused.
    await drain(res).catch(() => "");
  }

  /** Send a single POST to /mcp using node:http, with the Host
   *  header pinned to the upstream MCP's bound address. */
  private send(
    headers: Record<string, string>,
    body: string,
  ): Promise<{
    res: IncomingMessage;
    status: number;
    headers: NodeJS.Dict<string | string[]>;
  }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: this.host,
          port: this.port,
          path: "/mcp",
          method: "POST",
          headers: {
            Host: this.hostHeader,
            "Content-Length": Buffer.byteLength(body),
            ...headers,
          },
        },
        (res) => {
          resolve({
            res,
            status: res.statusCode ?? 0,
            headers: res.headers,
          });
        },
      );
      req.on("error", reject);
      const timer = setTimeout(() => {
        req.destroy(new Error(`MCP request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      req.on("close", () => clearTimeout(timer));
      req.write(body);
      req.end();
    });
  }
}

async function drain(res: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of res) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read an SSE stream and return the first jsonrpc envelope whose `id`
 * matches the request we sent. The server may emit progress events
 * (notifications/progress) before the final response; we skip those.
 */
async function readJsonRpcFromSse<T>(
  res: IncomingMessage,
  expectId: number | string,
): Promise<JsonRpcResponse<T>> {
  let buf = "";
  for await (const chunk of res) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
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
          // Drop the connection so the server stops streaming.
          res.destroy();
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
