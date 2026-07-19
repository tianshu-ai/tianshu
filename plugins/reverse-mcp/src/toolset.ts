// A ToolsetProvider backed by the dialed-in bridge connections. The
// host calls listTools() every agent turn, so tools appear/disappear as
// bridges connect/disconnect with no plugin reactivation.
//
// Each bridge tool becomes an AgentTool named `bridge_<device>_<tool>`.
// `available()` hides it from users who don't own that bridge; the
// tenant scope is already fixed (this provider is created per-tenant).
// `execute()` does the async JSON-RPC round-trip to the owning device.

import type {
  AgentTool,
  AgentToolContext,
  ToolResult,
  ToolsetProvider,
} from "@tianshu-ai/plugin-sdk";
import { okResult, errorResult } from "@tianshu-ai/plugin-sdk";
import type { BridgeRegistry, BridgeConn } from "./registry.js";
import type { McpToolDescriptor, ToolsCallResult } from "./protocol.js";

/** Sanitise a device/tool id into a tool-name-safe token. */
function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

/** Fully-qualified agent tool name for a bridge tool. */
export function toolName(deviceId: string, tool: string): string {
  return `bridge_${slug(deviceId)}_${slug(tool)}`;
}

/** Flatten an MCP tools/call result into a short text summary. */
function renderResult(res: ToolsCallResult): ToolResult {
  const parts = (res.content ?? [])
    .map((c) => (typeof c.text === "string" ? c.text : c.type ? `[${c.type}]` : ""))
    .filter(Boolean);
  const text = parts.join("\n").trim() || "(no content)";
  return res.isError ? errorResult(text, res) : okResult(text, res);
}

export function makeBridgeToolset(args: {
  registry: BridgeRegistry;
  log: { info: (m: string) => void; warn: (m: string) => void };
}): ToolsetProvider {
  const { registry } = args;
  return {
    name: "bridge",
    listTools(): AgentTool[] {
      // Every tool on every currently-connected bridge in this tenant.
      // Cross-user leakage is prevented by each tool's available()
      // (userId check) — listTools() has no user context, but the host
      // runs available(ctx) per turn with the calling user's ctx.
      const tools: AgentTool[] = [];
      // Collect (conn, tool) pairs across all users in the tenant.
      const conns = collectAllConns(registry);
      for (const conn of conns) {
        for (const t of conn.tools) {
          tools.push(buildTool(registry, conn.userId, conn.deviceId, t));
        }
      }
      return tools;
    },
  };
}

// The registry is tenant-scoped but only exposes forUser(); gather
// every connection by scanning a snapshot the registry can provide.
function collectAllConns(registry: BridgeRegistry): BridgeConn[] {
  return registry.all();
}

function buildTool(
  registry: BridgeRegistry,
  userId: string,
  deviceId: string,
  desc: McpToolDescriptor,
): AgentTool {
  const parameters =
    desc.inputSchema && typeof desc.inputSchema === "object"
      ? (desc.inputSchema as Record<string, unknown>)
      : { type: "object", properties: {}, additionalProperties: true };
  return {
    schema: {
      name: toolName(deviceId, desc.name),
      description:
        (desc.description ?? `Local bridge tool "${desc.name}" on device "${deviceId}".`) +
        ` (Runs on the user's own machine via the Local Bridge device "${deviceId}".)`,
      parameters: parameters as never,
    },
    // Only the user who owns this bridge may see/call it.
    available(ctx: AgentToolContext): boolean {
      return ctx.userId === userId;
    },
    async execute(rawArgs: Record<string, unknown>, ctx: AgentToolContext): Promise<ToolResult> {
      if (ctx.userId !== userId) {
        return errorResult("This bridge tool belongs to a different user.");
      }
      const conn = registry
        .forUser(userId)
        .find((c) => c.deviceId === deviceId);
      if (!conn) {
        return errorResult(
          `Local Bridge device "${deviceId}" is not connected. Start the bridge client and try again.`,
        );
      }
      try {
        const result = await registry.call(conn, "tools/call", {
          name: desc.name,
          arguments: rawArgs,
        });
        return renderResult((result ?? {}) as ToolsCallResult);
      } catch (err) {
        return errorResult(
          `Local Bridge call failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
