/**
 * Moss-Live realtime voice — tunneled through the chat WebSocket.
 *
 * Based on @mossai/mosslive SDK browser-demo server example.
 * Uses createDelegationBridge for delegation protocol, manual
 * handling for session setup, media mode, and audio relay.
 *
 * Key protocol details from SDK examples:
 *   - Must send media.mode { binary_protocol: 'tagged-v1' }
 *   - Must send mic_state { enabled: true } (top-level, not nested)
 *   - Audio frames must be prefixed: 0x00 + PCM bytes
 *   - Playback receipts handled by SDK bridge via bridge.handle()
 */

import { WebSocket } from "ws";
import { createDelegationBridge, type DelegationBridge, type PublicEvent } from "@mossai/mosslive";
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

export type DelegationHandler = (
  task: { delegationId: string; objective: string; purpose: string; context: Array<{ role: string; content: string }> },
  callbacks: { reportProgress: (text: string) => void; reportResult: (text: string) => void; reportFailed: (text: string) => void },
) => Promise<void>;

export function createMossLiveTunnel(
  config: MossLiveConfig,
  sendToClient: (msg: Record<string, unknown>) => void,
  sendBinaryToClient: (data: Buffer) => void,
  onDelegation?: DelegationHandler,
): MossLiveTunnel {
  const model = config.model || DEFAULT_MODEL;
  const upstreamUrl = `${MOSS_LIVE_URL}?model=${encodeURIComponent(model)}`;

  log.info(`[moss-live] opening upstream to ${upstreamUrl}`);

  const upstream = new WebSocket(upstreamUrl, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });

  let alive = true;
  let bridge: DelegationBridge | null = null;
  // Playback receipt state (mirrors SDK PlaybackLedger logic).
  // Each response.audio.context is followed by exactly one binary frame.
  const pendingContexts: Array<{ chunkId: string; runId: string; turnId: string }> = [];
  let lastRunId = "";
  let lastTurnId = "";
  let audioFinished = false; // response.audio.done received

  // Create delegation bridge (low-level API from SDK).
  // We manually call bridge.handle(event) for each upstream text event.
  // The bridge handles delegation lifecycle and sends protocol frames
  // (thinking/commentary appends) through the send callback.
  bridge = createDelegationBridge({
    send: (frame: PublicEvent) => new Promise<void>((resolve, reject) => {
      if (upstream.readyState !== WebSocket.OPEN) { reject(new Error("closed")); return; }
      upstream.send(JSON.stringify(frame), (err) => err ? reject(err) : resolve());
    }),
    run: async (task, context) => {
      log.info(`[moss-live] delegation: id=${task.delegationId} purpose=${task.purpose} objective=${task.objective?.slice(0, 80)}`);
      if (onDelegation) {
        // Wrap SDK context into our callback interface
        await new Promise<void>((resolve, reject) => {
          onDelegation(
            { delegationId: task.delegationId, objective: task.objective, purpose: task.purpose, context: [...task.context] },
            {
              reportProgress: (text) => context.reportProgress(text, { spoken: true }),
              reportResult: (text) => {
                // SDK run() returns the result string; we resolve the promise
                // But we need to return it from run(), so store and resolve
                resolve();
              },
              reportFailed: (text) => {
                reject(new Error(text));
              },
            },
          ).then(resolve).catch(reject);
        });
        return "任务已完成";
      }
      return `收到任务: ${task.objective}`;
    },
    onError: (err) => {
      log.error(`[moss-live] bridge error: ${err.code} ${err.message}`);
    },
  });

  const send = (value: Record<string, unknown>) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify(value));
    }
  };

  // ── On open: send attach_session ──
  upstream.on("open", () => {
    log.info("[moss-live] upstream connected, sending attach_session");
    send({ action: "attach_session", delegation: { type: "client" } });
  });

  // ── Main message handler ──
  upstream.on("message", (packet, isBinary) => {
    if (!alive) return;

    // Binary audio → forward to browser + send playback receipt
    if (isBinary) {
      const buf = Buffer.isBuffer(packet) ? packet : Buffer.from(packet as ArrayBuffer);
      sendBinaryToClient(buf);
      // Each binary frame corresponds to one preceding response.audio.context.
      // Send playback.chunk.completed immediately (server-side, no real playback delay).
      const ctx = pendingContexts.shift();
      if (ctx && upstream.readyState === WebSocket.OPEN) {
        send({
          action: "playback.chunk.completed",
          chunk_id: ctx.chunkId,
          run_id: ctx.runId,
          turn_id: ctx.turnId,
        });
      }
      // If audio.done was received and no more pending chunks, send playback.completed
      if (audioFinished && pendingContexts.length === 0 && lastRunId) {
        send({
          action: "playback.completed",
          run_id: lastRunId,
          turn_id: lastTurnId,
        });
        audioFinished = false;
      }
      return;
    }

    const str = packet.toString();
    try {
      const msg = JSON.parse(str);
      const action = msg.action as string;
      const data = (msg.data || {}) as Record<string, unknown>;

      // Let SDK bridge handle delegation + playback protocol
      if (bridge) bridge.handle(msg);

      // ── Session lifecycle (from SDK example) ──
      // Follow SDK demo order:
      //   session_attached → media.mode + session.update
      //   session.updated → mic_state (after config confirmed)
      if (action === "session_attached") {
        log.info(`[moss-live] session attached: ${data.session_id}, delegation=${data.delegation}`);
        // Pure audio: no media.mode needed (tagged-v1 is only for video+audio).
        // Just configure persona + instructions.
        sendSessionUpdate(send, config);
      }

      if (action === "session.updated") {
        if (data.error) {
          log.error(`[moss-live] session.update FAILED: ${data.error}`);
        } else {
          log.info(`[moss-live] session.update OK, sending mic_state`);
          // 3. Enable mic after config confirmed
          send({ action: "mic_state", enabled: true });
        }
      }

      // ── Playback tracking (from SDK PlaybackLedger) ──
      if (action === "response.audio.started") {
        lastRunId = (data.run_id as string) || "";
        lastTurnId = (data.turn_id as string) || "";
        audioFinished = false;
      }
      if (action === "response.audio.context") {
        pendingContexts.push({
          chunkId: data.chunk_id as string,
          runId: data.run_id as string,
          turnId: data.turn_id as string,
        });
      }
      if (action === "response.audio.done") {
        audioFinished = true;
        // If all chunks already acked, send playback.completed now
        if (pendingContexts.length === 0 && lastRunId) {
          send({ action: "playback.completed", run_id: lastRunId, turn_id: lastTurnId });
          audioFinished = false;
        }
      }
      if (action === "response.audio.stop") {
        // Interrupted — clear pending, send playback.stopped
        pendingContexts.length = 0;
        send({
          action: "playback.stopped",
          run_id: (data.run_id as string) || lastRunId,
          turn_id: (data.turn_id as string) || lastTurnId,
          played_audio_ms: 0,
          reason: data.reason as string || "interrupted",
        });
      }

      if (action === "error") {
        log.error(`[moss-live] upstream error event: ${JSON.stringify(data).slice(0, 200)}`);
      }

      // Track delegation events for logging
      if (action === "session.delegation.created") {
        log.info(`[moss-live] delegation created: ${JSON.stringify(data).slice(0, 300)}`);
      }

      // Forward ALL events to browser for UI
      sendToClient({ type: "moss_live_event", event: msg });
    } catch { /* not JSON */ }
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
    bridge?.close().catch(() => {});
    bridge = null;
    sendToClient({
      type: "moss_live_event",
      event: { action: "moss_live_closed", code, reason: reason?.toString() },
    });
  });

  return {
    handleEvent(event: Record<string, unknown>) {
      send(event);
    },
    // Audio from browser: send raw PCM (pure audio, no tagged-v1 prefix)
    handleAudio(base64: string) {
      if (upstream.readyState === WebSocket.OPEN) {
        const pcm = Buffer.from(base64, "base64");
        upstream.send(pcm);
      }
    },
    stop() {
      alive = false;
      bridge?.close().catch(() => {});
      bridge = null;
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.close();
      }
    },
  };
}

function sendSessionUpdate(send: (v: Record<string, unknown>) => void, config: MossLiveConfig) {
  const ROLE_PREAMBLE = [
    `# 角色`,
    `你是前台语音接待，负责与用户实时语音对话。`,
    ``,
    `# 后台能力`,
    `你的后台连接了一个完整的天枢(tianshu) AI Agent。`,
    `天枢Agent拥有：用户聊天历史、文件系统、数据库、消息发送、代码执行、网络搜索等工具。`,
    ``,
    `# 强制规则`,
    `• 你自己没有任何工具、没有文件系统、没有数据库、没有用户数据。`,
    `• 凡是用户��求你做一件事、查一个信息、发一条消息、写一个文件、搜一个东西——你必须通过delegation委派给后台天枢Agent。`,
    `• 绝对不要自己编造结果或假装已经完成。不要说我已经帮你做了、已经安排了之类的话——你必须真正委派出去。`,
    `• 委派后，告诉用户你已经交给后台处理，等待结果。`,
    ``,
    `# 你可以直接回答的`,
    `• 常识性问题`,
    `• 闲聊、打招呼、情绪支持`,
    `• 解释概念、给建议（不涉及用户特定数据）`,
    ``,
    `# 委派格式`,
    `委派时把用户的完整意图作为objective，保留原文，不要简化或改写。`,
  ].join("\n");

  const persona = config.persona
    ? `${ROLE_PREAMBLE}\n\n${config.persona}`
    : ROLE_PREAMBLE;

  send({
    action: "session.update",
    session: {
      persona: { prompt: persona },
      ...(config.instructions ? { instructions: config.instructions } : {}),
    },
  });
  log.info(`[moss-live] sending session.update: persona length=${persona.length}`);
}

function isJsonBuffer(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  return buf[0] === 0x7B;
}
