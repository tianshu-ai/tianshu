/**
 * Moss-Live realtime voice — tunneled through the chat WebSocket.
 *
 * Based on @mossai/mosslive SDK browser-demo protocol.
 * No SDK runtime dependency (ESM-only package breaks CJS builds).
 * Manual handling of playback receipts and delegation protocol.
 *
 * Playback receipt format (from SDK public-fields.json):
 *   playback.chunk.completed: { chunk_id, run_id, turn_id }
 *   playback.completed: { run_id, turn_id }
 *   playback.stopped: { run_id, turn_id, played_audio_ms, reason }
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

export type DelegationHandler = (
  task: { delegationId: string; objective: string; purpose: string; context: Array<{ role: string; content: string }> },
  callbacks: { reportProgress: (text: string) => void; reportResult: (text: string) => void; reportFailed: (text: string) => void },
) => Promise<void>;

export function createMossLiveTunnel(
  config: MossLiveConfig,
  sendToClient: (msg: Record<string, unknown>) => void,
  sendBinaryToClient: (data: Buffer) => void,
  onDelegation?: DelegationHandler,
  recentHistory?: Array<{ role: string; content: string }>,
  capabilitySummary?: string,
): MossLiveTunnel {
  const model = config.model || DEFAULT_MODEL;
  const upstreamUrl = `${MOSS_LIVE_URL}?model=${encodeURIComponent(model)}`;

  log.info(`[moss-live] opening upstream to ${upstreamUrl}`);

  const upstream = new WebSocket(upstreamUrl, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });

  let alive = true;

  // Playback receipt state
  const pendingContexts: Array<{ chunkId: string; runId: string; turnId: string }> = [];
  let lastRunId = "";
  let lastTurnId = "";
  let audioFinished = false;

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

      // Each binary frame corresponds to one preceding response.audio.context
      const ctx = pendingContexts.shift();
      if (ctx) {
        send({
          action: "playback.chunk.completed",
          chunk_id: ctx.chunkId,
          run_id: ctx.runId,
          turn_id: ctx.turnId,
        });
      }
      // If audio.done received and no more pending, send playback.completed
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

    // Text event
    const str = packet.toString();
    try {
      const msg = JSON.parse(str);
      const action = msg.action as string;
      const data = (msg.data || {}) as Record<string, unknown>;

      // ── Session lifecycle ──
      if (action === "session_attached") {
        log.info(`[moss-live] session attached: ${data.session_id}, delegation=${data.delegation}`);
        sendSessionUpdate(send, config, recentHistory, capabilitySummary);
      }

      if (action === "session.updated") {
        if (data.error) {
          log.error(`[moss-live] session.update FAILED: ${data.error}`);
        } else {
          log.info(`[moss-live] session.update OK, sending mic_state`);
          send({ action: "mic_state", enabled: true });
        }
      }

      // ── Playback tracking ──
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
        if (pendingContexts.length === 0 && lastRunId) {
          send({ action: "playback.completed", run_id: lastRunId, turn_id: lastTurnId });
          audioFinished = false;
        }
      }
      if (action === "response.audio.stop") {
        pendingContexts.length = 0;
        send({
          action: "playback.stopped",
          run_id: (data.run_id as string) || lastRunId,
          turn_id: (data.turn_id as string) || lastTurnId,
          played_audio_ms: 0,
          reason: (data.reason as string) || "interrupted",
        });
      }

      // ── Delegation ──
      if (action === "session.delegation.created") {
        log.info(`[moss-live] delegation created: ${JSON.stringify(data).slice(0, 300)}`);
        const delegation = data.delegation as Record<string, unknown> | undefined;
        const delegationId = (delegation?.id ?? data.id) as string;
        const objective = (delegation?.objective ?? data.objective) as string;
        const purpose = (delegation?.purpose ?? data.purpose ?? "task") as string;
        const context = (delegation?.context ?? data.context ?? []) as Array<{ role: string; content: string }>;

        if (delegationId && onDelegation) {
          const callbacks = {
            reportProgress: (text: string) => sendAppend(send, delegationId, "commentary", text, "in_progress"),
            reportResult: (text: string) => sendAppend(send, delegationId, "commentary", text, "completed"),
            reportFailed: (text: string) => sendAppend(send, delegationId, "commentary", text, "failed"),
          };
          onDelegation({ delegationId, objective: objective || "", purpose, context }, callbacks).catch((err) => {
            log.error(`[moss-live] delegation failed: ${err instanceof Error ? err.message : String(err)}`);
            callbacks.reportFailed(`执行失败: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }

      if (action === "error") {
        log.error(`[moss-live] upstream error event: ${JSON.stringify(data).slice(0, 200)}`);
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
    sendToClient({
      type: "moss_live_event",
      event: { action: "moss_live_closed", code, reason: reason?.toString() },
    });
  });

  return {
    handleEvent(event: Record<string, unknown>) {
      send(event);
    },
    handleAudio(base64: string) {
      if (upstream.readyState === WebSocket.OPEN) {
        const pcm = Buffer.from(base64, "base64");
        upstream.send(pcm);
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

function sendAppend(
  send: (v: Record<string, unknown>) => void,
  delegationId: string,
  type: "thinking" | "commentary",
  text: string,
  status: "in_progress" | "completed" | "failed",
) {
  const truncated = text.length > 1900 ? text.slice(0, 1900) + "…" : text;
  send({
    action: type === "thinking" ? "session.thinking.append" : "session.commentary.append",
    delegation_id: delegationId,
    ...(type === "thinking"
      ? { thinking: { text: truncated } }
      : { commentary: { text: truncated, status } }),
  });
}

function sendSessionUpdate(
  send: (v: Record<string, unknown>) => void,
  config: MossLiveConfig,
  recentHistory?: Array<{ role: string; content: string }>,
  capabilitySummary?: string,
) {
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

  let instructions = config.instructions || "";

  if (recentHistory && recentHistory.length > 0) {
    const historyLines: string[] = [];
    let charCount = 0;
    const MAX_HISTORY_CHARS = 4000;
    for (let i = recentHistory.length - 1; i >= 0 && charCount < MAX_HISTORY_CHARS; i--) {
      const msg = recentHistory[i];
      const prefix = msg.role === "user" ? "用户" : msg.role === "assistant" ? "天枢" : msg.role;
      const text = msg.content.length > 200 ? msg.content.slice(0, 200) + "…" : msg.content;
      const line = `${prefix}: ${text}`;
      charCount += line.length;
      historyLines.unshift(line);
    }
    instructions += `\n\n# 用户最近的天枢聊天记录（供你了解上下文）\n${historyLines.join("\n")}`;
    log.info(`[moss-live] injected ${historyLines.length} recent messages into instructions`);
  }

  if (capabilitySummary) {
    instructions += capabilitySummary;
    log.info(`[moss-live] injected capability summary (${capabilitySummary.length} chars)`);
  }

  send({
    action: "session.update",
    session: {
      persona: { prompt: persona },
      ...(instructions ? { instructions } : {}),
    },
  });
  log.info(`[moss-live] sending session.update: persona length=${persona.length}, instructions length=${instructions.length}`);
}
