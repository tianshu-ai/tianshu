/**
 * Moss-Live WebSocket proxy for tianshu server.
 * 
 * Architecture:
 *   Browser (mic/speaker) ←WS→ tianshu server ←WS→ Moss-Live API
 * 
 * The server acts as a transparent relay for audio + events, but
 * intercepts delegation events to route them to the tianshu agent.
 * 
 * Mount: GET /api/moss-live/ws → WebSocket upgrade
 * Config: tenantConfig.mossLive.apiKey
 */

import { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { TenantContext } from "../../packages/server/src/core/index.js";

const MOSS_LIVE_URL = "wss://api.mosi.cn/v1/realtime";
const MODEL = "moss-live-1.0";

interface MossLiveConfig {
  apiKey: string;
  model?: string;
  persona?: string;
  instructions?: string;
}

/**
 * Handle a WebSocket upgrade for the Moss-Live voice proxy.
 * 
 * Flow:
 * 1. Client connects → server opens upstream WS to Moss-Live
 * 2. Server sends attach_session with delegation:client
 * 3. All client messages are forwarded upstream (audio + events)
 * 4. All upstream messages are forwarded to client
 * 5. Delegation events are intercepted → routed to tianshu agent
 */
export function handleMossLiveProxy(
  clientWs: WebSocket,
  req: IncomingMessage,
  ctx: TenantContext,
  config: MossLiveConfig,
  onDelegation: (delegation: {
    sessionId: string;
    delegationId: string;
    objective: string;
    purpose: string;
    context: Array<{ role: string; content: string }>;
  }, callbacks: {
    reportProgress: (text: string, spoken?: boolean) => void;
    reportResult: (text: string) => void;
  }) => Promise<void>,
) {
  const model = config.model || MODEL;
  const upstreamUrl = `${MOSS_LIVE_URL}?model=${encodeURIComponent(model)}`;

  console.log(`[moss-live] opening upstream to ${upstreamUrl}`);

  const upstream = new WebSocket(upstreamUrl, {
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
  });

  let sessionId: string | null = null;
  let attached = false;

  // ── Upstream → Client relay ──
  upstream.on("open", () => {
    console.log("[moss-live] upstream connected");

    // Step 1: attach session with delegation
    upstream.send(JSON.stringify({
      action: "attach_session",
      delegation: { type: "client" },
    }));
  });

  upstream.on("message", (data, isBinary) => {
    // Parse text messages for delegation interception
    if (!isBinary && typeof data !== "string") {
      const str = data.toString();
      try {
        const msg = JSON.parse(str);
        handleUpstreamEvent(msg);
      } catch { /* not JSON, relay as-is */ }
    }

    // Relay everything to client
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  upstream.on("error", (err) => {
    console.error("[moss-live] upstream error:", err.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        action: "error",
        data: { code: "upstream_error", message: err.message },
      }));
    }
  });

  upstream.on("close", (code, reason) => {
    console.log(`[moss-live] upstream closed: code=${code} reason=${reason?.toString()}`);
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
    console.log("[moss-live] client disconnected");
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.close();
    }
  });

  clientWs.on("error", (err) => {
    console.error("[moss-live] client error:", err.message);
  });

  // ── Event handling ──
  function handleUpstreamEvent(msg: Record<string, unknown>) {
    const action = msg.action as string;
    const data = msg.data as Record<string, unknown> | undefined;

    // Session attached → configure persona
    if (action === "session_attached") {
      sessionId = (data?.session_id || data?.session?.id) as string;
      attached = true;
      console.log(`[moss-live] session attached: ${sessionId} delegation=${data?.delegation}`);

      // Configure persona + instructions
      if (config.persona || config.instructions) {
        upstream.send(JSON.stringify({
          action: "session.update",
          session: {
            ...(config.persona ? { persona: { prompt: config.persona } } : {}),
            ...(config.instructions ? { instructions: config.instructions } : {}),
          },
        }));
      }
    }

    // Delegation created → route to tianshu agent
    if (action === "session.delegation.created") {
      const delegation = data?.delegation as Record<string, unknown> | undefined;
      if (!delegation) return;

      const delegationId = delegation.id as string;
      const objective = delegation.objective as string;
      const purpose = (delegation.purpose as string) || "task";
      const context = (delegation.context as Array<{ role: string; content: string }>) || [];

      console.log(`[moss-live] delegation created: id=${delegationId} objective=${objective?.slice(0, 60)}`);

      // Route to tianshu agent
      onDelegation(
        { sessionId: sessionId!, delegationId, objective, purpose, context },
        {
          reportProgress: (text: string, spoken = false) => {
            if (upstream.readyState !== WebSocket.OPEN) return;
            upstream.send(JSON.stringify({
              action: spoken ? "session.commentary.append" : "session.thinking.append",
              delegation_id: delegationId,
              ...(spoken
                ? { commentary: { text, status: "in_progress" } }
                : { thinking: { text } }),
            }));
          },
          reportResult: (text: string) => {
            if (upstream.readyState !== WebSocket.OPEN) return;
            upstream.send(JSON.stringify({
              action: "session.commentary.append",
              delegation_id: delegationId,
              commentary: { text, status: "completed" },
            }));
          },
        },
      ).catch((err) => {
        console.error(`[moss-live] delegation failed: ${err.message}`);
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(JSON.stringify({
            action: "session.commentary.append",
            delegation_id: delegationId,
            commentary: { text: `执行失败: ${err.message}`, status: "failed" },
          }));
        }
      });
    }

    // Delegation cancelled
    if (action === "session.delegation.cancelled") {
      const delegationId = (data?.delegation as Record<string, unknown>)?.id as string;
      console.log(`[moss-live] delegation cancelled: ${delegationId}`);
    }
  }
}
