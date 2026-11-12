/**
 * Moss-Live realtime voice — tunneled through the chat WebSocket.
 *
 * Instead of a separate /moss-live WebSocket path (which conflicts
 * with Vite dev proxy), we tunnel moss-live events through the
 * existing /ws chat connection:
 *
 *   Client sends: { type: "moss_live_start" }
 *   Server opens upstream WS to Moss-Live API
 *   Client sends: { type: "moss_live_event", event: {...} }
 *   Server forwards to upstream
 *   Upstream sends event → Server wraps as { type: "moss_live_event", event: {...} }
 *   Client sends: { type: "moss_live_stop" }
 *   Server closes upstream
 *
 * Binary audio is sent as: { type: "moss_live_audio", audio: "<base64>" }
 * (WebSocket text frames only — no raw binary through chat WS)
 */

import { WebSocket } from "ws";
import type { MossLiveConfig } from "../core/config.js";
import { createLogger } from "../setup/logger.js";

const log = createLogger("moss-live");

const MOSS_LIVE_URL = "wss://api.mosi.cn/v1/realtime";
const DEFAULT_MODEL = "moss-live-1.0";

export interface MossLiveTunnel {
  handleEvent(event: Record<string, unknown>): void;
  handleAudio(base64: string): void;
  stop(): void;
}

export function createMossLiveTunnel(
  config: MossLiveConfig,
  sendToClient: (msg: Record<string, unknown>) => void,
  sendBinaryToClient: (data: Buffer) => void,
): MossLiveTunnel {
  const model = config.model || DEFAULT_MODEL;
  const upstreamUrl = `${MOSS_LIVE_URL}?model=${encodeURIComponent(model)}`;

  log.info(`[moss-live] opening upstream to ${upstreamUrl}`);

  const upstream = new WebSocket(upstreamUrl, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });

  let sessionId: string | null = null;
  let alive = true;
  let loggedAudioOnce = false;

  // ── Upstream lifecycle ──
  upstream.on("open", () => {
    log.info("[moss-live] upstream connected");
    // Step 1: attach session with delegation
    upstream.send(JSON.stringify({
      action: "attach_session",
      delegation: { type: "client" },
    }));
  });

  upstream.on("message", (data, isBinary) => {
    if (!alive) return;

    if (isBinary || (data instanceof Buffer && !isJsonBuffer(data))) {
      // Binary audio from Moss-Live → forward to client
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (!loggedAudioOnce) {
        log.info(`[moss-live] first audio frame: ${buf.length} bytes, header=[${buf.slice(0, 8).toString("hex")}]`);
        loggedAudioOnce = true;
      }
      sendBinaryToClient(buf);
      return;
    }

    // Text event from Moss-Live → wrap and forward
    const str = data.toString();
    try {
      const msg = JSON.parse(str);
      handleUpstreamEvent(msg);
      sendToClient({ type: "moss_live_event", event: msg });
    } catch {
      // Not JSON, forward raw
      sendToClient({ type: "moss_live_event", event: { raw: str } });
    }
  });

  upstream.on("error", (err) => {
    log.error(`[moss-live] upstream error: ${err.message}`);
    sendToClient({
      type: "moss_live_event",
      event: { action: "error", data: { code: "upstream_error", message: err.message } },
    });
  });

  upstream.on("close", (code, reason) => {
    log.info(`[moss-live] upstream closed: code=${code}`);
    alive = false;
    sendToClient({
      type: "moss_live_event",
      event: { action: "moss_live_closed", code, reason: reason?.toString() },
    });
  });

  // ── Event handling ──
  function handleUpstreamEvent(msg: Record<string, unknown>) {
    const action = msg.action as string;
    const data = msg.data as Record<string, unknown> | undefined;

    if (action === "session_attached") {
      sessionId = data?.session_id as string ?? null;
      log.info(`[moss-live] session attached: ${sessionId}`);

      // Set playback mode to "server" so Moss-Live pushes audio
      // continuously without waiting for client playback receipts.
      upstream.send(JSON.stringify({
        action: "media.configure",
        playback: "server",
      }));

      // Configure persona + instructions
      const update: Record<string, unknown> = {};
      if (config.persona) update.persona = { prompt: config.persona };
      if (config.instructions) update.instructions = config.instructions;
      if (Object.keys(update).length > 0) {
        upstream.send(JSON.stringify({ action: "session.update", session: update }));
      }
    }

    if (action === "session.delegation.created") {
      const delegation = data?.delegation as Record<string, unknown> | undefined;
      if (!delegation) return;
      log.info(`[moss-live] delegation: id=${delegation.id} objective=${(delegation.objective as string)?.slice(0, 80)}`);
      // TODO Phase 2: route to tianshu agent
      // For now, echo back
      const delegationId = delegation.id as string;
      const objective = delegation.objective as string;
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(JSON.stringify({
          action: "session.commentary.append",
          delegation_id: delegationId,
          commentary: { text: `收到任务: ${objective}`, status: "completed" },
        }));
      }
    }
  }

  return {
    handleEvent(event: Record<string, unknown>) {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(JSON.stringify(event));
      }
    },
    handleAudio(base64: string) {
      if (upstream.readyState === WebSocket.OPEN) {
        const buf = Buffer.from(base64, "base64");
        upstream.send(buf);
      }
    },
    stop() {
      alive = false;
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.close();
      }
    },
  };
}

function isJsonBuffer(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  const first = buf[0];
  return first === 0x7B; // '{'
}
