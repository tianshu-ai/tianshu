// Messenger plugin — server entry.
//
// Two contact types:
//   - wechat: own iLink binding per contact (send-only, no inbound routing)
//   - ws: A2A protocol over WebSocket (TODO phase 2)
//
// WeChat contacts use a dedicated QR login flow that creates a
// bot↔user pair. A lightweight poll loop captures context_tokens
// (required by iLink sendmessage) without routing messages to
// any agent session.

import type {
  PluginContext,
  PluginServerExports,
  PluginServerModule,
  PluginRouteHandler,
} from "@tianshu-ai/plugin-sdk";
import type { SessionInboxCapability } from "@tianshu-ai/plugin-sdk";
import type { Request, Response } from "express";
import { ensureSchema } from "./schema.js";
import {
  listContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  listMessages,
  type ContactType,
} from "./schema.js";
import { buildSendMessageTool, type SendAdapter } from "./tool.js";
import {
  WeChatMessengerAdapter,
  startQrLogin,
  pollQrLogin,
} from "./adapters/wechat.js";
import { TianshuMessengerAdapter } from "./adapters/tianshu.js";
import {
  createInvite,
  getInviteByCode,
  markInviteUsed,
  genToken,
  type TianshuContactConfig,
} from "./schema.js";

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    ensureSchema(ctx.db);

    // ── session inbox (notify agent on contact changes) ──────────
    const inbox = ctx.capabilities.get<SessionInboxCapability>("host.sessionInbox");

    /** Push a system note to the most recent webchat session. */
    const notifyAgent = (message: string) => {
      if (!inbox) return;
      // Find most recent user session (channel_id may be empty for
      // webchat sessions created before the column was backfilled).
      const row = ctx.db
        .prepare(
          `SELECT id FROM sessions
           WHERE kind = 'user'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get() as { id: string } | undefined;
      if (!row) return;
      try {
        void inbox.enqueue(row.id, { kind: "system_note", text: message });
      } catch { /* best-effort */ }
    };

    /** Build a contact summary for agent notifications. */
    const contactSummary = () => {
      const all = listContacts(ctx.db);
      if (all.length === 0) return "当前无联系人。";
      return all.map((c) => `- ${c.name} (${c.type}${c.enabled ? "" : ", disabled"})`).
        join("\n");
    };

    // ── WeChat adapter ──────────────────────────────────────────
    const wechatAdapter = new WeChatMessengerAdapter({
      log: ctx.log,
      persistConfig: (contactId, patch) => {
        const contact = getContact(ctx.db, contactId);
        if (!contact) return;
        const merged = { ...contact.config, ...patch };
        updateContact(ctx.db, contactId, { config: merged });
      },
      broadcast: () => ctx.broadcast("messenger_changed", {}),
      disableContact: (contactId) => {
        const c = getContact(ctx.db, contactId);
        if (!c) return;
        updateContact(ctx.db, contactId, {
          enabled: false,
          config: { ...c.config, disabledReason: "token_expired" },
        });
      },
      notifyAgent: (message) => notifyAgent(message),
    });

    // Activate poll loops for all enabled wechat contacts
    for (const c of listContacts(ctx.db)) {
      if (c.type === "wechat" && c.enabled) {
        wechatAdapter.activate(c);
      }
    }

    // ── Tianshu adapter ─────────────────────────────────────────
    const tianshuAdapter = new TianshuMessengerAdapter({ log: ctx.log });

    // ── adapters map ────────────────────────────────────────────
    const adapters = new Map<string, SendAdapter>();
    adapters.set("wechat", wechatAdapter);
    adapters.set("tianshu", tianshuAdapter);

    ctx.log.info("messenger activated", {
      adapters: [...adapters.keys()],
      contacts: listContacts(ctx.db).length,
    });

    // ── tool ────────────────────────────────────────────────────
    const sendMessageTool = buildSendMessageTool({ db: ctx.db, adapters });

    // ── REST routes ─────────────────────────────────────────────
    const routes: Record<string, PluginRouteHandler> = {
      // GET /contacts
      listContacts: (_req: Request, res: Response) => {
        const contacts = listContacts(ctx.db);
        // Annotate wechat contacts with readiness status
        const enriched = contacts.map((c) => ({
          ...c,
          ready: c.type === "wechat" ? wechatAdapter.isReady(c.id) : true,
        }));
        res.json({ ok: true, contacts: enriched });
      },

      // POST /contacts
      createContact: (req: Request, res: Response) => {
        const { name, type, config, waitReply } = req.body ?? {};
        if (!name || !type) {
          res.status(400).json({ ok: false, error: "name and type are required" });
          return;
        }
        if (type !== "wechat" && type !== "ws" && type !== "tianshu") {
          res.status(400).json({ ok: false, error: "type must be 'wechat', 'ws', or 'tianshu'" });
          return;
        }
        const contact = createContact(ctx.db, {
          name,
          type: type as ContactType,
          config: config ?? {},
          waitReply: !!waitReply,
        });
        ctx.broadcast("messenger_changed", {});
        notifyAgent(`[Messenger] 新增联系人「${contact.name}」(${contact.type})\n\n当前联系人列表:\n${contactSummary()}`);
        // Start poll loop for wechat contacts (after notification,
        // since activate may throw on missing config/binding).
        try {
          if (type === "wechat") wechatAdapter.activate(contact);
        } catch { /* best-effort, notification already sent */ }
        res.json({ ok: true, contact });
      },

      // PUT /contacts/:id
      updateContact: (req: Request, res: Response) => {
        const id = (req as any).params?.id;
        if (!id) { res.status(400).json({ ok: false, error: "id required" }); return; }
        const { name, config, waitReply, enabled } = req.body ?? {};
        const updates: Record<string, unknown> = {};
        if (name !== undefined) updates.name = name;
        if (config !== undefined) updates.config = config;
        if (waitReply !== undefined) updates.waitReply = waitReply;
        if (enabled !== undefined) updates.enabled = enabled;
        const ok = updateContact(ctx.db, id, updates as any);
        if (ok) {
          const contact = getContact(ctx.db, id);
          if (contact?.type === "wechat") {
            wechatAdapter.deactivate(id);
            if (contact.enabled) wechatAdapter.activate(contact);
          }
          ctx.broadcast("messenger_changed", {});
          if (contact) {
            notifyAgent(`[Messenger] 联系人「${contact.name}」已更新\n\n当前联系人列表:\n${contactSummary()}`);
          }
        }
        res.json({ ok });
      },

      // DELETE /contacts/:id
      deleteContact: (req: Request, res: Response) => {
        const id = (req as any).params?.id;
        if (!id) { res.status(400).json({ ok: false, error: "id required" }); return; }
        const contact = getContact(ctx.db, id);
        const contactName = contact?.name ?? id;
        wechatAdapter.deactivate(id);
        const ok = deleteContact(ctx.db, id);
        if (ok) {
          ctx.broadcast("messenger_changed", {});
          notifyAgent(`[Messenger] 联系人「${contactName}」已删除\n\n当前联系人列表:\n${contactSummary()}`);
        }
        res.json({ ok });
      },

      // GET /contacts/:id/messages
      listMessages: (req: Request, res: Response) => {
        const id = (req as any).params?.id;
        if (!id) { res.status(400).json({ ok: false, error: "id required" }); return; }
        const contact = getContact(ctx.db, id);
        if (!contact) { res.status(404).json({ ok: false, error: "not found" }); return; }
        const limit = parseInt(String(req.query?.limit ?? "50"), 10);
        const messages = listMessages(ctx.db, id, Math.min(limit, 200));
        res.json({ ok: true, messages });
      },

      // POST /contacts/:id/test
      testContact: async (req: Request, res: Response) => {
        const id = (req as any).params?.id;
        if (!id) { res.status(400).json({ ok: false, error: "id required" }); return; }
        const contact = getContact(ctx.db, id);
        if (!contact) { res.status(404).json({ ok: false, error: "not found" }); return; }
        const adapter = adapters.get(contact.type);
        if (!adapter) {
          res.json({ ok: false, error: `No adapter for type "${contact.type}"` });
          return;
        }
        try {
          const result = await adapter.send(contact, "[Test] Messenger connectivity check ✅");
          res.json({ ok: result.delivered, error: result.error });
        } catch (err) {
          res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      },

      // ── WeChat QR login flow ──────────────────────────────────

      // POST /wechat/qr/start → { ok, qrcode, qrCodeImageUrl }
      qrStart: async (_req: Request, res: Response) => {
        try {
          const resp = await startQrLogin();
          if (!resp.qrcode || !resp.qrcode_img_content) {
            res.status(502).json({ ok: false, error: "iLink returned empty QR" });
            return;
          }
          res.json({
            ok: true,
            qrcode: resp.qrcode,
            qrCodeImageUrl: resp.qrcode_img_content,
          });
        } catch (err) {
          res.status(502).json({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },

      // POST /wechat/qr/poll { qrcode, name }
      //   → { ok, scanned: false }   while pending
      //   → { ok, scanned: true, contact } on confirm
      qrPoll: async (req: Request, res: Response) => {
        const { qrcode, name } = (req.body ?? {}) as {
          qrcode?: string;
          name?: string;
        };
        if (!qrcode) {
          res.status(400).json({ ok: false, error: "missing qrcode" });
          return;
        }
        try {
          const resp = await pollQrLogin(qrcode);
          const status = resp.status ?? "wait";

          if (status === "confirmed" && resp.bot_token) {
            // Success: create messenger contact with iLink credentials
            const baseUrl = resp.baseurl?.trim() || "https://ilinkai.weixin.qq.com";
            const contact = createContact(ctx.db, {
              name: name?.trim() || resp.username || "WeChat Contact",
              type: "wechat",
              config: {
                token: resp.bot_token,
                baseUrl,
                ilinkUserId: resp.ilink_user_id,
                username: resp.username,
              },
              waitReply: false,
            });
            ctx.broadcast("messenger_changed", {});
            notifyAgent(`[Messenger] 新增联系人「${contact.name}」(wechat)\n\n当前联系人列表:\n${contactSummary()}`);
            // Start poll loop immediately
            try { wechatAdapter.activate(contact); } catch { /* best-effort */ }
            res.json({ ok: true, scanned: true, status: "confirmed", contact });
            return;
          }

          if (status === "expired" || status === "verify_code_blocked") {
            res.status(410).json({
              ok: false,
              scanned: false,
              status,
              error: status === "expired"
                ? "QR expired; try again."
                : "Too many attempts; try later.",
            });
            return;
          }

          // Still pending
          res.json({ ok: true, scanned: false, status });
        } catch (err) {
          res.status(502).json({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    };

    // POST /wechat/rebind/poll { qrcode, contactId }
    //   Same as qr/poll but updates existing contact instead of creating new
    routes.rebindPoll = async (req: Request, res: Response) => {
      const { qrcode, contactId } = (req.body ?? {}) as { qrcode?: string; contactId?: string };
      if (!qrcode || !contactId) {
        res.status(400).json({ ok: false, error: "missing qrcode or contactId" });
        return;
      }
      const existing = getContact(ctx.db, contactId);
      if (!existing) {
        res.status(404).json({ ok: false, error: "contact not found" });
        return;
      }
      try {
        const resp = await pollQrLogin(qrcode);
        const status = resp.status ?? "wait";
        if (status === "confirmed" && resp.bot_token) {
          const baseUrl = resp.baseurl?.trim() || "https://ilinkai.weixin.qq.com";
          const newConfig = {
            token: resp.bot_token,
            baseUrl,
            ilinkUserId: resp.ilink_user_id,
            username: resp.username,
          };
          updateContact(ctx.db, contactId, { enabled: true, config: newConfig });
          ctx.broadcast("messenger_changed", {});
          // Restart poll loop
          wechatAdapter.deactivate(contactId);
          const updated = getContact(ctx.db, contactId)!;
          try { wechatAdapter.activate(updated); } catch { /* best-effort */ }
          notifyAgent(`[Messenger] 联系人「${existing.name}」已重新绑定微信`);
          res.json({ ok: true, scanned: true, status: "confirmed" });
          return;
        }
        if (status === "expired" || status === "verify_code_blocked") {
          res.status(410).json({ ok: false, scanned: false, status, error: status === "expired" ? "QR expired; try again." : "Too many attempts; try later." });
          return;
        }
        res.json({ ok: true, scanned: false, status });
      } catch (err) {
        res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    };

    // ── Tianshu peering routes ───────────────────────────────────

    function getAgentCard(): Record<string, unknown> {
      const branding = ctx.tenantConfig?.branding ?? {};
      return {
        name: (branding.name as string) || "Tianshu Agent",
        emoji: (branding.emoji as string) || "⭐",
      };
    }

    // POST /tianshu/invite — generate invite code
    routes.tianshuInvite = (_req: Request, res: Response) => {
      const invite = createInvite(ctx.db);
      res.json({ ok: true, code: invite.code, expiresAt: invite.expiresAt });
    };

    // POST /tianshu/pair — called by REMOTE to accept invite (public, no session auth)
    routes.tianshuPair = (req: Request, res: Response) => {
      const { code, endpointUrl, agentCard, returnToken } = (req.body ?? {}) as {
        code?: string; endpointUrl?: string;
        agentCard?: Record<string, unknown>; returnToken?: string;
      };
      if (!code || !endpointUrl || !agentCard || !returnToken) {
        res.status(400).json({ ok: false, error: "missing fields" });
        return;
      }
      const invite = getInviteByCode(ctx.db, code);
      if (!invite) { res.status(404).json({ ok: false, error: "invalid invite" }); return; }
      if (invite.usedBy) { res.status(409).json({ ok: false, error: "invite used" }); return; }
      if (Date.now() > invite.expiresAt) { res.status(410).json({ ok: false, error: "invite expired" }); return; }

      const inboundToken = genToken();
      const peerName = String(agentCard.name || "Remote Tianshu");

      const contact = createContact(ctx.db, {
        name: peerName,
        type: "tianshu",
        config: {
          endpointUrl,
          authToken: returnToken,
          inboundToken,
          agentCard,
        } satisfies TianshuContactConfig,
      });
      markInviteUsed(ctx.db, invite.id, contact.id);
      ctx.broadcast("messenger_changed", {});
      notifyAgent(`[Messenger] 新的 tianshu 连接：「${peerName}」(${endpointUrl})`);

      res.json({ ok: true, peerToken: inboundToken, agentCard: getAgentCard() });
    };

    // POST /tianshu/connect — called by LOCAL user to pair with remote
    routes.tianshuConnect = async (req: Request, res: Response) => {
      const { code, remoteUrl } = (req.body ?? {}) as { code?: string; remoteUrl?: string };
      if (!code || !remoteUrl) {
        res.status(400).json({ ok: false, error: "missing code or remoteUrl" });
        return;
      }

      const publicUrl = String((ctx.pluginConfig as Record<string, unknown>).publicUrl || "");
      if (!publicUrl) {
        res.status(400).json({ ok: false, error: "publicUrl not configured in messenger plugin settings" });
        return;
      }

      const inboundToken = genToken();

      try {
        const resp = await fetch(`${remoteUrl.replace(/\/$/, "")}/api/p/messenger/tianshu/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: code.toUpperCase(),
            endpointUrl: publicUrl,
            agentCard: getAgentCard(),
            returnToken: inboundToken,
          }),
          signal: AbortSignal.timeout(15000),
        });

        const body = await resp.json() as Record<string, unknown>;
        if (!resp.ok || !body.ok) {
          res.status(resp.status >= 400 ? resp.status : 502).json({ ok: false, error: body.error || `HTTP ${resp.status}` });
          return;
        }

        const remoteCard = (body.agentCard as Record<string, unknown>) || {};
        const peerName = String(remoteCard.name || "Remote Tianshu");

        const contact = createContact(ctx.db, {
          name: peerName,
          type: "tianshu",
          config: {
            endpointUrl: remoteUrl,
            authToken: String(body.peerToken),
            inboundToken,
            agentCard: remoteCard,
          } satisfies TianshuContactConfig,
        });

        ctx.broadcast("messenger_changed", {});
        notifyAgent(`[Messenger] 已连接到 tianshu 实例：「${peerName}」(${remoteUrl})`);

        res.json({ ok: true, contact: { id: contact.id, name: peerName } });
      } catch (err) {
        res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    };

    // POST /tianshu/receive — receive message from remote peer (public)
    routes.tianshuReceive = (req: Request, res: Response) => {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!token) { res.status(401).json({ ok: false, error: "unauthorized" }); return; }

      // Find the peer contact by inbound token
      const all = listContacts(ctx.db);
      const contact = all.find((c) => {
        if (c.type !== "tianshu" || !c.enabled) return false;
        const cfg = c.config as unknown as TianshuContactConfig;
        return cfg.inboundToken === token;
      });
      if (!contact) { res.status(403).json({ ok: false, error: "invalid token" }); return; }

      const { text, sender } = (req.body ?? {}) as { text?: string; sender?: string };
      if (!text) { res.status(400).json({ ok: false, error: "missing text" }); return; }

      // Notify agent with the incoming message
      notifyAgent(`[Messenger] 来自「${contact.name}」的消息：${text}`);
      ctx.broadcast("messenger_tianshu_message", {
        contactId: contact.id, contactName: contact.name,
        sender: sender || contact.name, text,
      });

      res.json({ ok: true });
    };

    // GET /tianshu/self — get own public URL + agent card
    routes.tianshuSelf = (_req: Request, res: Response) => {
      const publicUrl = String((ctx.pluginConfig as Record<string, unknown>).publicUrl || "");
      res.json({ ok: true, publicUrl, agentCard: getAgentCard() });
    };

    return {
      tools: { SendMessageTool: sendMessageTool },
      routes,
    };
  },
};

export default plugin;
