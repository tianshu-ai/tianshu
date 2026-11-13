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

    // Binary audio → forward to browser (strip tagged-v1 prefix if present)
    if (isBinary) {
      const buf = Buffer.isBuffer(packet) ? packet : Buffer.from(packet as ArrayBuffer);
      sendBinaryToClient(buf);
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
        // 1. Enable tagged binary protocol FIRST
        send({ action: "media.mode", binary_protocol: "tagged-v1" });
        // 2. Then configure persona + instructions
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
    // Audio from browser: add 0x00 prefix for tagged-v1 protocol
    handleAudio(base64: string) {
      if (upstream.readyState === WebSocket.OPEN) {
        const pcm = Buffer.from(base64, "base64");
        // tagged-v1: 0x00 prefix = audio
        const tagged = Buffer.concat([Buffer.from([0x00]), pcm]);
        upstream.send(tagged);
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
