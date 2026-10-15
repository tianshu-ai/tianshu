// Messenger plugin — server entry.
//
// Contact types:
//   - wechat: iLink binding (send-only, poll-based token refresh)
//   - a2a: agent-to-agent — remote tianshu instance, HTTP POST with bearer key
//   - ws: generic WebSocket endpoint (TODO phase 2)

import type {
  PluginContext,
  PluginServerExports,
  PluginServerModule,
  PluginRouteHandler,
} from "@tianshu-ai/plugin-sdk";
import type { SessionInboxCapability } from "@tianshu-ai/plugin-sdk";
import type { Request, Response } from "express";
import { appendFileSync } from "node:fs";
import { ensureSchema } from "./schema.js";
import {
  listContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  listMessages,
  logMessage,
  getAgentCard,
  setAgentCard,
  type ContactType,
} from "./schema.js";
import { buildSendMessageTool, type SendAdapter } from "./tool.js";
import { buildUpdateAgentCardTool } from "./agent-card-tool.js";
import {
  WeChatMessengerAdapter,
  startQrLogin,
  pollQrLogin,
} from "./adapters/wechat.js";
import { A2aMessengerAdapter } from "./adapters/a2a.js";
import type { BridgeTokenCapability } from "@tianshu-ai/plugin-sdk";

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    ensureSchema(ctx.db);

    // ── session inbox (notify agent on contact changes) ──────────
    const inbox = ctx.capabilities.get<SessionInboxCapability>("host.sessionInbox");

    const notifyAgent = (message: string) => {
      if (!inbox) return;
      const row = ctx.db
        .prepare(
          `SELECT id FROM sessions
           WHERE kind = 'user'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get() as { id: string } | undefined;
      if (!row) return;
      appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] notifyAgent tenant=${ctx.tenantId} session=${row.id} msg=${message.slice(0, 80)}\n`);
      try {
        void inbox.enqueue(row.id, { kind: "system_note", text: message });
      } catch { /* best-effort */ }
    };

    /** Push an A2A message to the most recent user session. */
    const notifyA2a = (sender: string, text: string) => {
      if (!inbox) return;
      const row = ctx.db
        .prepare(
          `SELECT id FROM sessions
           WHERE kind = 'user'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get() as { id: string } | undefined;
      if (!row) return;
      appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] notifyA2a tenant=${ctx.tenantId} session=${row.id} sender=${sender} text=${text.slice(0, 80)}\n`);
      try {
        void inbox.enqueue(row.id, {
          kind: "a2a_message",
          text,
          meta: { sender, from: "a2a" },
        });
      } catch { /* best-effort */ }
    };

    const contactSummary = () => {
      const all = listContacts(ctx.db);
      if (all.length === 0) return "当前无联系人。";
      return all.map((c) => `- ${c.name} (${c.type}${c.enabled ? "" : ", disabled"})`).join("\n");
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

    for (const c of listContacts(ctx.db)) {
      if (c.type === "wechat" && c.enabled) {
        wechatAdapter.activate(c);
      }
    }

    // ── A2A adapter ─────────────────────────────────────────────
    const a2aAdapter = new A2aMessengerAdapter({ log: ctx.log });

    // ── adapters map ────────────────────────────────────────────
    const adapters = new Map<string, SendAdapter>();
    adapters.set("wechat", wechatAdapter);
    adapters.set("a2a", a2aAdapter);

    ctx.log.info("messenger activated", {
      adapters: [...adapters.keys()],
      contacts: listContacts(ctx.db).length,
    });

    // ── tool ────────────────────────────────────────────────────
    const sendMessageTool = buildSendMessageTool({ db: ctx.db, adapters });

    /** Resolve this instance's public URL. */
    function resolvePublicUrl(req?: Request): string {
      const cfgUrl = (ctx.pluginConfig as Record<string, unknown>).publicUrl;
      if (cfgUrl) return String(cfgUrl).replace(/\/$/, "");
      if (req) {
        const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
        const host = req.headers["x-forwarded-host"] || req.headers.host;
        if (host) return `${proto}://${host}`.replace(/\/$/, "");
      }
      return "";
    }

    // ── Bridge token capability for A2A ──────────────────────────
    const bridgeToken = ctx.capabilities.get<BridgeTokenCapability>("host.bridgeToken");

    // ── REST routes ─────────────────────────────────────────────
    const routes: Record<string, PluginRouteHandler> = {
      // GET /contacts
      listContacts: (_req: Request, res: Response) => {
        const contacts = listContacts(ctx.db);
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
        if (type !== "wechat" && type !== "ws" && type !== "a2a") {
          res.status(400).json({ ok: false, error: "type must be 'wechat', 'ws', or 'a2a'" });
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
        try {
          if (type === "wechat") wechatAdapter.activate(contact);
        } catch { /* best-effort */ }
        // A2A: send handshake with own pairing info so remote can auto-add us back
        if (type === "a2a" && bridgeToken) {
          const capturedReq = req; // capture for async
          void (async () => {
            try {
              const branding = ctx.tenantConfig?.branding ?? {};
              const myName = (branding.name as string) || "Tianshu";
              const grant = bridgeToken.mint("a2a-peer");
              const myPublicUrl = resolvePublicUrl(capturedReq);
              const myPairUrl = myPublicUrl
                ? `${myPublicUrl}/api/p/messenger/a2a/receive?token=${grant.token}`
                : null;
              const handshake = JSON.stringify({
                _a2a_handshake: true,
                name: myName,
                pairUrl: myPairUrl,
                token: grant.token,
                endpoint: myPublicUrl ? `${myPublicUrl}/api/p/messenger/a2a/receive` : null,
              });
              const result = await a2aAdapter.send(contact, handshake);
              if (!result.delivered) {
                ctx.log.warn("a2a handshake failed", { contact: contact.name, error: result.error });
              }
            } catch (err) {
              ctx.log.warn("a2a handshake error", { error: err });
            }
          })();
        }
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

      qrStart: async (_req: Request, res: Response) => {
        try {
          const resp = await startQrLogin();
          if (!resp.qrcode || !resp.qrcode_img_content) {
            res.status(502).json({ ok: false, error: "iLink returned empty QR" });
            return;
          }
          res.json({ ok: true, qrcode: resp.qrcode, qrCodeImageUrl: resp.qrcode_img_content });
        } catch (err) {
          res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      },

      qrPoll: async (req: Request, res: Response) => {
        const { qrcode, name } = (req.body ?? {}) as { qrcode?: string; name?: string };
        if (!qrcode) { res.status(400).json({ ok: false, error: "missing qrcode" }); return; }
        try {
          const resp = await pollQrLogin(qrcode);
          const status = resp.status ?? "wait";
          if (status === "confirmed" && resp.bot_token) {
            const baseUrl = resp.baseurl?.trim() || "https://ilinkai.weixin.qq.com";
            const contact = createContact(ctx.db, {
              name: name?.trim() || resp.username || "WeChat Contact",
              type: "wechat",
              config: { token: resp.bot_token, baseUrl, ilinkUserId: resp.ilink_user_id, username: resp.username },
              waitReply: false,
            });
            ctx.broadcast("messenger_changed", {});
            notifyAgent(`[Messenger] 新增联系人「${contact.name}」(wechat)\n\n当前联系人列表:\n${contactSummary()}`);
            try { wechatAdapter.activate(contact); } catch { /* */ }
            res.json({ ok: true, scanned: true, status: "confirmed", contact });
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
      },

      rebindPoll: async (req: Request, res: Response) => {
        const { qrcode, contactId } = (req.body ?? {}) as { qrcode?: string; contactId?: string };
        if (!qrcode || !contactId) { res.status(400).json({ ok: false, error: "missing qrcode or contactId" }); return; }
        const existing = getContact(ctx.db, contactId);
        if (!existing) { res.status(404).json({ ok: false, error: "contact not found" }); return; }
        try {
          const resp = await pollQrLogin(qrcode);
          const status = resp.status ?? "wait";
          if (status === "confirmed" && resp.bot_token) {
            const baseUrl = resp.baseurl?.trim() || "https://ilinkai.weixin.qq.com";
            updateContact(ctx.db, contactId, { enabled: true, config: { token: resp.bot_token, baseUrl, ilinkUserId: resp.ilink_user_id, username: resp.username } });
            ctx.broadcast("messenger_changed", {});
            wechatAdapter.deactivate(contactId);
            const updated = getContact(ctx.db, contactId)!;
            try { wechatAdapter.activate(updated); } catch { /* */ }
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
      },

      // ── Agent Card routes ─────────────────────────────────────

      // GET /agent-card
      getAgentCard: (_req: Request, res: Response) => {
        res.json({ ok: true, card: getAgentCard(ctx.db) });
      },

      // PUT /agent-card
      updateAgentCard: (req: Request, res: Response) => {
        const body = req.body as Record<string, unknown> ?? {};
        const card = setAgentCard(ctx.db, {
          name: typeof body.name === "string" ? body.name : undefined,
          description: typeof body.description === "string" ? body.description : undefined,
        });
        ctx.broadcast("messenger_changed", {});
        res.json({ ok: true, card });
      },

      // GET /agent-card/public — unauthenticated, for A2A discovery
      getAgentCardPublic: (_req: Request, res: Response) => {
        const card = getAgentCard(ctx.db);
        if (!card.name) { res.status(404).json({ error: "agent card not configured" }); return; }
        res.json(card);
      },

      // ── A2A routes ────────────────────────────────────────────

      // POST /a2a/token — mint a session JWT for remote peers (like bridge)
      a2aToken: (req: Request, res: Response) => {
        if (!bridgeToken) {
          res.status(500).json({ ok: false, error: "bridgeToken capability not available" });
          return;
        }
        const grant = bridgeToken.mint("a2a-peer");
        const publicUrl = resolvePublicUrl(req);
        const pairUrl = publicUrl
          ? `${publicUrl}/api/p/messenger/a2a/receive?token=${grant.token}`
          : null;
        res.json({ ok: true, token: grant.token, pairUrl, authEnabled: grant.authEnabled });
      },

      // POST /a2a/receive — receive message from remote peer (authed via session JWT bearer)
      a2aReceive: (req: Request, res: Response) => {
        const { text, sender } = (req.body ?? {}) as { text?: string; sender?: string };
        if (!text) { res.status(400).json({ ok: false, error: "missing text" }); return; }
        appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] a2aReceive tenant=${ctx.tenantId} sender=${sender} text=${text?.slice(0, 80)}\n`);

        // Check if this is a handshake message with pairing info
        try {
          const parsed = JSON.parse(text);
          if (parsed._a2a_handshake && parsed.endpoint && parsed.token) {
            const peerName = String(parsed.name || sender || "Remote Agent");
            // Check if we already have a contact pointing to this endpoint
            const existing = listContacts(ctx.db).find(
              (c) => c.type === "a2a" && (c.config as any).endpoint === parsed.endpoint,
            );
            if (!existing) {
              const contact = createContact(ctx.db, {
                name: peerName,
                type: "a2a",
                config: { endpoint: parsed.endpoint, apiKey: parsed.token },
              });
              ctx.broadcast("messenger_changed", {});
              notifyAgent(
                `[Messenger A2A] 「${peerName}」已自动配对\n\n当前联系人列表:\n${contactSummary()}`,
              );
              ctx.log.info("a2a auto-paired", { peer: peerName, contactId: contact.id });
            } else {
              ctx.log.info("a2a handshake from existing peer, skipping", { peer: peerName });
            }
            res.json({ ok: true, handshake: true });
            return;
          }
        } catch { /* not JSON, treat as normal message */ }

        // Try to find the contact name from our local contacts list.
        // The sender field from the request is unreliable; prefer our own name.
        const allContacts = listContacts(ctx.db).filter((c) => c.type === "a2a");
        const matchedContact = allContacts.length === 1
          ? allContacts[0]
          : allContacts.find((c) => sender && c.name.toLowerCase().includes(sender.toLowerCase()));
        const senderLabel = matchedContact?.name || sender || "Remote Agent";

        // Save received message to messenger history
        if (matchedContact) {
          logMessage(ctx.db, {
            contactId: matchedContact.id,
            direction: "inbound",
            text,
            status: "received",
          });
        }

        notifyA2a(senderLabel, text);

        res.json({ ok: true });
      },
    };

    return {
      tools: {
        SendMessageTool: sendMessageTool,
        UpdateAgentCardTool: buildUpdateAgentCardTool(ctx.db),
      },
      routes,
    };
  },
};

export default plugin;
