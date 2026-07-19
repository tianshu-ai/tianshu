// reverse-mcp plugin — server side.
//
// A bridge client connects to the existing authenticated chat
// WebSocket (`/ws`) with `Authorization: Bearer <token>`, so the host's
// identity resolver chain has already established (tenantId, userId) and
// stamped `userId` on the socket. The client then sends
// `reverse_mcp_register` advertising the tools it can run locally; the
// agent calls them via a ToolsetProvider that does a JSON-RPC round-trip
// back over the same socket (`reverse_mcp_request` / `_response`).
//
// This is route 1 (reuse /ws) + scheme 1a (Bearer session token): zero
// new endpoints, auth reused. The envelope is a thin wrapper around
// standard MCP JSON-RPC so it can later move to a dedicated endpoint.

import type {
  PluginContext,
  PluginServerExports,
  PluginServerModule,
  PluginRouteHandler,
  PluginWsHandler,
  BridgeTokenCapability,
} from "@tianshu-ai/plugin-sdk";
import type { WebSocket } from "ws";
import { BridgeRegistry } from "./registry.js";
import { makeBridgeToolset } from "./toolset.js";
import {
  MSG,
  type McpToolDescriptor,
  type RegisterMsg,
  type ResponseMsg,
} from "./protocol.js";

/** Read the identity the host stamped on the chat socket. */
function socketUserId(socket: WebSocket): string {
  return (socket as unknown as { userId?: string }).userId ?? "";
}

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    const registry = new BridgeRegistry();

    // client → server: register a device + its tools.
    const onRegister: PluginWsHandler = (msg, socket) => {
      const userId = socketUserId(socket);
      if (!userId) {
        socket.send(
          JSON.stringify({ type: MSG.registered, ok: false, error: "no user identity on socket" }),
        );
        return;
      }
      const m = msg as unknown as RegisterMsg;
      const deviceId = typeof m.deviceId === "string" && m.deviceId ? m.deviceId : "default";
      const tools: McpToolDescriptor[] = Array.isArray(m.tools)
        ? m.tools.filter((t) => t && typeof t.name === "string")
        : [];
      registry.register({ userId, deviceId, label: m.label, socket, tools });
      ctx.log.info(
        `bridge registered: user=${userId} device=${deviceId} tools=${tools.length}`,
      );
      socket.send(JSON.stringify({ type: MSG.registered, ok: true, deviceId }));
      // Let panels refresh.
      ctx.broadcast("connections_changed", { userId });
    };

    // client → server: a JSON-RPC reply to a request we sent.
    const onResponse: PluginWsHandler = (msg, socket) => {
      const m = msg as unknown as ResponseMsg;
      if (typeof m.id !== "string") return;
      registry.settle(socket, m.id, m.result, m.error);
    };

    // client → server: graceful unregister.
    const onUnregister: PluginWsHandler = (_msg, socket) => {
      registry.removeBySocket(socket);
      ctx.broadcast("connections_changed", {});
    };

    // Clean up when a bridge socket drops. wsHandlers don't get a
    // close event, so we can't hook it here directly; instead the
    // registry.settle/forUser paths tolerate dead sockets, and a
    // dropped socket is pruned on the next failed send. (A future
    // core hook can call removeBySocket on close.)

    const toolset = makeBridgeToolset({ registry, log: ctx.log });

    // Panel/debug: list this user's connected devices + tool counts.
    const listConnections: PluginRouteHandler = (req, res) => {
      const userId = (req as { ctx?: { userId?: string } }).ctx?.userId ?? "";
      if (!userId) return void res.status(401).json({ error: "no user context" });
      const conns = registry.forUser(userId).map((c) => ({
        deviceId: c.deviceId,
        label: c.label,
        connectedAt: c.connectedAt,
        tools: c.tools.map((t) => t.name),
      }));
      res.json({ connections: conns });
    };

    // Panel: everything needed to start a local bridge — the WS URL,
    // a freshly-minted connection token, and a ready-to-run command.
    const connectInfo: PluginRouteHandler = (req, res) => {
      const userId = (req as { ctx?: { userId?: string } }).ctx?.userId ?? "";
      if (!userId) return void res.status(401).json({ error: "no user context" });
      // Derive the public wss:// URL from the incoming request so it
      // works behind a tunnel/proxy (Cloudflare sets X-Forwarded-*).
      const fwdProto =
        (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
      const host =
        (req.headers["x-forwarded-host"] as string | undefined) ||
        (req.headers.host as string | undefined) ||
        "localhost";
      const secure = fwdProto ? fwdProto === "https" : false;
      const wsScheme = secure ? "wss" : "ws";
      const wsUrl = `${wsScheme}://${host}/ws`;

      const minter = ctx.capabilities.get<BridgeTokenCapability>("host.bridgeToken");
      const grant = minter?.mint(userId) ?? {
        token: "",
        authEnabled: false,
        expiresAt: null,
      };
      const tokenArg = grant.authEnabled ? ` --token ${grant.token}` : "";
      const command = `npx @tianshu-ai/local-bridge --server ${wsUrl}${tokenArg}`;
      res.json({
        wsUrl,
        authEnabled: grant.authEnabled,
        token: grant.token,
        expiresAt: grant.expiresAt,
        command,
      });
    };

    ctx.log.info("reverse-mcp activated");
    return {
      wsHandlers: {
        onRegister,
        onResponse,
        onUnregister,
      },
      toolsetProviders: {
        BridgeToolset: toolset,
      },
      routes: {
        listConnections,
        connectInfo,
      },
    };
  },
  async deactivate() {
    /* connections are per-socket; they drop when the sockets close */
  },
};

export const activate = plugin.activate.bind(plugin);
export const deactivate = plugin.deactivate?.bind(plugin);
export default plugin;
