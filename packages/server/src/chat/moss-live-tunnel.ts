/**
 * Moss-Live realtime voice — tunneled through the chat WebSocket.
 *
 * Uses @mossai/mosslive SDK's `attachDelegation` for playback
 * receipts and delegation protocol.
 *
 * Flow:
 *   1. Open WS to Moss-Live
 *   2. Send attach_session, wait for session_attached
 *   3. Send session.update (persona), wait for session.updated
 *   4. Attach SDK bridge with sessionId for playback + delegation
 *   5. Relay audio + events to browser
 */

import { WebSocket } from "ws";
import { attachDelegation, type DelegationBridge, type Task, type RunContext } from "@mossai/mosslive";
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
  task: Task,
  context: RunContext,
) => Promise<string>;

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
  let sessionId: string | null = null;

  // ── Phase 1: open + attach_session ──
  upstream.on("open", () => {
    log.info("[moss-live] upstream connected, sending attach_session");
    upstream.send(JSON.stringify({
      action: "attach_session",
      delegation: { type: "client" },
    }));
  });

  // ── Main message handler ──
  upstream.on("message", (data, isBinary) => {
    if (!alive) return;

    // Binary audio → forward to browser
    if (isBinary || (data instanceof Buffer && !isJsonBuffer(data))) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      sendBinaryToClient(buf);
      return;
    }

    // Text event
    const str = data.toString();
    try {
      const msg = JSON.parse(str);
      const action = msg.action as string;
      const eventData = msg.data as Record<string, unknown> | undefined;

      // Phase 2: session_attached → configure persona → attach SDK bridge
      if (action === "session_attached") {
        sessionId = eventData?.session_id as string ?? null;
        log.info(`[moss-live] session attached: ${sessionId}, delegation=${eventData?.delegation}`);

        // Send persona + instructions
        sendSessionUpdate(upstream, config);

        // Phase 3: attach SDK bridge NOW with the sessionId.
        // The SDK handles playback receipts and delegation from here.
        bridge = attachDelegation({
          socket: upstream as any,
          sessionId: sessionId!,
          run: async (task: Task, context: RunContext): Promise<string> => {
            log.info(`[moss-live] delegation: id=${task.delegationId} purpose=${task.purpose} objective=${task.objective?.slice(0, 80)}`);
            if (onDelegation) {
              return onDelegation(task, context);
            }
            return `收到任务: ${task.objective}`;
          },
          onError: (err) => {
            log.error(`[moss-live] bridge error: ${err.code} ${err.message}`);
          },
        });
        log.info("[moss-live] SDK bridge attached");
      }

      if (action === "session.updated") {
        const err = eventData?.error as string | undefined;
        if (err && err !== "") {
          log.error(`[moss-live] session.update FAILED: ${err}`);
        } else {
          log.info(`[moss-live] session.update OK`);
        }
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
      bridge?.close().catch(() => {});
      bridge = null;
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.close();
      }
    },
  };
}

function sendSessionUpdate(ws: WebSocket, config: MossLiveConfig) {
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
    `• 凡是用户要求你做一件事、查一个信息、发一条消息、写一个文件、搜一个东西——你必须通过delegation委派给后台天枢Agent。`,
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

  const update: Record<string, unknown> = {
    persona: { prompt: persona },
  };
  if (config.instructions) update.instructions = config.instructions;
  log.info(`[moss-live] sending session.update: persona length=${persona.length}`);
  ws.send(JSON.stringify({ action: "session.update", session: update }));
}

function isJsonBuffer(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  return buf[0] === 0x7B; // '{'
}
