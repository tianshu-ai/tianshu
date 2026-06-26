// WeChat channel adapter.
//
// Implements `ChannelAdapter` from @tianshu-ai/plugin-sdk.
//
// Lifecycle on `start()`:
//   1. Load token from state-dir (binding-scoped). If missing,
//      surface an error — admin needs to QR-login through the
//      plugin's /login/start + /login/poll routes first.
//   2. Spin up a long-poll loop that calls `getUpdates`, persists
//      the returned sync-buf, normalises each `IncomingMessage`
//      into a tianshu `InboundChannelMessage`, and emits it to
//      the host hub.
//   3. Per-user `context_token` from each inbound message is
//      cached + persisted so outbound `send()` can echo it.
//
// `send()` looks up the recipient's most-recent `context_token`,
// calls iLink `sendmessage`, surfaces ret/errcode errors as
// adapter errors.
//
// We intentionally keep this lean: no media upload, no typing,
// no read-receipts. Adding them is an iteration: drop another
// ilink-api.ts helper + plumb a render path into normalise().

import type {
  ChannelAdapter,
  ChannelAdapterContext,
  InboundChannelMessage,
  OutboundChannelMessage,
} from "@tianshu-ai/plugin-sdk";
import {
  getUpdates,
  sendTextMessage,
  STALE_TOKEN_ERRCODE,
  type IncomingMessage,
} from "./ilink-api.js";
import { WeChatState } from "./state.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const CHANNEL_VERSION = "0.1.0";

export interface WeChatChannelConfig {
  /** Override only if Tencent moves the API. */
  baseUrl?: string;
  /** Analytics tag — like a User-Agent. */
  botAgent?: string;
  /** Bearer token issued by iLink after QR scan. Persisted on the
   *  channel_bindings row's config JSON; the admin login flow
   *  obtains it then writes it via createBinding/updateBinding. */
  token?: string;
  /** Optional self iLink user id (the bot's own id). Currently
   *  used only for display — we don't filter self-echo through
   *  it because Tencent doesn't include the bot's own messages
   *  in getupdates. */
  ilinkUserId?: string;
  /** Display name resolved at login time, for the admin UI. */
  username?: string;
}

export class WeChatChannel implements ChannelAdapter {
  readonly id = "wechat";
  readonly displayName = "WeChat";

  private msgHandlers: Array<(msg: InboundChannelMessage) => void> = [];
  private errHandlers: Array<(err: Error) => void> = [];
  private state: WeChatState;
  private abortController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private baseUrl: string;
  private botAgent: string;
  private token: string | null = null;
  private contextTokens: Record<string, string>;
  private displayNames: Record<string, string> = {};

  constructor(private ctx: ChannelAdapterContext) {
    this.state = new WeChatState(ctx.stateDir);
    const cfg = (ctx.config ?? {}) as WeChatChannelConfig;
    this.baseUrl = cfg.baseUrl?.trim() || "https://ilinkai.weixin.qq.com";
    this.botAgent = cfg.botAgent?.trim() || "tianshu";
    this.contextTokens = this.state.loadContextTokens();
    // Token + identity come from the binding's config (the admin
    // wrote them after the QR-login flow). sync-buf and per-user
    // context tokens stay in stateDir because they're large and
    // change every poll.
    if (typeof cfg.token === "string" && cfg.token) {
      this.token = cfg.token;
    }
    if (cfg.ilinkUserId && cfg.username) {
      this.displayNames[cfg.ilinkUserId] = cfg.username;
    }
  }

  onMessage(handler: (msg: InboundChannelMessage) => void): void {
    this.msgHandlers.push(handler);
  }

  onError(handler: (err: Error) => void): void {
    this.errHandlers.push(handler);
  }

  async start(): Promise<void> {
    if (this.loopPromise) return; // idempotent
    if (!this.token) {
      const msg =
        "wechat: no token in binding config. Run the QR login flow via POST /api/p/wechat/login/start, then save the token into the binding's config.token.";
      this.emitError(new Error(msg));
      throw new Error(msg);
    }
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.loopPromise = this.runLongPollLoop(signal).catch((err) => {
      this.ctx.log.error(
        `wechat long-poll loop crashed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  async stop(): Promise<void> {
    if (!this.abortController) return;
    this.abortController.abort();
    this.abortController = null;
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
      this.loopPromise = null;
    }
  }

  async send(message: OutboundChannelMessage): Promise<void> {
    if (!this.token) {
      throw new Error("wechat: not logged in (no token)");
    }
    const contextToken = this.contextTokens[message.target];
    if (!contextToken) {
      throw new Error(
        `wechat: no context_token for user ${message.target}; the recipient must have sent at least one message recently`,
      );
    }
    await sendTextMessage({
      baseUrl: this.baseUrl,
      token: this.token,
      ilinkUserId: message.target,
      contextToken,
      text: message.text,
      botAgent: this.botAgent,
      channelVersion: CHANNEL_VERSION,
    });
  }

  async resolveDisplayName(handle: string, _kind: "user" | "chat"): Promise<string | null> {
    return this.displayNames[handle] ?? null;
  }

  // ── internals ────────────────────────────────────────────────

  private async runLongPollLoop(signal: AbortSignal): Promise<void> {
    let getUpdatesBuf = this.state.loadSyncBuf();
    let pollTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        const resp = await getUpdates({
          baseUrl: this.baseUrl,
          token: this.token!,
          get_updates_buf: getUpdatesBuf,
          timeoutMs: pollTimeoutMs,
          abortSignal: signal,
          botAgent: this.botAgent,
          channelVersion: CHANNEL_VERSION,
        });

        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
          pollTimeoutMs = resp.longpolling_timeout_ms;
        }

        const ret = resp.ret ?? 0;
        const errcode = resp.errcode ?? 0;
        if (ret !== 0 || errcode !== 0) {
          if (
            errcode === STALE_TOKEN_ERRCODE ||
            ret === STALE_TOKEN_ERRCODE
          ) {
            const msg =
              "wechat: token went stale; long-poll paused. Re-run QR login to recover.";
            this.ctx.log.error(msg);
            this.emitError(new Error(msg));
            // Pause indefinitely; admin needs to re-login.
            await waitForever(signal);
            continue;
          }
          consecutiveFailures += 1;
          this.ctx.log.warn(
            `wechat getUpdates failed: ret=${ret} errcode=${errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
          );
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            consecutiveFailures = 0;
            await sleep(BACKOFF_DELAY_MS, signal);
          } else {
            await sleep(RETRY_DELAY_MS, signal);
          }
          continue;
        }

        consecutiveFailures = 0;
        if (resp.get_updates_buf && resp.get_updates_buf !== getUpdatesBuf) {
          getUpdatesBuf = resp.get_updates_buf;
          this.state.saveSyncBuf(getUpdatesBuf);
        }
        if (resp.msgs && resp.msgs.length > 0) {
          for (const m of resp.msgs) {
            try {
              const normalised = this.normaliseInbound(m);
              if (normalised) this.emit(normalised);
            } catch (err) {
              this.ctx.log.warn(
                `wechat normalise failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        consecutiveFailures += 1;
        this.ctx.log.warn(
          `wechat getUpdates threw: ${err instanceof Error ? err.message : String(err)} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, signal);
        } else {
          await sleep(RETRY_DELAY_MS, signal);
        }
      }
    }
  }

  private normaliseInbound(m: IncomingMessage): InboundChannelMessage | null {
    if (!m.ilink_user_id) return null;
    const text =
      (m.msg_items ?? [])
        .map((it) => (typeof it.text === "string" ? it.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim() ?? "";
    if (!text) return null;

    if (m.context_token) {
      // Refresh cached token for this user.
      this.contextTokens[m.ilink_user_id] = m.context_token;
      this.state.saveContextTokens(this.contextTokens);
    }
    if (m.username) {
      this.displayNames[m.ilink_user_id] = m.username;
    }

    return {
      channelId: this.id,
      // For DMs we use the sender's ilink user id as chat handle.
      chatId: m.ilink_user_id,
      isDirect: true,
      senderId: m.ilink_user_id,
      senderName: m.username,
      text,
      messageId: m.msg_id ?? `wx_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      timestamp: m.msg_create_time ? m.msg_create_time * 1000 : Date.now(),
      raw: m,
    };
  }

  private emit(msg: InboundChannelMessage): void {
    for (const h of this.msgHandlers) {
      try {
        h(msg);
      } catch (err) {
        this.ctx.log.error(
          `wechat message handler threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private emitError(err: Error): void {
    for (const h of this.errHandlers) {
      try {
        h(err);
      } catch {
        /* swallow */
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    const abortHandler = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  });
}

function waitForever(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
