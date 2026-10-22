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

import { createDecipheriv } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
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
import { uploadAndSendFile, uploadMedia, sendVoiceMessage, UploadMediaType, ILINK_CDN_BASE_URL } from "@tianshu-builtin/plugin-wechat/ilink-media";

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

/** Parsed inbound message from a WeChat contact. */
export interface WeChatInboundMessage {
  contactId: string;
  contactName: string;
  /** Raw text content of the message. */
  text: string;
  /** iLink message type (1=text, 3=image, 34=voice, etc.) */
  msgType?: number;
  /** Unix timestamp (seconds) from the message. */
  timestamp?: number;
}

/** Decrypt AES-128-ECB with PKCS7 padding (matches iLink CDN encryption). */
function decryptAesEcb(ciphertext: Buffer, keyHex: string): Buffer {
  const key = Buffer.from(keyHex, "hex");
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
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
  /** Called for each inbound message from a WeChat contact.
   *  This is the hook that turns the adapter from send-only to bidirectional. */
  onMessage?: (msg: WeChatInboundMessage) => void;
  /** Workspace directory for saving downloaded media files. */
  workspaceDir?: string;
  /** Resolve user home directory by userId. */
  userHomeDir?: (userId: string) => string;
  /** Look up user_id for a contact. */
  contactUserId?: (contactId: string) => string | undefined;
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
    this.deps.log.info(`[wechat-send] contactId=${contact.id} text=${text.slice(0, 40)}`);
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

  /** Send a file (image/video/document) to a contact. */
  async sendFile(contact: Contact, filePath: string): Promise<{ delivered: boolean; error?: string }> {
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
      await uploadAndSendFile({
        baseUrl: rt.config.baseUrl,
        token: rt.config.token,
        ilinkUserId: rt.config.ilinkUserId,
        contextToken: rt.contextToken,
        filePath,
        botAgent: TIANSHU_BOT_AGENT,
        channelVersion: CHANNEL_VERSION,
      });
      return { delivered: true };
    } catch (err) {
      return { delivered: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Send voice message: WAV → silk encode → upload as VOICE type → send as voice bubble. */
  async sendVoice(contact: Contact, wavPath: string): Promise<{ delivered: boolean; error?: string }> {
    const rt = this.runtimes.get(contact.id);
    if (!rt) return { delivered: false, error: "Contact not activated" };
    if (!rt.contextToken) return { delivered: false, error: "No context_token yet" };
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const { encode } = await import("silk-wasm");

      // Read WAV, strip 44-byte header to get raw PCM
      const wav = await fs.readFile(wavPath);
      const pcm = wav.slice(44);

      // Encode PCM → silk (24kHz mono s16le)
      const silkResult = await encode(pcm, 24000);
      // console.log(`[messenger/wechat] silk encoded: ${silkResult.data.length} bytes, ${silkResult.duration}ms`);

      // Write silk to temp file
      const silkPath = wavPath.replace(/\.wav$/, ".silk");
      await fs.writeFile(silkPath, silkResult.data);

      // Upload as VOICE type
      const uploaded = await uploadMedia({
        filePath: silkPath,
        toUserId: rt.config.ilinkUserId,
        mediaType: UploadMediaType.VOICE,
        baseUrl: rt.config.baseUrl,
        token: rt.config.token,
        cdnBaseUrl: ILINK_CDN_BASE_URL,
        botAgent: TIANSHU_BOT_AGENT,
        channelVersion: CHANNEL_VERSION,
      });
      // console.log(`[messenger/wechat] voice uploaded: filekey=${uploaded.filekey}`);

      // Send as voice message
      const sendResp = await sendVoiceMessage({
        baseUrl: rt.config.baseUrl,
        token: rt.config.token,
        ilinkUserId: rt.config.ilinkUserId,
        contextToken: rt.contextToken,
        uploaded,
        voiceDuration: silkResult.duration,
        botAgent: TIANSHU_BOT_AGENT,
        channelVersion: CHANNEL_VERSION,
      });
      // console.log(`[messenger/wechat] sendVoiceMessage resp:`, JSON.stringify(sendResp));

      // Clean up silk temp file
      await fs.unlink(silkPath).catch(() => {});
      return { delivered: true };
    } catch (err) {
      return { delivered: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Is the contact ready to send (has context_token)? */
  isReady(contactId: string): boolean {
    return !!this.runtimes.get(contactId)?.contextToken;
  }

  // ── image download ────────────────────────────────────────

  /** Download + decrypt an iLink CDN image, save to user home uploads.
   *  Returns the user-home-relative path (for use with /api/p/files/raw). */
  private async downloadImage(cdnUrl: string, aesKeyHex: string, userHome: string): Promise<string> {
    const relDir = path.join("uploads", "wechat");
    const absDir = path.join(userHome, relDir);
    await fs.mkdir(absDir, { recursive: true });
    const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`;
    const absPath = path.join(absDir, filename);

    const resp = await fetch(cdnUrl, { signal: AbortSignal.timeout(30000) });
    if (!resp.ok) throw new Error(`CDN fetch failed: ${resp.status}`);
    const encrypted = Buffer.from(await resp.arrayBuffer());
    const decrypted = decryptAesEcb(encrypted, aesKeyHex);
    await fs.writeFile(absPath, decrypted);
    return path.join(relDir, filename);
  }

  /** Download + decrypt an iLink CDN voice message. */
  private async downloadVoice(cdnUrl: string, aesKeyHex: string, userHome: string): Promise<string> {
    const relDir = path.join("uploads", "wechat");
    const absDir = path.join(userHome, relDir);
    await fs.mkdir(absDir, { recursive: true });
    const filename = `voice_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.silk`;
    const absPath = path.join(absDir, filename);

    const resp = await fetch(cdnUrl, { signal: AbortSignal.timeout(30000) });
    if (!resp.ok) throw new Error(`CDN fetch failed: ${resp.status}`);
    const encrypted = Buffer.from(await resp.arrayBuffer());
    const decrypted = decryptAesEcb(encrypted, aesKeyHex);
    await fs.writeFile(absPath, decrypted);
    return path.join(relDir, filename);
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

        // Extract context_token + route inbound messages.
        for (const msg of resp.msgs ?? []) {
          if (msg.context_token) {
            const wasNull = !rt.contextToken;
            rt.contextToken = msg.context_token;
            this.deps.persistConfig(rt.contactId, {
              contextToken: msg.context_token,
            });
            if (wasNull) this.deps.broadcast();
          }
          // Route inbound message content to the agent session.
          // Debug: log raw message structure for non-text messages
          if (this.deps.log?.info) {
            const hasText = (msg.item_list ?? []).some((it) => it.text_item?.text);
            if (!hasText) {
              this.deps.log.info(`wechat inbound non-text msg`, {
                contactId: rt.contactId,
                message_type: msg.message_type,
                item_count: (msg.item_list ?? []).length,
                items: JSON.stringify((msg.item_list ?? []).slice(0, 3)),
              });
            }
          }
          const parts: string[] = [];
          const items = msg.item_list ?? [];
          if (items.length > 0) {
            for (const item of items) {
              if (item.text_item?.text) {
                parts.push(item.text_item.text);
              } else if (item.image_item) {
                // Try to download and decrypt the image
                const media = (item.image_item as any)?.media;
                const aeskey = (item.image_item as any)?.aeskey || media?.aes_key || "";
                const fullUrl = media?.full_url || item.image_item.image_url || "";
                const userId = this.deps.contactUserId?.(rt.contactId);
                const homeDir = userId && this.deps.userHomeDir ? this.deps.userHomeDir(userId) : null;
                if (fullUrl && aeskey && homeDir) {
                  try {
                    const relPath = await this.downloadImage(fullUrl, aeskey, homeDir);
                    parts.push(`![图片](workspace:///${relPath})`);
                  } catch (err) {
                    this.deps.log.error(`wechat image download failed`, { error: String(err) });
                    parts.push(`[图片]`);
                  }
                } else {
                  parts.push(`[图片]`);
                }
              } else if ((item as any).voice_item) {
                const voiceItem = (item as any).voice_item;
                // WeChat provides STT text directly in voice_item.text
                const sttText = voiceItem?.text || "";
                const duration = voiceItem?.playtime ? `${Math.round(voiceItem.playtime / 1000)}s` : "";
                if (sttText) {
                  parts.push(`[语音${duration ? " " + duration : ""}] ${sttText}`);
                } else {
                  parts.push(`[语音${duration ? " " + duration : ""}]`);
                }
              } else if ((item as any).video_item) {
                parts.push(`[视频]`);
              } else if ((item as any).file_item) {
                parts.push(`[文件]`);
              } else if ((item as any).link_item) {
                const link = (item as any).link_item;
                parts.push(`[链接] ${link.title || link.url || ""}`);
              }
            }
          }
          // Fallback: if item_list was empty but message_type indicates
          // a non-text message, use message_type as hint.
          if (parts.length === 0 && msg.message_type) {
            const typeMap: Record<number, string> = {
              1: "文本", 3: "图片", 34: "语音", 43: "视频",
              47: "表情", 48: "位置", 49: "文件/链接",
            };
            const label = typeMap[msg.message_type] || `消息类型:${msg.message_type}`;
            parts.push(`[${label}]`);
          }
          const text = parts.join("\n");
          if (text && this.deps.onMessage) {
            this.deps.onMessage({
              contactId: rt.contactId,
              contactName: rt.config.username || rt.contactId,
              text,
              msgType: msg.message_type,
              timestamp: msg.create_time_ms ? Math.floor(msg.create_time_ms / 1000) : undefined,
            });
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
