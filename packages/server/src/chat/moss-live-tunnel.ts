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

export interface DelegationTask {
  delegationId: string;
  objective: string;
  purpose: string;
  context: Array<{ role: string; content: string }>;
}

export interface DelegationCallbacks {
  /** Report progress (silent, for model context only) */
  reportThinking: (text: string) => void;
  /** Report progress that can be spoken to the user */
  reportProgress: (text: string) => void;
  /** Report final result */
  reportResult: (text: string) => void;
  /** Report failure */
  reportFailed: (text: string) => void;
}

export interface MossLiveTunnel {
  handleEvent(event: Record<string, unknown>): void;
  handleAudio(base64: string): void;
  stop(): void;
}

export function createMossLiveTunnel(
  config: MossLiveConfig,
  sendToClient: (msg: Record<string, unknown>) => void,
  sendBinaryToClient: (data: Buffer) => void,
  onDelegation?: (task: DelegationTask, callbacks: DelegationCallbacks) => Promise<void>,
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

      // Configure persona + instructions.
      // Always inject a system-level role preamble so Moss-Live knows
      // it is the voice frontend for a full-featured tianshu agent
      // that holds user context, tools, and history.
      const ROLE_PREAMBLE = [
        "# 角色",
        "你是前台语音接待，负责与用户实时语音对话。",
        "",
        "# 后台能力",
        "你的后台连接了一个完整的天枢(tianshu) AI Agent。",
        "天枢Agent拥有：用户聊天历史、文件系统、数据库、消息发送、代码执行、网络搜索等工具。",
        "",
        "# 强制规则",
        "• 你自己没有任何工具、没有文件系统、没有数据库、没有用户数据。",
        "• 凡是用户要求你“做”一件事、“查”一个信息、“发”一条消息、“写”一个文件、“搜”一个东西——你必须通过delegation委派给后台天枢Agent。",
        "• 绝对不要自己编造结果或假装已经完成。不要说“我已经帮你做了”“已经安排了”之类的话——你必须真正委派出去。",
        "• 委派后，告诉用户你已经交给后台处理，等待结果。",
        "",
        "# 你可以直接回答的",
        "• 常识性问题（“什么是Python”“今天星期几”）",
        "• 闲聊、打招呼、情绪支持",
        "• 解释概念、给建议（不涉及用户特定数据）",
        "",
        "# 委派格式",
        "委派时把用户的完整意图作为objective，保留原文，不要简化或改写。",
      ].join("\n");

      const persona = config.persona
        ? `${ROLE_PREAMBLE}\n\n${config.persona}`
        : ROLE_PREAMBLE;

      const update: Record<string, unknown> = {
        persona: { prompt: persona },
      };
      if (config.instructions) update.instructions = config.instructions;
      log.info(`[moss-live] sending session.update: persona length=${persona.length}, instructions=${config.instructions ? 'yes' : 'no'}`);
      upstream.send(JSON.stringify({ action: "session.update", session: update }));
    }

    if (action === "session.updated") {
      const err = data?.error as string | undefined;
      if (err && err !== "") {
        log.error(`[moss-live] session.update FAILED: ${err}`);
      } else {
        log.info(`[moss-live] session.update OK`);
      }
    }

    if (action === "session.delegation.created") {
      // Dump full event to understand the actual structure
      log.info(`[moss-live] delegation raw event: ${JSON.stringify(msg).slice(0, 500)}`);
      const delegation = data?.delegation as Record<string, unknown> | undefined;
      // Try both data.delegation.X and data.X — Moss-Live format may vary
      const delegationId = (delegation?.id ?? data?.id ?? (msg as any).delegation_id) as string;
      const objective = (delegation?.objective ?? data?.objective ?? (msg as any).objective) as string;
      const purpose = (delegation?.purpose ?? data?.purpose ?? "task") as string;
      const context = (delegation?.context ?? data?.context ?? []) as Array<{ role: string; content: string }>;
      if (!delegationId) {
        log.error(`[moss-live] delegation event missing id, skipping`);
        return;
      }
      log.info(`[moss-live] delegation: id=${delegationId} purpose=${purpose} objective=${objective?.slice?.(0, 80) ?? '(none)'}`);
      if (!objective) {
        log.error(`[moss-live] delegation has no objective, skipping`);
        return;
      }

      const callbacks: DelegationCallbacks = {
        reportThinking: (text) => sendAppend(upstream, delegationId, "thinking", text),
        reportProgress: (text) => sendAppend(upstream, delegationId, "commentary", text, "in_progress"),
        reportResult: (text) => sendAppend(upstream, delegationId, "commentary", text, "completed"),
        reportFailed: (text) => sendAppend(upstream, delegationId, "commentary", text, "failed"),
      };

      if (onDelegation) {
        onDelegation({ delegationId, objective, purpose, context }, callbacks).catch((err) => {
          log.error(`[moss-live] delegation ${delegationId} failed: ${err instanceof Error ? err.message : String(err)}`);
          callbacks.reportFailed(`执行失败: ${err instanceof Error ? err.message : String(err)}`);
        });
      } else {
        // No delegation handler — echo back
        callbacks.reportResult(`收到任务: ${objective}`);
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

function sendAppend(
  ws: WebSocket,
  delegationId: string,
  type: "thinking" | "commentary",
  text: string,
  status?: "in_progress" | "completed" | "failed",
) {
  if (ws.readyState !== WebSocket.OPEN) return;
  // Moss-Live caps append content at 2000 Unicode chars
  const truncated = text.length > 1900 ? text.slice(0, 1900) + "…" : text;
  const payload: Record<string, unknown> = {
    action: type === "thinking" ? "session.thinking.append" : "session.commentary.append",
    delegation_id: delegationId,
  };
  if (type === "thinking") {
    payload.thinking = { text: truncated };
  } else {
    payload.commentary = { text: truncated, status: status || "in_progress" };
  }
  ws.send(JSON.stringify(payload));
}

function isJsonBuffer(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  const first = buf[0];
  return first === 0x7B; // '{'
}
