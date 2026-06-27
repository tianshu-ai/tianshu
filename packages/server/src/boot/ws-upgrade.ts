// Chat WebSocket upgrade handler.
//
// One `connection` event \u2192 one chat session. Identity resolution
// mirrors the HTTP middleware so a browser opened with the cookie /
// query-string identity-switch overrides routes the WS to the same
// (tenant, user) the HTTP requests use. Express middleware can't run
// on WS upgrades (it expects res.setHeader + next()), so we re-run
// the same resolver chain here.
//
// Failure modes:
//   - identity resolver chain throws \u2192 stream_error + close
//   - chain denies / runs out \u2192 stream_error + close
//   - tenant_not_found (stale cookie) \u2192 try fallback to DEV_TENANT_ID
//     so the user lands somewhere usable instead of a dead socket
//   - plugin activation throws \u2192 log + proceed (plugin failures
//     surface separately in /api/plugins; they shouldn't kill chat)

import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import {
  DEV_RESOLVER_CHAIN,
  DEV_TENANT_ID,
  TenantNotFoundError,
  runIdentityChain,
} from "../core/index.js";
import type { GlobalOps } from "../core/global-ops.js";
import type { PluginRegistry } from "../core/plugins/registry.js";
import { attachChatHandler } from "../chat/handler.js";

export interface InstallChatWebSocketDeps {
  server: HttpServer;
  globalOps: GlobalOps;
  pluginRegistry: PluginRegistry;
}

/**
 * Install the `/ws` WebSocketServer on the provided HTTP server.
 * Returns the WebSocketServer for the caller to keep alive / close
 * on shutdown.
 */
export function installChatWebSocket(
  deps: InstallChatWebSocketDeps,
): WebSocketServer {
  const { server, globalOps, pluginRegistry } = deps;
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", async (socket, request) => {
    const { resolution, error: chainError } = runIdentityChain(
      request as unknown as Parameters<typeof runIdentityChain>[0],
      DEV_RESOLVER_CHAIN,
    );
    if (chainError) {
      socket.send(
        JSON.stringify({
          type: "stream_error",
          reason: `identity resolver "${chainError.resolver}" threw: ${chainError.message}`,
        }),
      );
      socket.close();
      return;
    }
    if (!resolution || resolution.kind === "deny") {
      socket.send(
        JSON.stringify({
          type: "stream_error",
          reason:
            resolution?.kind === "deny"
              ? `identity denied by ${resolution.source}: ${resolution.reason}`
              : "no identity resolver claimed this WS upgrade",
        }),
      );
      socket.close();
      return;
    }
    const tenantId = resolution.tenantId;
    const userId = resolution.userId;
    let ctx;
    try {
      ctx = globalOps.open(tenantId);
    } catch (err) {
      // tenant_not_found from a stale cookie \u2014 fall back to default
      // so the user lands somewhere usable instead of a closed
      // socket. Mirrors the HTTP middleware's tenant-not-found path.
      if (err instanceof TenantNotFoundError) {
        try {
          ctx = globalOps.open(DEV_TENANT_ID);
          socket.send(
            JSON.stringify({
              type: "identity_fallback",
              requested: tenantId,
              reason: "tenant_not_found",
              source: resolution.source,
            }),
          );
        } catch {
          socket.send(
            JSON.stringify({
              type: "stream_error",
              reason: `tenant ${tenantId} unavailable and default tenant missing`,
            }),
          );
          socket.close();
          return;
        }
      } else {
        socket.send(
          JSON.stringify({
            type: "stream_error",
            reason: `tenant ${tenantId} unavailable: ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
        socket.close();
        return;
      }
    }

    // Ensure plugins are activated so the agent can see
    // sandbox.shell etc. without waiting for a GET /api/plugins.
    try {
      await pluginRegistry.ensureForTenant(ctx);
    } catch (err) {
      // Plugin activation failures shouldn't kill the chat session;
      // they surface in /api/plugins as `state: failed`. Log and
      // proceed without the capability set.
      // eslint-disable-next-line no-console
      console.warn(
        `[tianshu] plugin activation failed for ${tenantId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    attachChatHandler({
      ctx,
      userId,
      socket,
      pluginRegistry,
      // tenantHomeDir is the per-tenant root, not the global tianshu
      // home. Mirror the worker-loop call site (host.agentLoop) which
      // passes ctx.workspaceDir. Passing globalOps.homeDir would land
      // writes from tenant_config_* tools under
      // `~/.tianshu/workspace/_tenant/...` instead of
      // `~/.tianshu/tenants/<id>/workspace/_tenant/...` \u2014 a
      // tenant-isolation hole. ADR-0001 \u00a72.
      homeDir: ctx.workspaceDir,
    });
  });

  return wss;
}
