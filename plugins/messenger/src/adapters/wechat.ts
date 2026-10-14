// Messenger WeChat adapter.
//
// Each messenger WeChat contact is its OWN iLink binding — a fresh
// QR scan that creates a dedicated bot↔user channel. Unlike the
// wechat channel plugin, this adapter is **send-only**: it runs a
// lightweight poll loop solely to capture `context_token` (required
// by iLink's sendmessage API), but does NOT route inbound messages
// to any agent session.
//
// Lifecycle:
//   1. QR scan → getBotQrCode + getQrCodeStatus → bot_token + baseUrl
//   2. Credentials saved in messenger_contacts.config
//   3. activate() starts a background poll loop per contact
//   4. First inbound message → context_token captured → ready to send
//   5. send() uses stored token + context_token → sendTextMessage

import type { SendAdapter } from "../tool.js";
import type { Contact } from "../schema.js";
import {
  getBotQrCode,
  getQrCodeStatus,
  getUpdates,
  sendTextMessage,
  ILINK_BASE_URL,
  TIANSHU_BOT_AGENT,
  STALE_TOKEN_ERRCODES,
  type QrCodeResponse,
  type QrCodeStatusResponse,
} from "@tianshu-builtin/plugin-wechat/ilink-api";

const CHANNEL_VERSION = "0.3.36";
const POLL_BACKOFF_MS = 2000;
const POLL_ERROR_BACKOFF_MS = 10000;

export interface WeChatContactConfig {
  token: string;
  baseUrl: string;
  ilinkUserId: string;
  username?: string;
  /** Opaque cursor for inbound long-poll. */
  syncBuf?: string;
}

/** Per-contact runtime state (not persisted in DB). */
interface ContactRuntime {
  contactId: string;
  config: WeChatContactConfig;
  contextToken: string | null;
  syncBuf: string;
  abortController: AbortController | null;
  loopPromise: Promise<void> | null;
}

export interface WeChatAdapterDeps {
  log: { info: (msg: string, meta?: Record<string, unknown>) => void; error: (msg: string, meta?: Record<string, unknown>) => void };
  /** Callback to persist syncBuf + contextToken back to contact config. */
  persistConfig: (contactId: string, patch: Partial<WeChatContactConfig & { contextToken?: string }>) => void;
  /** Broadcast a change so the frontend refreshes. */
  broadcast: () => void;
  /** Disable a contact (set enabled=false). Called on token expiry. */
  disableContact?: (contactId: string) => void;
  /** Notify agent session about a contact issue. */
  notifyAgent?: (message: string) => void;
}

export class WeChatMessengerAdapter implements SendAdapter {
  private runtimes = new Map<string, ContactRuntime>();

  constructor(private deps: WeChatAdapterDeps) {}

  /** Start poll loop for a contact. Idempotent. */
  activate(contact: Contact): void {
    if (this.runtimes.has(contact.id)) return;
    const cfg = contact.config as unknown as WeChatContactConfig;
    if (!cfg.token || !cfg.baseUrl) return;

    const rt: ContactRuntime = {
      contactId: contact.id,
      config: cfg,
      contextToken: (contact.config as any).contextToken ?? null,
      syncBuf: cfg.syncBuf ?? "",
      abortController: null,
      loopPromise: null,
    };
    this.runtimes.set(contact.id, rt);
    this.startPollLoop(rt);
  }

  /** Stop poll loop for a contact. */
  deactivate(contactId: string): void {
    const rt = this.runtimes.get(contactId);
    if (!rt) return;
    rt.abortController?.abort();
    this.runtimes.delete(contactId);
  }

  /** Stop all loops. */
  shutdown(): void {
    for (const rt of this.runtimes.values()) {
      rt.abortController?.abort();
    }
    this.runtimes.clear();
  }

  async send(contact: Contact, text: string): Promise<{ delivered: boolean; error?: string }> {
    const rt = this.runtimes.get(contact.id);
    if (!rt) {
      return { delivered: false, error: "Contact not activated (no poll loop running)" };
    }
    if (!rt.contextToken) {
      return {
        delivered: false,
        error: "No context_token yet — the contact must send at least one message to the bot first",
      };
    }
    try {
      await sendTextMessage({
        baseUrl: rt.config.baseUrl,
        token: rt.config.token,
        ilinkUserId: rt.config.ilinkUserId,
        contextToken: rt.contextToken,
        text,
        botAgent: TIANSHU_BOT_AGENT,
        channelVersion: CHANNEL_VERSION,
      });
      return { delivered: true };
    } catch (err) {
      return { delivered: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Is the contact ready to send (has context_token)? */
  isReady(contactId: string): boolean {
    return !!this.runtimes.get(contactId)?.contextToken;
  }

  // ── internal poll loop ──────────────────────────────────────

  private startPollLoop(rt: ContactRuntime): void {
    rt.abortController = new AbortController();
    const signal = rt.abortController.signal;
    rt.loopPromise = this.runPollLoop(rt, signal).catch((err) => {
      this.deps.log.error(`messenger wechat poll loop error (${rt.contactId})`, err);
    });
  }

  private async runPollLoop(rt: ContactRuntime, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const resp = await getUpdates({
          baseUrl: rt.config.baseUrl,
          token: rt.config.token,
          get_updates_buf: rt.syncBuf,
          abortSignal: signal,
          botAgent: TIANSHU_BOT_AGENT,
          channelVersion: CHANNEL_VERSION,
        });

        // Check for stale token — auto-disable the contact so the
        // UI greys it out, and notify the agent.
        if (resp.errcode && STALE_TOKEN_ERRCODES.has(resp.errcode)) {
          this.deps.log.error(
            `messenger wechat token stale for ${rt.contactId}, stopping poll`,
          );
          this.deps.disableContact?.(rt.contactId);
          this.deps.notifyAgent?.(
            `[Messenger] 微信联系人 token 已过期，已自动禁用。请重新扫码添加。`,
          );
          this.deps.broadcast();
          return;
        }

        // Update sync cursor
        if (resp.get_updates_buf) {
          rt.syncBuf = resp.get_updates_buf;
          this.deps.persistConfig(rt.contactId, { syncBuf: rt.syncBuf });
        }

        // Extract context_token from any inbound message (we don't
        // care about message content — just the token).
        for (const msg of resp.msgs ?? []) {
          if (msg.context_token) {
            const wasNull = !rt.contextToken;
            rt.contextToken = msg.context_token;
            this.deps.persistConfig(rt.contactId, {
              contextToken: msg.context_token,
            });
            // First activation: notify frontend so the badge disappears
            if (wasNull) this.deps.broadcast();
          }
        }

        // Small backoff between successful polls
        await sleep(POLL_BACKOFF_MS, signal);
      } catch (err) {
        if (signal.aborted) return;
        this.deps.log.error(
          `messenger wechat poll error (${rt.contactId}): ${err instanceof Error ? err.message : String(err)}`,
        );
        await sleep(POLL_ERROR_BACKOFF_MS, signal);
      }
    }
  }
}

// ── QR login helpers (exposed for server routes) ────────────────

export async function startQrLogin(): Promise<QrCodeResponse> {
  return getBotQrCode({ baseUrl: ILINK_BASE_URL });
}

export async function pollQrLogin(qrcode: string): Promise<QrCodeStatusResponse> {
  return getQrCodeStatus({ qrcode });
}

// ── util ────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
