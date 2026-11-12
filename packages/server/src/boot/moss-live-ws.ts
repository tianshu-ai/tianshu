/**
 * Moss-Live realtime voice WebSocket proxy.
 *
 * Browser ←WS /moss-live→ tianshu server ←WS→ Moss-Live API
 *
 * The server relays audio + events bidirectionally and intercepts
 * delegation events to route them to the tianshu agent.
 */

import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  runIdentityChain,
  buildResolverChain,
  loadGlobalConfig,
  DEV_TENANT_ID,
  TenantNotFoundError,
} from "../core/index.js";
import type { GlobalOps } from "../core/global-ops.js";
import type { MossLiveConfig } from "../core/config.js";
import type { TenantContext } from "../core/tenant-context.js";
import { createLogger } from "../setup/logger.js";

const log = createLogger("moss-live");

const MOSS_LIVE_URL = "wss://api.mosi.cn/v1/realtime";
const DEFAULT_MODEL = "moss-live-1.0";

export interface InstallMossLiveWsDeps {
  server: HttpServer;
  globalOps: GlobalOps;
}

export function installMossLiveWebSocket(
  deps: InstallMossLiveWsDeps,
): WebSocketServer {
  const { server, globalOps } = deps;
  const wss = new WebSocketServer({ server, path: "/moss-live" });

  wss.on("connection", async (clientWs, request) => {
    // ── Identity resolution (same as chat WS) ──
    const { resolution, error: chainError } = runIdentityChain(
      request as unknown as Parameters<typeof runIdentityChain>[0],
      buildResolverChain(loadGlobalConfig().auth),
    );
    if (chainError || !resolution || resolution.kind === "deny") {
      clientWs.send(JSON.stringify({
        type: "stream_error",
        reason: chainError
          ? `identity resolver "${chainError.resolver}" threw: ${chainError.message}`
          : resolution?.kind === "deny"
            ? `denied by ${resolution.source}: ${resolution.reason}`
            : "no identity resolver claimed this WS upgrade",
      }));
      clientWs.close();
      return;
    }

    const tenantId = resolution.tenantId;
    let ctx: TenantContext;
    try {
      ctx = globalOps.open(tenantId);
    } catch (err) {
      if (err instanceof TenantNotFoundError) {
        try { ctx = globalOps.open(DEV_TENANT_ID); } catch {
          clientWs.send(JSON.stringify({ type: "stream_error", reason: "tenant unavailable" }));
          clientWs.close();
          return;
        }
      } else {
        clientWs.send(JSON.stringify({ type: "stream_error", reason: String(err) }));
        clientWs.close();
        return;
      }
    }

    // ── Read Moss-Live config ──
    const config: MossLiveConfig | undefined = ctx.config.mossLive;
    if (!config?.apiKey) {
      clientWs.send(JSON.stringify({
        type: "stream_error",
        reason: "Moss-Live API key not configured. Go to Settings → Voice to add your key.",
      }));
      clientWs.close();
      return;
    }

    log.info(`[moss-live] new session for tenant=${tenantId} user=${resolution.userId}`);

    // ── Open upstream WS to Moss-Live ──
    const model = config.model || DEFAULT_MODEL;
    const upstreamUrl = `${MOSS_LIVE_URL}?model=${encodeURIComponent(model)}`;

    const upstream = new WebSocket(upstreamUrl, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });

    let sessionId: string | null = null;

    // ── Upstream lifecycle ──
    upstream.on("open", () => {
      log.info("[moss-live] upstream connected");
      upstream.send(JSON.stringify({
        action: "attach_session",
        delegation: { type: "client" },
      }));
    });

    upstream.on("message", (data, isBinary) => {
      // Intercept text messages for delegation handling
      if (!isBinary) {
        const str = data.toString();
        try {
          const msg = JSON.parse(str);
          handleUpstreamEvent(msg, upstream, ctx);
        } catch { /* not JSON */ }
      }
      // Relay everything to client
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
    });

    upstream.on("error", (err) => {
      log.error(`[moss-live] upstream error: ${err.message}`);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          action: "error",
          data: { code: "upstream_error", message: err.message },
        }));
      }
    });

    upstream.on("close", (code, reason) => {
      log.info(`[moss-live] upstream closed: code=${code}`);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(code, reason);
      }
    });

    // ── Client → Upstream relay ──
    clientWs.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      }
    });

    clientWs.on("close", () => {
      log.info("[moss-live] client disconnected");
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    });

    clientWs.on("error", (err) => {
      log.error(`[moss-live] client error: ${err.message}`);
    });

    // ── Event handling ──
    function handleUpstreamEvent(
      msg: Record<string, unknown>,
      ws: WebSocket,
      _ctx: TenantContext,
    ) {
      const action = msg.action as string;
      const data = msg.data as Record<string, unknown> | undefined;

      if (action === "session_attached") {
        sessionId = data?.session_id as string ?? null;
        log.info(`[moss-live] session attached: ${sessionId}`);

        // Configure persona + instructions
        const update: Record<string, unknown> = {};
        if (config!.persona) update.persona = { prompt: config!.persona };
        if (config!.instructions) update.instructions = config!.instructions;
        if (Object.keys(update).length > 0) {
          ws.send(JSON.stringify({ action: "session.update", session: update }));
        }
      }

      // ── Delegation: route to tianshu agent ──
      if (action === "session.delegation.created") {
        const delegation = data?.delegation as Record<string, unknown> | undefined;
        if (!delegation) return;

        const delegationId = delegation.id as string;
        const objective = delegation.objective as string;
        const purpose = (delegation.purpose as string) || "task";
        const context = (delegation.context as Array<{ role: string; content: string }>) || [];

        log.info(`[moss-live] delegation: id=${delegationId} objective=${objective?.slice(0, 80)}`);

        // TODO: route to tianshu agent via chat handler
        // For now, echo back a simple response
        executeDelegation(ws, delegationId, objective, purpose, context);
      }

      if (action === "session.delegation.cancelled") {
        const delegationId = (data?.delegation as Record<string, unknown>)?.id as string;
        log.info(`[moss-live] delegation cancelled: ${delegationId}`);
        // TODO: abort running agent task
      }
    }
  });

  return wss;
}

/**
 * Execute a delegation by routing to the tianshu agent.
 * Phase 1: simple echo. Phase 2: wire to actual agent loop.
 */
async function executeDelegation(
  upstream: WebSocket,
  delegationId: string,
  objective: string,
  _purpose: string,
  _context: Array<{ role: string; content: string }>,
) {
  try {
    // Report progress
    sendAppend(upstream, delegationId, "thinking", `正在处理: ${objective.slice(0, 100)}`);

    // TODO Phase 2: create a temporary agent session, send the objective
    // as a user message, stream tool calls + results back as
    // thinking/commentary appends, and return the final answer.

    // Phase 1: echo back
    sendAppend(upstream, delegationId, "commentary", `收到任务: ${objective}`, "completed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[moss-live] delegation failed: ${msg}`);
    sendAppend(upstream, delegationId, "commentary", `执行失败: ${msg}`, "failed");
  }
}

function sendAppend(
  ws: WebSocket,
  delegationId: string,
  type: "thinking" | "commentary",
  text: string,
  status?: "in_progress" | "completed" | "failed",
) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const payload: Record<string, unknown> = {
    action: type === "thinking" ? "session.thinking.append" : "session.commentary.append",
    delegation_id: delegationId,
  };
  if (type === "thinking") {
    payload.thinking = { text };
  } else {
    payload.commentary = { text, status: status || "in_progress" };
  }
  ws.send(JSON.stringify(payload));
}
