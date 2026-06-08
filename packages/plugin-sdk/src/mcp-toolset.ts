// McpToolset — direct mount of an MCP server's tools as agent tools.
//
// Built on top of the official `@modelcontextprotocol/sdk` Client
// + StreamableHTTPClientTransport. The SDK handles protocol
// versioning, SSE handshakes, reconnect, OAuth, etc.; we plug in
// a node:http-backed `fetch` shim so a caller-supplied Host header
// is honoured (Node's undici fetch otherwise drops it — see
// `mcp-fetch.ts`).
//
// Why this exists at all: hand-writing one AgentTool wrapper per
// upstream MCP tool (as N+5.3 did for navigate/snapshot/screenshot)
// burns engineering time and only ever exposes a curated subset.
// MCP's whole point is uniform self-description: every server
// advertises its tools through `tools/list` with a JSON-Schema
// input, so the host can reflect them into AgentTools at activation
// time.
//
// Plugin authors use it like this:
//
//   const toolset = new McpToolset({
//     name: "playwright",
//     prefix: "",                                  // upstream already names tools `browser_*`
//     resolve: () => sidecar.mcpHostPort()
//       ? `http://127.0.0.1:${sidecar.mcpHostPort()}/mcp`
//       : undefined,
//     upstreamHost: "localhost:3200",              // pin the Host header
//   });
//   await toolset.refresh();
//   ...
//   exports.toolsetProviders = { playwright: toolset };

import type {
  AgentTool,
  AgentToolContext,
  ToolResult,
} from "./server.js";
import { errorResult, okResult } from "./server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeNodeHttpFetch } from "./mcp-fetch.js";

/** One entry from an MCP server's tools/list response. We keep the
 *  fields the host actually surfaces in the admin MCP page; the SDK
 *  exposes more (`annotations`, `outputSchema`) which we ignore. */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** Resolver for the upstream MCP base URL. Returns undefined when
 *  the upstream isn't ready yet (e.g. sandbox still booting). */
export type McpEndpointResolver = () =>
  | string
  | undefined
  | Promise<string | undefined>;

export interface McpToolFilter {
  /** Inclusive allowlist by upstream tool name. */
  allow?: string[];
  /** Exclusive denylist by upstream tool name. Applied after allow. */
  deny?: string[];
  /** Arbitrary predicate. Wins after allow + deny. */
  filter?(t: McpToolDescriptor): boolean;
}

export interface McpToolsetOptions {
  /** Display name of this MCP server, e.g. "playwright" or
   *  "filesystem". Surfaced through the admin MCP servers view. */
  name: string;
  /** Prefix prepended to every reflected tool name to avoid
   *  collisions. Defaults to `<name>_`. Pass `""` to disable
   *  prefixing (e.g. when upstream already namespaces its tools). */
  prefix?: string;
  /** Resolves the base URL of the upstream MCP server. Returns
   *  undefined when the server isn't reachable yet. The URL should
   *  point at the Streamable HTTP endpoint; for Playwright MCP that
   *  is `<base>/mcp`. */
  resolve: McpEndpointResolver;
  /** Override the upstream Host header. Most MCP servers bind to
   *  `localhost:<port>` and validate the Host header against it.
   *  When the host process connects via a port forward the URL host
   *  doesn't match, so callers pin the upstream's bound address
   *  here. Defaults to undefined (use whatever the URL implies,
   *  i.e. trust Node fetch). */
  upstreamHost?: string;
  /** Optional name allowlist/denylist/predicate. Applied to the
   *  raw MCP tool list before reflection. */
  filter?: McpToolFilter;
  /** Optional per-tool description override. Returning undefined
   *  means "keep upstream description as-is". */
  describe?(t: McpToolDescriptor): string | undefined;
  /** Per-call request timeout in ms. Used for both refresh and
   *  callTool. Default 60s. */
  callTimeoutMs?: number;
  /** Client identity for the MCP handshake. Defaults to
   *  `{ name: "tianshu", version: "0" }`. */
  clientInfo?: { name: string; version: string };
}

/** Snapshot of one tool exposed by this toolset. */
export interface McpToolsetEntry {
  /** Reflected `prefix + upstream.name`. This is what the model sees. */
  toolName: string;
  /** Raw upstream descriptor, untouched. */
  upstream: McpToolDescriptor;
}

/** Snapshot of toolset health for diagnostics + admin views. */
export interface McpToolsetSnapshot {
  name: string;
  prefix: string;
  /** Resolved upstream URL on the last refresh. Undefined while the
   *  upstream is unreachable. */
  endpoint: string | undefined;
  /** Tools advertised on the last successful refresh. Empty until
   *  the first refresh succeeds. */
  tools: McpToolsetEntry[];
  /** ms since epoch of the last refresh attempt. */
  lastRefreshAt: number | undefined;
  /** Last refresh error. Cleared after a successful refresh. */
  lastError: string | undefined;
}

/**
 * The host calls `listTools()` every turn. Provider interface kept
 * narrow so a plugin can supply a static AgentTool[] provider too
 * without coupling to McpToolset.
 */
export interface ToolsetProvider {
  readonly name: string;
  snapshot?(): McpToolsetSnapshot;
  listTools(): AgentTool[];
}

/** Reflective MCP toolset. Holds a short-lived SDK Client per
 *  refresh / call (so we don't keep an idle SSE stream open). */
export class McpToolset implements ToolsetProvider {
  readonly name: string;
  readonly prefix: string;
  private readonly resolve: McpEndpointResolver;
  private readonly upstreamHost: string | undefined;
  private readonly filter: McpToolFilter | undefined;
  private readonly describe:
    | ((t: McpToolDescriptor) => string | undefined)
    | undefined;
  private readonly callTimeoutMs: number;
  private readonly clientInfo: { name: string; version: string };

  private endpoint: string | undefined;
  private entries: McpToolsetEntry[] = [];
  private lastRefreshAt: number | undefined;
  private lastError: string | undefined;
  private refreshing: Promise<void> | null = null;

  constructor(opts: McpToolsetOptions) {
    this.name = opts.name;
    this.prefix = opts.prefix ?? `${opts.name}_`;
    this.resolve = opts.resolve;
    this.upstreamHost = opts.upstreamHost;
    this.filter = opts.filter;
    this.describe = opts.describe;
    this.callTimeoutMs = opts.callTimeoutMs ?? 60_000;
    this.clientInfo = opts.clientInfo ?? { name: "tianshu", version: "0" };
  }

  snapshot(): McpToolsetSnapshot {
    return {
      name: this.name,
      prefix: this.prefix,
      endpoint: this.endpoint,
      tools: [...this.entries],
      lastRefreshAt: this.lastRefreshAt,
      lastError: this.lastError,
    };
  }

  /** Cheap, no-network. Returns the last successfully reflected
   *  tool list. */
  listTools(): AgentTool[] {
    return this.entries.map((e) => this.entryToAgentTool(e));
  }

  /** Pull a fresh `tools/list` from upstream. Single-flight; errors
   *  are recorded but don't yank previously-reflected tools out. */
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const url = await this.resolve();
        this.endpoint = url;
        this.lastRefreshAt = Date.now();
        if (!url) {
          this.entries = [];
          this.lastError = "endpoint not available";
          return;
        }
        const list = await this.withClient(async (client) => {
          const r = await client.listTools();
          return r.tools as McpToolDescriptor[];
        });
        this.entries = (list ?? [])
          .filter((t) => this.includes(t))
          .map((t) => ({ toolName: this.prefix + t.name, upstream: t }));
        this.lastError = undefined;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        // Keep previous entries — partial outage shouldn't yank
        // tools mid-conversation.
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  // ─── internals ─────────────────────────────────────────────

  private includes(t: McpToolDescriptor): boolean {
    if (!this.filter) return true;
    if (this.filter.allow && !this.filter.allow.includes(t.name)) return false;
    if (this.filter.deny && this.filter.deny.includes(t.name)) return false;
    if (this.filter.filter && !this.filter.filter(t)) return false;
    return true;
  }

  private entryToAgentTool(entry: McpToolsetEntry): AgentTool {
    const { toolName, upstream } = entry;
    const description =
      (this.describe && this.describe(upstream)) ??
      upstream.description ??
      `MCP tool ${upstream.name}`;
    const parameters: Record<string, unknown> = upstream.inputSchema ?? {
      type: "object",
      properties: {},
    };
    return {
      schema: {
        name: toolName,
        description,
        // pi-ai's Tool type accepts a JSON Schema object on
        // `parameters`; the cast keeps the SDK lean of typebox.
        parameters: parameters as never,
      },
      execute: async (args, ctx) => this.callRemote(upstream.name, args, ctx),
    };
  }

  private async callRemote(
    upstreamName: string,
    args: Record<string, unknown>,
    ctx: AgentToolContext,
  ): Promise<ToolResult> {
    if (!this.endpoint) {
      return errorResult(
        `MCP server "${this.name}" has no endpoint (sandbox booting?). lastError=${
          this.lastError ?? "unknown"
        }`,
      );
    }
    try {
      const res = await this.withClient(async (client) => {
        return client.callTool({
          name: upstreamName,
          arguments: args,
        });
      });
      const content = (res as { content?: unknown }).content;
      const isError = (res as { isError?: boolean }).isError === true;
      const text = textOfMcpContent(content) || "(empty response)";
      return isError
        ? errorResult(text, res)
        : okResult(text, res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log.warn(
        `mcp toolset "${this.name}" callTool ${upstreamName} failed: ${msg}`,
      );
      return errorResult(`MCP call ${this.name}.${upstreamName} failed: ${msg}`);
    }
  }

  /** Open a short-lived MCP Client + transport, run `fn`, close.
   *  Connection cost is dominated by the JSON-RPC `initialize` round
   *  trip; for our use case (one tools/list per refresh, one
   *  tools/call per agent action) re-handshaking is fine and avoids
   *  the headache of long-lived SSE state across plugin reloads. */
  private async withClient<T>(
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    if (!this.endpoint) throw new Error("endpoint not resolved");
    const url = new URL(this.endpoint);
    const fetchImpl = this.upstreamHost
      ? makeNodeHttpFetch(this.upstreamHost)
      : undefined;
    const transport = new StreamableHTTPClientTransport(url, {
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    const client = new Client(this.clientInfo, {
      // We don't need server-initiated requests for tools-only use.
      capabilities: {},
    });
    try {
      await client.connect(transport, { timeout: this.callTimeoutMs });
      return await fn(client);
    } finally {
      try {
        await transport.close();
      } catch {
        // best-effort
      }
    }
  }
}

/** Pull text content blocks out of an MCP tool result. Inline image
 *  / resource blocks are summarised so the agent at least sees the
 *  shape; structured payload is preserved on `data` by the caller. */
export function textOfMcpContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: string; text?: unknown; mimeType?: unknown };
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      } else if (b.type === "image") {
        const mime = typeof b.mimeType === "string" ? b.mimeType : "image";
        parts.push(`[${mime} image]`);
      } else if (b.type === "resource") {
        parts.push("[resource]");
      }
    }
  }
  return parts.join("\n\n");
}
