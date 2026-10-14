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

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    ensureSchema(ctx.db);

    // ── session inbox (notify agent on contact changes) ──────────
    const inbox = ctx.capabilities.get<SessionInboxCapability>("host.sessionInbox");

    /** Push a system note to the most recent webchat session. */
    const notifyAgent = (message: string) => {
      if (!inbox) return;
      // Find most recent webchat session
      const row = ctx.db
        .prepare(
          `SELECT id FROM sessions
           WHERE channel_id = 'webchat' AND kind = 'user'
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
    });

    // Activate poll loops for all enabled wechat contacts
    for (const c of listContacts(ctx.db)) {
      if (c.type === "wechat" && c.enabled) {
        wechatAdapter.activate(c);
      }
    }

    // ── adapters map ────────────────────────────────────────────
    const adapters = new Map<string, SendAdapter>();
    adapters.set("wechat", wechatAdapter);

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
        if (type !== "wechat" && type !== "ws") {
          res.status(400).json({ ok: false, error: "type must be 'wechat' or 'ws'" });
          return;
        }
        const contact = createContact(ctx.db, {
          name,
          type: type as ContactType,
          config: config ?? {},
          waitReply: !!waitReply,
        });
        // Start poll loop for wechat contacts
        if (type === "wechat") wechatAdapter.activate(contact);
        ctx.broadcast("messenger_changed", {});
        notifyAgent(`[Messenger] 新增联系人「${contact.name}」(${contact.type})\n\n当前联系人列表:\n${contactSummary()}`);
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
            // Start poll loop immediately
            wechatAdapter.activate(contact);
            ctx.broadcast("messenger_changed", {});
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

    return {
      tools: { SendMessageTool: sendMessageTool },
      routes,
    };
  },
};

export default plugin;
