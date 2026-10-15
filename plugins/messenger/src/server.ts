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
  storePairingToken,
  consumePairingToken,
  isScopedTokenAllowed,
} from "./schema.js";
import { buildSendMessageTool, type SendAdapter } from "./tool.js";
import { buildUpdateAgentCardTool } from "./agent-card-tool.js";
import {
  WeChatMessengerAdapter,
  startQrLogin,
  pollQrLogin,
} from "./adapters/wechat.js";
import { A2aMessengerAdapter } from "./adapters/a2a.js";
import type { TokenMintCapability } from "@tianshu-ai/plugin-sdk";

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    ensureSchema(ctx.db);

    // ── session inbox (notify agent on contact changes) ──────────
    const inbox = ctx.capabilities.get<SessionInboxCapability>("host.sessionInbox");

    // Fetch a peer's public agent card from their endpoint
    /** Fetch peer card by POSTing _a2a_get_card to their /a2a/receive endpoint. */
    async function fetchPeerCard(endpoint: string, token?: string): Promise<{ name?: string; description?: string } | null> {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;
        const r = await fetch(endpoint, {
          method: "POST", headers,
          body: JSON.stringify({ text: JSON.stringify({ _a2a_get_card: true }), sender: "card-fetch" }),
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) return null;
        const body = await r.json();
        return body?.card?.name ? body.card : null;
      } catch { return null; }
    }

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

    const contactSummary = (userId: string = "") => {
      const all = listContacts(ctx.db, userId);
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

    // Activate wechat adapters for ALL users' contacts at startup
    for (const c of (ctx.db.prepare("SELECT * FROM messenger_contacts WHERE type = 'wechat' AND enabled = 1").all() as Record<string, unknown>[]).map(r => ({ id: String(r.id), type: String(r.type), enabled: !!r.enabled, config: JSON.parse(String(r.config || '{}')) } as any))) {
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
    const tokenMint = ctx.capabilities.get<TokenMintCapability>("host.tokenMint");

    // ── REST routes ─────────────────────────────────────────────
    const routes: Record<string, PluginRouteHandler> = {
      // GET /contacts
      listContacts: (req: Request, res: Response) => {
        const userId = (req as any).ctx?.userId ?? "";
        const contacts = listContacts(ctx.db, userId);
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
        const userId = (req as any).ctx?.userId ?? "";
        const contact = createContact(ctx.db, {
          userId,
          name,
          type: type as ContactType,
          config: config ?? {},
          waitReply: !!waitReply,
        });
        ctx.broadcast("messenger_changed", {});
        notifyAgent(`[Messenger] 新增联系人「${contact.name}」(${contact.type})\n\n当前联系人列表:\n${contactSummary(userId)}`);
        try {
          if (type === "wechat") wechatAdapter.activate(contact);
        } catch { /* best-effort */ }
        // A2A: send handshake with own pairing info so remote can auto-add us back
        if (type === "a2a" && tokenMint) {
          const capturedReq = req; // capture for async
          void (async () => {
            try {
              const branding = ctx.tenantConfig?.branding ?? {};
              const myName = (branding.name as string) || "Tianshu";
              const hsUserId = (capturedReq as any).ctx?.userId ?? "";
              // Short-lived token for handshake only (5 min)
              // Long-lived but scoped — this token is stored by receiver for ongoing delivery
              // No expiry concern — scope is the access control
              const grant = tokenMint.mint(hsUserId, 100 * 365 * 24 * 3600, { scope: ["messenger./a2a/receive"] });
              const myPublicUrl = resolvePublicUrl(capturedReq);
              const myPairUrl = myPublicUrl
                ? `${myPublicUrl}/api/p/messenger/a2a/receive?token=${grant.token}`
                : null;
              const myCard = getAgentCard(ctx.db, (capturedReq as any).ctx?.userId ?? "");
              const handshake = JSON.stringify({
                _a2a_handshake: true,
                name: myName,
                pairUrl: myPairUrl,
                token: grant.token,
                endpoint: myPublicUrl ? `${myPublicUrl}/api/p/messenger/a2a/receive` : null,
                card: myCard.name ? myCard : undefined,
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
            const userId = (req as any).ctx?.userId ?? "";
            notifyAgent(`[Messenger] 联系人「${contact.name}」已更新\n\n当前联系人列表:\n${contactSummary(userId)}`);
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
          const userId = (req as any).ctx?.userId ?? "";
          notifyAgent(`[Messenger] 联系人「${contactName}」已删除\n\n当前联系人列表:\n${contactSummary(userId)}`);
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
            const qrUserId = (req as any).ctx?.userId ?? "";
            const contact = createContact(ctx.db, {
              userId: qrUserId,
              name: name?.trim() || resp.username || "WeChat Contact",
              type: "wechat",
              config: { token: resp.bot_token, baseUrl, ilinkUserId: resp.ilink_user_id, username: resp.username },
              waitReply: false,
            });
            ctx.broadcast("messenger_changed", {});
            notifyAgent(`[Messenger] 新增联系人「${contact.name}」(wechat)\n\n当前联系人列表:\n${contactSummary(qrUserId)}`);
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
      getAgentCard: (req: Request, res: Response) => {
        const userId = (req as any).ctx?.userId ?? "";
        const card = getAgentCard(ctx.db, userId);
        res.json({ ok: true, card });
      },

      // PUT /agent-card
      updateAgentCard: (req: Request, res: Response) => {
        const userId = (req as any).ctx?.userId ?? "";
        const body = req.body as Record<string, unknown> ?? {};
        const card = setAgentCard(ctx.db, userId, {
          name: typeof body.name === "string" ? body.name : undefined,
          description: typeof body.description === "string" ? body.description : undefined,
        });
        ctx.broadcast("messenger_changed", {});
        res.json({ ok: true, card });
      },

      // GET /agent-card/public — unauthenticated, for A2A discovery
      // Returns the first non-empty card found (public endpoint, no user context)
      getAgentCardPublic: (_req: Request, res: Response) => {
        const row = ctx.db.prepare("SELECT data FROM messenger_agent_card ORDER BY updated_at DESC LIMIT 1").get() as { data: string } | undefined;
        if (!row) { res.status(404).json({ error: "agent card not configured" }); return; }
        try {
          const card = JSON.parse(row.data);
          if (!card.name) { res.status(404).json({ error: "agent card not configured" }); return; }
          res.json(card);
        } catch { res.status(404).json({ error: "agent card not configured" }); }
      },

      // POST /agent-card/fetch-peer — server-side proxy to fetch peer's card (avoids CORS)
      fetchPeerCard: async (req: Request, res: Response) => {
        const { endpoint, token } = (req.body ?? {}) as { endpoint?: string; token?: string };
        if (!endpoint) { res.status(400).json({ ok: false, error: "missing endpoint" }); return; }
        const card = await fetchPeerCard(endpoint, token);
        res.json({ ok: true, card });
      },

      // ── A2A routes ────────────────────────────────────────────

      // POST /a2a/token — mint a session JWT for remote peers (like bridge)
      a2aToken: (req: Request, res: Response) => {
        if (!tokenMint) {
          res.status(500).json({ ok: false, error: "tokenMint capability not available" });
          return;
        }
        const userId = (req as any).ctx?.userId ?? "";
        // Short-lived token (5 min) — only for initial pairing + card fetch.
        // Ongoing A2A delivery uses the opaque apiKey stored in contact config.
        const grant = tokenMint.mint(userId, 300, { scope: ["messenger./agent-card", "messenger./a2a/*"] });
        const publicUrl = resolvePublicUrl(req);
        const pairUrl = publicUrl
          ? `${publicUrl}/api/p/messenger/a2a/receive?token=${grant.token}`
          : null;
        // Store token fingerprint for one-time consumption
        if (grant.token) storePairingToken(ctx.db, grant.token, userId);
        res.json({ ok: true, token: grant.token, pairUrl, authEnabled: grant.authEnabled });
      },

      // POST /a2a/receive — receive message from remote peer (authed via session JWT bearer)
      a2aReceive: (req: Request, res: Response) => {
        // Check scoped token is still valid (not consumed)
        const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
        if (bearer && (req as any).ctx?.tokenScope && !isScopedTokenAllowed(ctx.db, bearer)) {
          res.status(403).json({ ok: false, error: "token_consumed" });
          return;
        }
        const { text, sender } = (req.body ?? {}) as { text?: string; sender?: string };
        if (!text) { res.status(400).json({ ok: false, error: "missing text" }); return; }
        appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] a2aReceive tenant=${ctx.tenantId} sender=${sender} text=${text?.slice(0, 80)}\n`);

        // Check if this is a handshake message with pairing info
        try {
          const parsed = JSON.parse(text);
          if (parsed._a2a_handshake && parsed.endpoint && parsed.token) {
            const peerCard = parsed.card as { name?: string; description?: string } | undefined;
            const peerName = String(peerCard?.name || parsed.name || sender || "Remote Agent");
            // Check if we already have a contact pointing to this endpoint
            // Search across ALL users' A2A contacts (inbound has no user context)
            const allA2aContacts = (ctx.db.prepare("SELECT * FROM messenger_contacts WHERE type = 'a2a'").all() as Record<string, unknown>[]);
            const existing = allA2aContacts.find(
              (c) => {
                try { return JSON.parse(String(c.config || '{}')).endpoint === parsed.endpoint; } catch { return false; }
              },
            );
            if (!existing) {
              // Use the userId from the request context if available, otherwise empty
              const inboundUserId = (req as any).ctx?.userId ?? "";
              const contact = createContact(ctx.db, {
                userId: inboundUserId,
                name: peerName,
                type: "a2a",
                config: { endpoint: parsed.endpoint, apiKey: parsed.token, ...(peerCard ? { peerCard } : {}) },
              });
              // Fetch peer card if not included in handshake
              if (!peerCard) {
                fetchPeerCard(parsed.endpoint, parsed.token).then((fc) => {
                  if (fc) {
                    updateContact(ctx.db, contact.id, {
                      name: fc.name || contact.name,
                      config: { ...contact.config, peerCard: fc },
                    });
                    ctx.broadcast("messenger_changed", {});
                  }
                }).catch(() => {});
              }
              ctx.broadcast("messenger_changed", {});
              notifyAgent(
                `[Messenger A2A] 「${peerName}」已自动配对\n\n当前联系人列表:\n${contactSummary()}`,
              );
              ctx.log.info("a2a auto-paired", { peer: peerName, contactId: contact.id });
            } else {
              ctx.log.info("a2a handshake from existing peer, skipping", { peer: peerName });
            }
            // Consume pairing token — one-time use
            const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
            if (bearer) consumePairingToken(ctx.db, bearer);
            res.json({ ok: true, handshake: true });
            return;
          }
          // Handle agent card update from peer
          // Return this instance's agent card
          if (parsed._a2a_get_card) {
            const cardUserId = (req as any).ctx?.userId ?? "";
            let card: any = null;
            if (cardUserId) {
              const c = getAgentCard(ctx.db, cardUserId);
              if (c.name) card = c;
            }
            res.json({ ok: true, card });
            return;
          }
          if (parsed._a2a_card_update && parsed.card) {
            const peerCard = parsed.card as { name?: string; description?: string };
            // Update the contact name if the peer changed their name
            const allA2a = (ctx.db.prepare("SELECT * FROM messenger_contacts WHERE type = 'a2a'").all() as Record<string, unknown>[]).map((r: any) => ({
              id: String(r.id), name: String(r.name), type: 'a2a' as const, config: JSON.parse(String(r.config || '{}')),
              waitReply: false, enabled: true, createdAt: 0, updatedAt: 0,
            }));
            const match = allA2a.length === 1
              ? allA2a[0]
              : allA2a.find((c) => sender && c.name.toLowerCase().includes(sender.toLowerCase()));
            if (match && peerCard.name && peerCard.name !== match.name) {
              updateContact(ctx.db, match.id, { name: peerCard.name });
            }
            // Store the card in contact config for reference
            if (match) {
              const cfg = { ...(match.config || {}), peerCard: parsed.card };
              updateContact(ctx.db, match.id, { config: cfg });
            }
            ctx.broadcast("messenger_changed", {});
            ctx.log.info("a2a card update received", { from: sender, name: peerCard.name });
            res.json({ ok: true, cardUpdate: true });
            return;
          }
        } catch { /* not JSON, treat as normal message */ }

        // Try to find the contact name from our local contacts list.
        // The sender field from the request is unreliable; prefer our own name.
        // Search across ALL users' A2A contacts
        const allContacts = (ctx.db.prepare("SELECT * FROM messenger_contacts WHERE type = 'a2a'").all() as Record<string, unknown>[]).map((r: any) => ({
          id: String(r.id), name: String(r.name), type: 'a2a' as const, config: JSON.parse(String(r.config || '{}')),
          waitReply: false, enabled: true, createdAt: 0, updatedAt: 0,
        }));
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
        UpdateAgentCardTool: buildUpdateAgentCardTool(ctx.db, ctx.broadcast, () => adapters.get("a2a")),
      },
      routes,
    };
  },
};

export default plugin;
