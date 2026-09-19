// Streaming ASR WebSocket endpoint (`/ws/asr`).
//
// One connection = one streaming ASR session. The client sends
// audio chunks (16kHz Float32 PCM, base64-encoded) as fast as it
// captures them; the server feeds each chunk to sherpa-onnx's
// OnlineRecognizer, drains ready decodes, and pushes back partial
// results whenever the text changes.
//
// Wire protocol (JSON messages both directions):
//
//   client → server:
//     { type: "audio", samples: "<base64 Float32Array>" }
//     { type: "end" }                             (finish; drain final result)
//
//   server → client:
//     { type: "ready" }                           (recognizer initialised)
//     { type: "partial", text: "..." }            (whenever text grows)
//     { type: "endpoint" }                        (silence detected; utterance boundary)
//     { type: "final", text: "..." }              (after client end; connection closes)
//     { type: "error", reason: "..." }            (fatal; connection closes)
//
// Auth: mirrors /ws (see boot/ws-upgrade.ts). Reuses the same
// identity resolver chain so cookie / query-string overrides work
// identically. Requests without a valid identity are refused.
//
// Failure modes handled:
//   - active model is offline (or none) → refuse with error
//   - resolver throws / denies → error + close
//   - client sends malformed message → error + close
//   - idle >60s (no audio) → server-initiated close
//   - ping/pong: same 30s / 10s pattern as /ws

import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  DEV_TENANT_ID,
  TenantNotFoundError,
  runIdentityChain,
  buildResolverChain,
  loadGlobalConfig,
} from "../core/index.js";
import type { GlobalOps } from "../core/global-ops.js";
import { getOnlineRecognizer, isOnlineActive } from "./asr.js";

export interface InstallAsrWebSocketDeps {
  server: HttpServer;
  globalOps: GlobalOps;
}

// Client audio arrives base64-encoded so it fits cleanly in JSON.
// One frame = one call to acceptWaveform + a drain loop. 16kHz mono
// Float32 is what the frontend AudioWorklet will emit and what sherpa
// wants natively — no resampling on the server hot path.
interface ClientMsg {
  type: "audio" | "end";
  samples?: string; // base64 Float32Array little-endian
}

interface ServerMsg {
  type: "ready" | "partial" | "endpoint" | "final" | "error";
  text?: string;
  reason?: string;
}

const IDLE_TIMEOUT_MS = 60_000;
const PING_INTERVAL_MS = 30_000;
const SAMPLE_RATE = 16_000;

export function installAsrWebSocket(deps: InstallAsrWebSocketDeps): WebSocketServer {
  const { server, globalOps } = deps;
  // Yu, 2026-09-19: `noServer: true` + manual upgrade dispatch is
  // the ws library's officially-required pattern when multiple WSS
  // share one HTTP server. The chat WSS (ws-upgrade.ts) uses the
  // simpler {server, path} auto-hook form; two auto-hooked WSSes on
  // the same http.Server both try to own the `upgrade` event and
  // one wins non-deterministically — the other returns garbled
  // handshake bytes, which surfaces client-side as "Invalid frame
  // header". We opt this new WSS out of the auto-hook and manually
  // route only /ws/asr upgrades here, leaving all other paths
  // (notably /ws) untouched for the existing WSS.
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = request.url ?? "";
    // Match the pathname exactly. Query strings on ws:// URLs are
    // used for identity switching (see /ws) so allow them here too.
    const pathname = url.split("?", 1)[0];
    if (pathname !== "/ws/asr") return; // let /ws or 404 handle it
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  const aliveSet = new Set<WebSocket>();
  const pingTimer = setInterval(() => {
    for (const client of wss.clients) {
      if (!aliveSet.has(client)) {
        client.terminate();
        continue;
      }
      aliveSet.delete(client);
      client.ping();
    }
  }, PING_INTERVAL_MS);
  pingTimer.unref();
  wss.on("close", () => clearInterval(pingTimer));

  wss.on("connection", async (socket, request) => {
    aliveSet.add(socket);
    socket.on("pong", () => aliveSet.add(socket));

    const send = (msg: ServerMsg) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    };
    const fatal = (reason: string) => {
      send({ type: "error", reason });
      socket.close();
    };

    // 1. Authenticate. Mirror /ws exactly so cookie-set identity works.
    const { resolution, error: chainError } = runIdentityChain(
      request as unknown as Parameters<typeof runIdentityChain>[0],
      buildResolverChain(loadGlobalConfig().auth),
    );
    if (chainError) {
      fatal(`identity resolver "${chainError.resolver}" threw: ${chainError.message}`);
      return;
    }
    if (!resolution || resolution.kind === "deny") {
      fatal(
        resolution?.kind === "deny"
          ? `identity denied by ${resolution.source}: ${resolution.reason}`
          : "no identity resolver claimed this WS upgrade",
      );
      return;
    }

    // Tenant fallback so a stale cookie doesn't kill the socket
    // outright — matches /ws behaviour.
    try {
      globalOps.open(resolution.tenantId);
    } catch (err) {
      if (err instanceof TenantNotFoundError) {
        try {
          globalOps.open(DEV_TENANT_ID);
        } catch {
          fatal(`tenant ${resolution.tenantId} unavailable and default tenant missing`);
          return;
        }
      } else {
        fatal(
          `tenant ${resolution.tenantId} unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }

    // 2. Verify a streaming recognizer is loaded. If the active model
    //    is offline (or none) we can't serve this connection — the
    //    client's supposed to have checked /api/transcribe/status
    //    first, but refuse loudly here as a defence.
    if (!isOnlineActive()) {
      fatal(
        "no streaming ASR model loaded — activate a streaming model in Settings → 语音识别",
      );
      return;
    }
    const recognizer = getOnlineRecognizer();
    if (!recognizer) {
      fatal("streaming recognizer not initialised");
      return;
    }

    // 3. Create the persistent stream. One socket = one stream; the
    //    stream survives across utterance boundaries (endpoint fires
    //    → we reset() but keep the socket).
    const stream = recognizer.createStream();
    let lastText = "";
    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        fatal("idle timeout — no audio received for 60s");
      }, IDLE_TIMEOUT_MS);
      idleTimer.unref();
    };
    resetIdleTimer();

    send({ type: "ready" });

    const drainDecodes = () => {
      while (recognizer.isReady(stream)) {
        recognizer.decode(stream);
        const result = recognizer.getResult(stream);
        const text = (result.text ?? "").trim();
        if (text !== lastText) {
          send({ type: "partial", text });
          lastText = text;
        }
        if (recognizer.isEndpoint(stream)) {
          send({ type: "endpoint" });
          recognizer.reset(stream);
          lastText = "";
        }
      }
    };

    socket.on("message", (raw) => {
      let parsed: ClientMsg;
      try {
        parsed = JSON.parse(raw.toString()) as ClientMsg;
      } catch {
        fatal("malformed JSON");
        return;
      }

      if (parsed.type === "audio") {
        if (typeof parsed.samples !== "string") {
          fatal("audio message missing samples");
          return;
        }
        resetIdleTimer();
        try {
          const buf = Buffer.from(parsed.samples, "base64");
          // A Float32Array view over the bytes. Node Buffers are backed
          // by ArrayBuffer so this is a zero-copy view — as long as
          // the byteLength is a multiple of 4.
          if (buf.byteLength % 4 !== 0) {
            fatal(`audio byteLength ${buf.byteLength} not a multiple of 4`);
            return;
          }
          const samples = new Float32Array(
            buf.buffer,
            buf.byteOffset,
            buf.byteLength / 4,
          );
          stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
          drainDecodes();
        } catch (err) {
          fatal(`decode failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      if (parsed.type === "end") {
        try {
          stream.inputFinished();
          drainDecodes();
          const finalResult = recognizer.getResult(stream);
          send({ type: "final", text: (finalResult.text ?? "").trim() });
        } catch (err) {
          send({
            type: "error",
            reason: `final decode failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
          socket.close();
        }
        return;
      }

      fatal(`unknown message type: ${(parsed as { type: string }).type}`);
    });

    socket.on("close", () => {
      if (idleTimer) clearTimeout(idleTimer);
      aliveSet.delete(socket);
    });

    socket.on("error", (err) => {
      console.warn(`[ws-asr] socket error: ${err.message}`);
    });
  });

  return wss;
}
