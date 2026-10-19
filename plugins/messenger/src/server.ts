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
import { ensureSchema } from "./schema.js";

import { createHash } from "node:crypto";
import { buildAgentCard, parseA2AJsonRpc, buildA2AJsonRpcResponse, sendStandardA2AMessage } from "./a2a-standard.js";

/** Stable globally-unique peer identifier: sha256(endpoint + tenantId + userId), truncated. */
function makePeerId(endpoint: string, tenantId: string, userId: string): string {
  return createHash("sha256").update(`${endpoint}\0${tenantId}\0${userId}`).digest("hex").slice(0, 16);
}
import {
  listContacts,
  getContact,
  createContact,
  findContactByEndpoint,
  updateContact,
  deleteContact,
  listMessages,
  logMessage,
  getAgentCard,
  listAgentCardUserIds,
  setAgentCard,
  type ContactType,
  storePairingToken,
  consumePairingToken,
  isScopedTokenAllowed,
  storeCommToken,
  lookupCommTokenContact,
} from "./schema.js";
import { buildSendMessageTool, type SendAdapter } from "./tool.js";
import { buildUpdateAgentCardTool } from "./agent-card-tool.js";
import {
  WeChatMessengerAdapter,
  startQrLogin,
  pollQrLogin,
} from "./adapters/wechat.js";
import { A2aMessengerAdapter } from "./adapters/a2a.js";
import { RelayClient } from "./relay-client.js";
import type { TokenMintCapability } from "@tianshu-ai/plugin-sdk";

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    ensureSchema(ctx.db);

    // ── session inbox (notify agent on contact changes) ──────────
    const inbox = ctx.capabilities.get<SessionInboxCapability>("host.sessionInbox");

    // Fetch a peer's public agent card from their endpoint
    /** Fetch peer card — tries tianshu _a2a_get_card first, then standard A2A /.well-known/agent.json */
    async function fetchPeerCard(endpoint: string, token?: string): Promise<Record<string, unknown> | null> {
      // 1) Try tianshu-specific card fetch (POST with _a2a_get_card)
      if (token) {
        try {
          const r = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ text: JSON.stringify({ _a2a_get_card: true }), sender: "card-fetch" }),
            signal: AbortSignal.timeout(5000),
          });
          if (r.ok) {
            const body = await r.json();
            if (body?.card?.name) return body.card;
          }
        } catch { /* fall through to standard A2A */ }
      }
      // 2) Try standard A2A protocol: GET /.well-known/agent.json
      try {
        const base = new URL(endpoint);
        // A2A v1.0 standard path; fallback to legacy /.well-known/agent.json
        let wellKnown = new URL("/.well-known/agent-card.json", base.origin);
        const r = await fetch(wellKnown.toString(), {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(5000),
        });
        if (r.ok) {
          const card = await r.json();
          if (card?.name) {
            // Extract all standard A2A fields
            return {
              name: card.name,
              description: card.description || "",
              url: card.url || endpoint,
              provider: card.provider?.organization || "",
              providerUrl: card.provider?.url || "",
              version: card.version || "",
              skills: Array.isArray(card.skills) ? card.skills.map((s: any) => ({
                id: s.id || "",
                name: s.name || "",
                description: s.description || "",
                tags: s.tags || [],
              })) : [],
            };
          }
        }
      } catch { /* not a standard A2A agent */ }
      // 3) Legacy fallback: /.well-known/agent.json
      try {
        const base = new URL(endpoint);
        const legacy = new URL("/.well-known/agent.json", base.origin);
        const r = await fetch(legacy.toString(), {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(5000),
        });
        if (r.ok) {
          const card = await r.json();
          if (card?.name) return {
              name: card.name, description: card.description || "", url: card.url || endpoint,
              provider: card.provider?.organization || "", version: card.version || "",
              skills: Array.isArray(card.skills) ? card.skills.map((s: any) => ({ id: s.id || "", name: s.name || "", description: s.description || "" })) : [],
            };
        }
      } catch { /* no agent card available */ }
      return null;
    }

    const notifyAgent = (message: string, userId?: string) => {
      if (!inbox) return;
      const row = userId
        ? ctx.db
            .prepare(
              `SELECT id FROM sessions
               WHERE kind = 'user' AND user_id = ?
               ORDER BY created_at DESC LIMIT 1`,
            )
            .get(userId) as { id: string } | undefined
        : ctx.db
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

    /** Push an A2A message to the most recent user session. */
    const notifyA2a = (sender: string, text: string, userId?: string) => {
      if (!inbox) return;
      const row = userId
        ? ctx.db
            .prepare(
              `SELECT id FROM sessions
               WHERE kind = 'user' AND user_id = ?
               ORDER BY created_at DESC LIMIT 1`,
            )
            .get(userId) as { id: string } | undefined
        : ctx.db
            .prepare(
              `SELECT id FROM sessions
               WHERE kind = 'user'
               ORDER BY created_at DESC LIMIT 1`,
            )
            .get() as { id: string } | undefined;
      if (!row) return;
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
    const branding = ctx.tenantConfig?.branding ?? {};
    const a2aAdapter = new A2aMessengerAdapter({
      log: ctx.log,
      agentName: (branding.name as string) || "Tianshu",
      onReply: (contact, text) => {
        logMessage(ctx.db, { contactId: contact.id, text, status: "received", direction: "inbound" });
        notifyA2a(contact.name, text);
        ctx.broadcast("messenger_changed", {});
      },
    });

    // ── adapters map ────────────────────────────────────────────
    const adapters = new Map<string, SendAdapter>();
    adapters.set("wechat", wechatAdapter);
    adapters.set("a2a", a2aAdapter);

    // ── Agent Bluetooth relay client (instance-level, env config) ──
    let relayClient: RelayClient | null = null;
    // discoverableUserId is persisted in agent card, not memory
    let relayPairToken = "";
    const relayUrl = ctx.tenantConfig.agentBluetooth?.url || process.env.AGENT_BLUETOOTH_URL || "";
    const globalCard = getAgentCard(ctx.db, "");
    if (relayUrl) {
      const branding2 = ctx.tenantConfig?.branding ?? {};
      const localPort = Number(process.env.PORT || process.env.TIANSHU_PORT || 3110);
      const localBase = `http://127.0.0.1:${localPort}`;

      const btConfig = (ctx.tenantConfig.agentBluetooth || {}) as Record<string, any>;
      const relayApiKey = btConfig.apiKey || "";

      // Build per-user agent registrations from all users with cards
      const userIds = listAgentCardUserIds(ctx.db);
      const agentRegistrations: import("./relay-client.js").AgentRegistration[] = [];
      for (const uid of userIds) {
        const userCard = getAgentCard(ctx.db, uid);
        if (!userCard.name) continue; // skip empty cards
        agentRegistrations.push({
          userId: uid,
          card: {
            name: userCard.name || (branding2.name as string) || "Tianshu Agent",
            description: userCard.description || "",
            skills: userCard.skills || [],
            version: userCard.version || "1.0.0",
            provider: userCard.provider || (branding2.name as string) || "",
          },
          discoverable: userCard.discoverable === true,
        });
      }
      // Fallback: if no user cards, register a global card
      if (agentRegistrations.length === 0) {
        agentRegistrations.push({
          userId: "",
          card: {
            name: globalCard.name || (branding2.name as string) || "Tianshu Agent",
            description: globalCard.description || "",
            skills: globalCard.skills || [],
            version: globalCard.version || "1.0.0",
            provider: globalCard.provider || (branding2.name as string) || "",
          },
          discoverable: globalCard.discoverable === true,
        });
      }
      ctx.log.info?.("relay: registering agents", { count: agentRegistrations.length, userIds: agentRegistrations.map(a => a.userId || '(global)') });

      relayClient = new RelayClient({
        relayUrl,
        tenantId: ctx.tenantId ?? "default",
        agents: agentRegistrations,
        token: relayApiKey,
        log: ctx.log,
        onRequest: async (req) => {
          let localUrl: string;
          if (req.path === "/.well-known/agent-card.json") {
            localUrl = `${localBase}/api/p/messenger/agent-card`;
          } else {
            localUrl = `${localBase}/api/p/messenger/a2a/receive`;
          }
          try {
            const resp = await fetch(localUrl, {
              method: req.method,
              headers: {
                ...req.headers,
                "content-type": "application/json",
              },
              ...(req.body ? { body: req.body } : {}),
            });
            const body = await resp.text();
            const headers: Record<string, string> = { "content-type": "application/json" };
            return { status: resp.status, headers, body };
          } catch (err) {
            return { status: 502, headers: {}, body: JSON.stringify({ error: "local_forward_failed", message: String(err) }) };
          }
        },
        onPairRequest: async (req) => {
          // Store as pending — user must confirm before any token exchange
          const userId = req.targetUserId || getAgentCard(ctx.db, "").discoverableUserId || "";
          const relayReqId = req.requestId || "";
          const now = Date.now();
          // Upsert: if same relay_request_id exists as inbound, update it (data may have changed)
          const existing = relayReqId ? ctx.db.prepare("SELECT id, status FROM messenger_pair_requests WHERE relay_request_id = ? AND direction = 'inbound'").get(relayReqId) as any : null;
          if (existing) {
            // Only update if still pending — don't overwrite accepted/completed/rejected
            if (existing.status === "pending") {
              ctx.db.prepare(
                "UPDATE messenger_pair_requests SET peer_org_id = ?, peer_agent_id = ?, peer_user_id = ?, peer_name = ?, peer_card = ?, peer_endpoint = ?, user_id = ?, updated_at = ? WHERE id = ?"
              ).run(req.fromOrgId, req.fromAgentId || "", req.fromUserId || "", req.fromName || "", JSON.stringify(req.fromCard || {}), req.fromEndpoint || "", userId, now, existing.id);
              ctx.log.info("relay pair request upserted", { relayReqId, id: existing.id });
            }
            ctx.broadcast("messenger_changed", {});
            return { accept: false };
          }
          const id = "pr_" + now.toString(36) + "_" + Math.random().toString(36).slice(2, 6);
          ctx.db.prepare(
            "INSERT INTO messenger_pair_requests (id, relay_request_id, direction, status, peer_org_id, peer_agent_id, peer_user_id, peer_name, peer_card, peer_endpoint, user_id, created_at, updated_at) VALUES (?, ?, 'inbound', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).run(id, relayReqId, req.fromOrgId, req.fromAgentId || "", req.fromUserId || "", req.fromName || "", JSON.stringify(req.fromCard || {}), req.fromEndpoint || "", userId, now, now);
          ctx.broadcast("messenger_changed", {});
          ctx.log.info("relay pair request received (pending)", { requestId: id, relayReqId, peer: req.fromName, userId });
          notifyAgent(`[Messenger] 收到来自「${req.fromName || req.fromAgentId}」的配对请求`, userId);
          return { accept: false };
        },
        // ── Pair accepted: other side confirmed, sent their comm token ──
        onPairAccepted: (msg) => {
          // Look up outbound by relay_request_id first, fall back to legacy id formats
          let pr = ctx.db.prepare("SELECT * FROM messenger_pair_requests WHERE relay_request_id = ? AND direction = 'outbound' AND status = 'pending'").get(msg.requestId) as any;
          if (!pr) pr = ctx.db.prepare("SELECT * FROM messenger_pair_requests WHERE id IN (?, ?) AND direction = 'outbound' AND status = 'pending'").get(msg.requestId, "out_" + msg.requestId) as any;
          // Last resort: match by peer info (only one pending outbound per peer after dedup)
          if (!pr) {
            pr = ctx.db.prepare(
              "SELECT * FROM messenger_pair_requests WHERE peer_org_id = ? AND peer_agent_id = ? AND direction = 'outbound' AND status = 'pending'"
            ).get(msg.fromOrgId, msg.fromAgentId) as any;
            if (pr) ctx.log.info("pair_accepted: matched outbound by peer info", { requestId: msg.requestId, outboundId: pr.id });
          }
          if (!pr) {
            ctx.log.warn("pair_accepted: no outbound record found, creating contact anyway", { requestId: msg.requestId });
          }
          let userId = pr?.user_id || "";
          if (!userId) {
            // Recover from inbound record or message context
            const inbound = ctx.db.prepare("SELECT peer_user_id FROM messenger_pair_requests WHERE relay_request_id = ? AND direction = 'inbound'").get(msg.requestId) as any;
            if (!inbound) {
              // Also try matching inbound by peer info
              const inbound2 = ctx.db.prepare("SELECT user_id FROM messenger_pair_requests WHERE peer_org_id = ? AND peer_agent_id = ? AND direction = 'inbound' AND status = 'pending'").get(msg.fromOrgId, msg.fromAgentId) as any;
              userId = inbound2?.user_id || (msg as any).targetUserId || "";
            } else {
              userId = inbound.peer_user_id || (msg as any).targetUserId || "";
            }
          }
          if (!userId) { ctx.log.warn("pair_accepted: cannot determine userId, skipping", { requestId: msg.requestId }); return; }
          // Mint our comm token for the peer
          const commGrant = tokenMint
            ? tokenMint.mint(userId, 100 * 365 * 24 * 3600, { scope: ["messenger./a2a/receive"] })
            : null;
          // Create or reuse contact with peer's comm token as apiKey
          const existingContact1 = findContactByEndpoint(ctx.db, userId, msg.fromEndpoint);
          let contact: any;
          if (existingContact1) {
            updateContact(ctx.db, existingContact1.id, { name: msg.fromName || msg.fromAgentId, config: { ...existingContact1.config, endpoint: msg.fromEndpoint, apiKey: msg.fromToken, peerCard: msg.fromCard }, enabled: true });
            contact = { ...existingContact1 };
          } else {
            contact = createContact(ctx.db, {
              userId,
              name: msg.fromName || msg.fromAgentId,
              type: "a2a",
              config: { endpoint: msg.fromEndpoint, apiKey: msg.fromToken, peerCard: msg.fromCard },
            });
          }
          if (commGrant?.token) storeCommToken(ctx.db, commGrant.token, contact.id, userId);
          // Send our comm token back to complete the handshake
          const myCard = getAgentCard(ctx.db, userId);
          const myName = myCard.name || (ctx.tenantConfig?.branding?.name as string) || "Tianshu Agent";
          relayClient!.completePair(msg.fromOrgId, msg.fromAgentId, msg.requestId, {
            name: myName,
            token: commGrant?.token || "",
            card: myCard.name ? (myCard as unknown as Record<string, unknown>) : undefined,
            userId,
            targetUserId: (msg as any).fromUserId || "",
          });
          // Update request status
          if (pr) ctx.db.prepare("UPDATE messenger_pair_requests SET status = 'accepted', contact_id = ?, updated_at = ? WHERE id = ?").run(contact.id, Date.now(), pr.id);
          ctx.broadcast("messenger_changed", {});
          ctx.log.info("pair accepted by peer", { requestId: msg.requestId, contact: contact.id });
          notifyAgent(`[Messenger] 「${msg.fromName}」接受了你的配对请求`, userId);
        },
        // ── Pair rejected: other side declined ──
        onPairRejected: (msg) => {
          let prRej = ctx.db.prepare("SELECT id FROM messenger_pair_requests WHERE relay_request_id = ? AND direction = 'outbound' AND status = 'pending'").get(msg.requestId) as any;
          if (!prRej) prRej = ctx.db.prepare("SELECT id FROM messenger_pair_requests WHERE id IN (?, ?) AND direction = 'outbound' AND status = 'pending'").get(msg.requestId, "out_" + msg.requestId) as any;
          if (prRej) ctx.db.prepare("UPDATE messenger_pair_requests SET status = 'rejected', updated_at = ? WHERE id = ?").run(Date.now(), prRej.id);
          ctx.broadcast("messenger_changed", {});
          ctx.log.info("pair rejected by peer", { requestId: msg.requestId });
        },
        // ── Pair completed: we accepted earlier, now the other side sends their comm token ──
        onPairCompleted: (msg) => {
          const pr = ctx.db.prepare("SELECT * FROM messenger_pair_requests WHERE id = ? AND direction = 'inbound' AND status = 'accepted'").get(msg.requestId) as any;
          if (!pr) { ctx.log.warn("pair_completed for unknown request", { requestId: msg.requestId }); return; }
          // Update contact with the peer's comm token as apiKey
          const contact = pr.contact_id ? (ctx.db.prepare("SELECT * FROM messenger_contacts WHERE id = ?").get(pr.contact_id) as any) : null;
          if (contact) {
            const config = JSON.parse(contact.config || '{}');
            config.apiKey = msg.fromToken;
            ctx.db.prepare("UPDATE messenger_contacts SET config = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(config), Date.now(), contact.id);
          }
          ctx.db.prepare("UPDATE messenger_pair_requests SET status = 'completed', updated_at = ? WHERE id = ?").run(Date.now(), msg.requestId);
          ctx.broadcast("messenger_changed", {});
          ctx.log.info("pair completed", { requestId: msg.requestId, contact: pr.contact_id });
        },
        onDiscoverableExpired: () => {
          setAgentCard(ctx.db, "", { discoverable: false });
          ctx.broadcast("messenger_changed", {});
          ctx.log.info("relay discoverable expired, auto-disabled");
        },
      });
      relayClient.start();
      ctx.log.info("messenger relay client started", { relayUrl, agents: agentRegistrations.length });
    }

    // Cleanup stale pair requests (pending > 24h)
    const staleThreshold = Date.now() - 24 * 60 * 60 * 1000;
    const cleaned = ctx.db.prepare("DELETE FROM messenger_pair_requests WHERE status = 'pending' AND created_at < ?").run(staleThreshold) as { changes: number };
    if (cleaned.changes) ctx.log.info("cleaned stale pair requests", { count: cleaned.changes });

    ctx.log.info("messenger activated", {
      adapters: [...adapters.keys()],
      relay: relayClient ? "connected" : "off",
    });

    // ── tool ────────────────────────────────────────────────────
    const sendMessageTool = buildSendMessageTool({ db: ctx.db, adapters, broadcast: (event, data) => ctx.broadcast(event, data), notifyA2a });

    /** Resolve this instance's public URL. */
    function resolvePublicUrl(req?: Request): string {
      const cfgUrl = (ctx.pluginConfig as Record<string, unknown>).publicUrl;
      if (cfgUrl) return String(cfgUrl).replace(/\/$/, "");
      if (req) {
        const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
        let host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
        // If host is localhost/127.0.0.1, try to resolve a LAN IP so remote peers can reach us
        if (host && /^(localhost|127\.0\.0\.1)(:|$)/.test(host)) {
          const lanIp = detectLanIp();
          if (lanIp) {
            const port = host.includes(":") ? host.split(":")[1] : "";
            host = port ? `${lanIp}:${port}` : lanIp;
          }
        }
        if (host) return `${proto}://${host}`.replace(/\/$/, "");
      }
      return "";
    }

    function detectLanIp(): string | null {
      try {
        const nets = require("node:os").networkInterfaces();
        for (const name of Object.keys(nets)) {
          for (const net of nets[name] ?? []) {
            if (net.family === "IPv4" && !net.internal && net.address) return net.address;
          }
        }
      } catch {}
      return null;
    }

    /** If an endpoint contains localhost/127.0.0.1, replace with the request's actual remote IP */
    function fixLocalhostEndpoint(endpoint: string, req: Request): string {
      if (!endpoint) return endpoint;
      try {
        const u = new URL(endpoint);
        if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
          // Use the actual remote address from the request
          const remoteIp = req.headers["x-forwarded-for"]?.toString().split(",")[0].trim()
            || req.socket?.remoteAddress?.replace(/^::ffff:/, "");
          if (remoteIp && remoteIp !== "127.0.0.1" && remoteIp !== "::1") {
            u.hostname = remoteIp;
            return u.toString().replace(/\/$/, "");
          }
        }
      } catch {}
      return endpoint;
    }

    // ── Bridge token capability for A2A ──────────────────────────
    const tokenMint = ctx.capabilities.get<TokenMintCapability>("host.tokenMint");

    // ── REST routes ─────────────────────────────────────────────
    const routes: Record<string, PluginRouteHandler> = {
      // POST /relay/pair — initiate pairing with a discovered agent
      relayPair: async (req: Request, res: Response) => {
        if (!relayClient || !relayClient.isConnected) {
          res.status(400).json({ ok: false, error: "relay not connected" });
          return;
        }
        const { orgId, agentId, userId: targetUserId, peerName } = (req.body ?? {}) as { orgId?: string; agentId?: string; userId?: string; peerName?: string };
        if (!orgId || !agentId) {
          res.status(400).json({ ok: false, error: "orgId and agentId required" });
          return;
        }
        const userId = (req as any).ctx?.userId ?? "";
        const branding = ctx.tenantConfig?.branding ?? {};
        const myCard = getAgentCard(ctx.db, userId);
        const myName = myCard.name || (branding.name as string) || "Tianshu Agent";
        // Send pair request — NO token, just identity
        const result = await relayClient.pair(orgId, agentId, {
          name: myName,
          card: myCard.name ? (myCard as unknown as Record<string, unknown>) : undefined,
          userId,
          targetUserId: targetUserId || "",
        });
        if (result.success && result.status === "pending") {
          // Store outbound pending request
          const now = Date.now();
          const relayReqId = result.requestId || "";
          const id = "pr_" + now.toString(36) + "_" + Math.random().toString(36).slice(2, 6);
          // Remove older outbound pending/rejected to same target
          ctx.db.prepare(
            "DELETE FROM messenger_pair_requests WHERE direction = 'outbound' AND status IN ('pending', 'rejected') AND peer_org_id = ? AND peer_agent_id = ? AND user_id = ?"
          ).run(orgId, agentId, userId);
          ctx.db.prepare(
            "INSERT INTO messenger_pair_requests (id, relay_request_id, direction, status, peer_org_id, peer_agent_id, peer_user_id, peer_name, peer_endpoint, user_id, created_at, updated_at) VALUES (?, ?, 'outbound', 'pending', ?, ?, ?, ?, ?, ?, ?, ?)"
          ).run(id, relayReqId, orgId, agentId, targetUserId || "", peerName || agentId || "", "", userId, now, now);
          ctx.broadcast("messenger_changed", {});
          res.json({ ok: true, status: "pending", requestId: id });
        } else {
          res.json({ ok: false, error: result.error || "pair_failed" });
        }
      },

      // GET /relay/discover — list discoverable agents from relay
      relayDiscover: async (_req: Request, res: Response) => {
        if (!relayClient || !relayClient.isConnected) {
          res.json({ ok: true, agents: [] });
          return;
        }
        try {
          const resp = await fetch(`${relayUrl.replace(/^ws/, "http")}/discovery`);
          const data = await resp.json() as { agents?: unknown[] };
          res.json({ ok: true, agents: data.agents ?? [] });
        } catch (err) {
          res.json({ ok: true, agents: [], error: String(err) });
        }
      },

      // GET /relay/status — relay connection status + discoverable state
      relayStatus: (req: Request, res: Response) => {
        if (!relayClient) {
          res.json({ ok: true, enabled: false });
          return;
        }
        const userId = (req as any).ctx?.userId ?? "";
        res.json({
          ok: true,
          enabled: true,
          connected: relayClient.isConnected,
          publicUrl: relayClient.publicUrl,
          orgId: relayClient.orgId,
          agentId: relayClient.agentIdentifier,
          userId,
          discoverable: relayClient.discoverable,
        });
      },

      // POST /relay/discoverable — toggle discoverable { discoverable: boolean }
      relayDiscoverable: (req: Request, res: Response) => {
        if (!relayClient) {
          res.status(400).json({ ok: false, error: "relay not configured" });
          return;
        }
        const { discoverable } = (req.body ?? {}) as { discoverable?: boolean };
        const userId = (req as any).ctx?.userId ?? "";
        if (discoverable && tokenMint) {
          // Mint a long-lived pairing token with the user's identity
          const pairGrant = tokenMint.mint(userId, 10 * 60, { scope: ["messenger./a2a/receive"] });
          relayPairToken = pairGrant.token;
          setAgentCard(ctx.db, "", { discoverable: true, discoverableUserId: userId });
          relayClient.setDiscoverable(true, pairGrant.token, userId);
          // Also register this user on relay if not already
          const userCard = getAgentCard(ctx.db, userId);
          if (userCard.name) {
            relayClient.registerAgent({
              userId,
              card: { name: userCard.name, description: userCard.description || "", skills: userCard.skills || [], version: userCard.version || "1.0.0", provider: userCard.provider || "" },
              discoverable: true,
            });
          }
        } else {
          relayClient.setDiscoverable(false, undefined, userId);
          setAgentCard(ctx.db, "", { discoverable: false, discoverableUserId: "" });
        }
        res.json({ ok: true, discoverable: relayClient.discoverable });
      },

      // GET /relay/pair-requests — list pending pair requests
      listPairRequests: (req: Request, res: Response) => {
        const userId = (req as any).ctx?.userId ?? "";
        const rows = ctx.db.prepare(
          "SELECT * FROM messenger_pair_requests WHERE user_id = ? AND status IN ('pending', 'rejected') ORDER BY created_at DESC"
        ).all(userId) as any[];
        res.json({ ok: true, requests: rows.map(r => ({ ...r, peerCard: JSON.parse(r.peer_card || '{}') })) });
      },

      // POST /relay/pair-accept — accept a pending inbound pair request
      pairAccept: async (req: Request, res: Response) => {
        const { requestId } = (req.body ?? {}) as { requestId?: string };
        if (!requestId) { res.status(400).json({ ok: false, error: "requestId required" }); return; }
        const userId = (req as any).ctx?.userId ?? "";
        const pr = ctx.db.prepare(
          "SELECT * FROM messenger_pair_requests WHERE id = ? AND direction = 'inbound' AND status = 'pending' AND user_id = ?"
        ).get(requestId, userId) as any;
        if (!pr) { res.status(404).json({ ok: false, error: "request not found" }); return; }
        if (!relayClient || !relayClient.isConnected) { res.status(400).json({ ok: false, error: "relay not connected" }); return; }
        // Mint comm token for the peer to call us
        const commGrant = tokenMint
          ? tokenMint.mint(userId, 100 * 365 * 24 * 3600, { scope: ["messenger./a2a/receive"] })
          : null;
        // Create contact (without peer's apiKey yet — will be set in onPairCompleted)
        const existingC2 = findContactByEndpoint(ctx.db, userId, pr.peer_endpoint);
        let contact: any;
        if (existingC2) {
          updateContact(ctx.db, existingC2.id, { name: pr.peer_name || pr.peer_agent_id, config: { ...existingC2.config, endpoint: pr.peer_endpoint, apiKey: "", peerCard: JSON.parse(pr.peer_card || '{}') }, enabled: true });
          contact = { ...existingC2 };
        } else {
          contact = createContact(ctx.db, {
            userId,
            name: pr.peer_name || pr.peer_agent_id,
            type: "a2a",
            config: { endpoint: pr.peer_endpoint, apiKey: "", peerCard: JSON.parse(pr.peer_card || '{}') },
          });
        }
        if (commGrant?.token) storeCommToken(ctx.db, commGrant.token, contact.id, userId);
        // Send accept with our comm token
        const myCard = getAgentCard(ctx.db, userId);
        const myName = myCard.name || (ctx.tenantConfig?.branding?.name as string) || "Tianshu Agent";
        // Use relay_request_id so the other side can match their outbound record
        relayClient.acceptPair(pr.peer_org_id, pr.peer_agent_id, pr.relay_request_id || requestId, {
          name: myName,
          token: commGrant?.token || "",
          card: myCard.name ? (myCard as unknown as Record<string, unknown>) : undefined,
          userId,
          targetUserId: pr.peer_user_id || "",
        });
        ctx.db.prepare("UPDATE messenger_pair_requests SET status = 'accepted', contact_id = ?, updated_at = ? WHERE id = ?").run(contact.id, Date.now(), requestId);
        ctx.broadcast("messenger_changed", {});
        ctx.log.info("pair request accepted", { requestId, contact: contact.id });
        notifyAgent(`[Messenger] 你接受了「${pr.peer_name}」的配对请求`, userId);
        res.json({ ok: true, contact });
      },

      // POST /relay/pair-reject — reject a pending inbound pair request
      pairReject: (req: Request, res: Response) => {
        const { requestId } = (req.body ?? {}) as { requestId?: string };
        if (!requestId) { res.status(400).json({ ok: false, error: "requestId required" }); return; }
        const userId = (req as any).ctx?.userId ?? "";
        const pr = ctx.db.prepare(
          "SELECT * FROM messenger_pair_requests WHERE id = ? AND direction = 'inbound' AND status = 'pending' AND user_id = ?"
        ).get(requestId, userId) as any;
        if (!pr) { res.status(404).json({ ok: false, error: "request not found" }); return; }
        if (relayClient?.isConnected) {
          relayClient.rejectPair(pr.peer_org_id, pr.peer_agent_id, pr.relay_request_id || requestId);
        }
        ctx.db.prepare("UPDATE messenger_pair_requests SET status = 'rejected', updated_at = ? WHERE id = ?").run(Date.now(), requestId);
        ctx.broadcast("messenger_changed", {});
        res.json({ ok: true });
      },

      // POST /relay/pair-dismiss — delete an outbound pair request from list
      pairDismiss: (req: Request, res: Response) => {
        const { requestId } = (req.body ?? {}) as { requestId?: string };
        if (!requestId) { res.status(400).json({ ok: false, error: "requestId required" }); return; }
        const userId = (req as any).ctx?.userId ?? "";
        ctx.db.prepare("DELETE FROM messenger_pair_requests WHERE id = ? AND direction = 'outbound' AND user_id = ?").run(requestId, userId);
        ctx.broadcast("messenger_changed", {});
        res.json({ ok: true });
      },

      // GET /contacts
      listContacts: (req: Request, res: Response) => {
        const userId = (req as any).ctx?.userId ?? "";
        const contacts = listContacts(ctx.db, userId);
        const enriched = contacts.map((c) => {
          const lastMsg = ctx.db.prepare(
            "SELECT text, direction, created_at FROM messenger_messages WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1"
          ).get(c.id) as { text: string; direction: string; created_at: number } | undefined;
          return {
            ...c,
            ready: c.type === "wechat" ? wechatAdapter.isReady(c.id)
              : (c.type === "a2a" && c.config?.endpoint && /\/u\/[^/]+\//.test(c.config.endpoint as string))
                ? (relayClient?.isConnected ?? false)
                : true,
            lastMessage: lastMsg ? { text: lastMsg.text, direction: lastMsg.direction, createdAt: lastMsg.created_at } : null,
          };
        });
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
        notifyAgent(`[Messenger] 新增联系人「${contact.name}」(${contact.type})\n\n当前联系人列表:\n${contactSummary(userId)}`, userId);
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
              // Store token mapping so inbound replies route to this contact
              storeCommToken(ctx.db, grant.token, contact.id, hsUserId);
              const myPublicUrl = resolvePublicUrl(capturedReq);
              // When relay is connected, all A2A goes through relay
              const myEndpoint = relayClient?.publicUrl || (myPublicUrl ? `${myPublicUrl}/api/p/messenger/a2a/receive` : null);
              const myPairUrl = myEndpoint
                ? `${myEndpoint}?token=${grant.token}}`
                : null;
              const myCard = getAgentCard(ctx.db, (capturedReq as any).ctx?.userId ?? "");
              const handshake = JSON.stringify({
                _a2a_handshake: true,
                name: myName,
                peerId: makePeerId(
                  myEndpoint || "",
                  ctx.tenantId ?? "",
                  hsUserId,
                ),
                pairUrl: myPairUrl,
                token: grant.token,
                endpoint: myEndpoint,
                card: myCard.name ? (myCard as unknown as Record<string, unknown>) : undefined,
              });
              // Send handshake directly (not via adapter) so we can read the response
              const cfg = contact.config as { endpoint?: string; apiKey?: string };
              // Fire-and-forget handshake — avoid same-process deadlock
              const hsHeaders: Record<string, string> = { "Content-Type": "application/json" };
              if (cfg.apiKey) hsHeaders.Authorization = "Bearer " + cfg.apiKey;
              fetch(cfg.endpoint!, {
                method: "POST",
                headers: hsHeaders,
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: crypto.randomUUID(),
                  method: "message/send",
                  params: {
                    message: {
                      role: "user",
                      messageId: crypto.randomUUID(),
                      parts: [{ text: handshake }],
                      metadata: { senderName: myName, _a2a_handshake: true },
                    },
                  },
                }),
              }).then(async (hsResp) => {
                if (hsResp.ok) {
                  const hsBody = await hsResp.json().catch(() => ({})) as Record<string, unknown>;
                  if (hsBody.communicationToken && typeof hsBody.communicationToken === "string") {
                    updateContact(ctx.db, contact.id, {
                      config: { ...contact.config, apiKey: hsBody.communicationToken },
                    });
                    ctx.log.info("a2a apiKey upgraded to communication token", { contact: contact.name });
                  }
                } else {
                  ctx.log.warn("a2a handshake failed", { contact: contact.name, status: hsResp.status });
                }
              }).catch((err) => {
                ctx.log.warn("a2a handshake error", { error: err });
              });
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
            notifyAgent(`[Messenger] 联系人「${contact.name}」已更新\n\n当前联系人列表:\n${contactSummary(userId)}`, userId);
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
        // Notify peer before deleting (best-effort)
        if (contact?.type === "a2a") {
          const cfg = contact.config as { endpoint?: string; apiKey?: string };
          if (cfg.endpoint && cfg.apiKey) {
            fetch(cfg.endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
              body: JSON.stringify({ text: JSON.stringify({ _a2a_disconnect: true }), sender: "system" }),
              signal: AbortSignal.timeout(5000),
            }).catch(() => {});
          }
        }
        wechatAdapter.deactivate(id);
        const ok = deleteContact(ctx.db, id);
        if (ok) {
          ctx.broadcast("messenger_changed", {});
          const userId = (req as any).ctx?.userId ?? "";
          notifyAgent(`[Messenger] 联系人「${contactName}」已删除\n\n当前联系人列表:\n${contactSummary(userId)}`, userId);
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
            notifyAgent(`[Messenger] 新增联系人「${contact.name}」(wechat)\n\n当前联系人列表:\n${contactSummary(qrUserId)}`, qrUserId);
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
            const rebindUserId = (req as any).ctx?.userId ?? ""; notifyAgent(`[Messenger] 联系人「${existing.name}」已重新绑定微信`, rebindUserId);
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
          provider: typeof body.provider === "string" ? body.provider : undefined,
          providerUrl: typeof body.providerUrl === "string" ? body.providerUrl : undefined,
          version: typeof body.version === "string" ? body.version : undefined,
          defaultInputModes: Array.isArray(body.defaultInputModes) ? body.defaultInputModes : undefined,
          defaultOutputModes: Array.isArray(body.defaultOutputModes) ? body.defaultOutputModes : undefined,
          skills: Array.isArray(body.skills) ? body.skills : undefined,
        });
        ctx.broadcast("messenger_changed", {});
        // Also update the global (empty userId) card row so relay picks it up on restart
        if (userId) {
          setAgentCard(ctx.db, "", {
            name: card.name, description: card.description, provider: card.provider,
            providerUrl: card.providerUrl, version: card.version,
            skills: card.skills,
          });
        }
        // Sync updated card to relay
        if (relayClient?.isConnected) {
          relayClient.updateCard({
            name: card.name || "",
            description: card.description || "",
            skills: card.skills || [],
            version: card.version || "1.0.0",
            provider: card.provider || "",
          }, userId);
        }
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

      // GET /.well-known/agent-card.json — standard A2A agent card discovery
      // Auth: Bearer token in header → resolves tenant+user → returns their card
      wellKnownAgentCard: (req: Request, res: Response) => {
        // Token already verified by plugin-routes scoped-token middleware
        const userId = (req as any).ctx?.userId ?? "";
        if (!userId) { res.status(401).json({ error: "authentication required" }); return; }
        const row = ctx.db.prepare(
          "SELECT data FROM messenger_agent_card WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1"
        ).get(userId) as { data: string } | undefined;
        let card: { name: string; description: string } | null = null;
        if (row) {
          try { const parsed = JSON.parse(row.data); if (parsed.name) card = parsed; } catch {}
        }
        const publicUrl = resolvePublicUrl(req);
        res.json(buildAgentCard(publicUrl || "", card));
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
        // ── Standard A2A JSON-RPC detection ──
        const a2aRpc = parseA2AJsonRpc(req.body);
        if (a2aRpc) {
          const inboundUserId = (req as any).ctx?.userId ?? "";
          if (a2aRpc.method === "message/send" && a2aRpc.text) {
            // ── Check for handshake inside JSON-RPC message ──
            try {
              const parsed = JSON.parse(a2aRpc.text);
              if (parsed._a2a_handshake && parsed.endpoint && parsed.token) {
                // Delegate to the legacy handshake handler by rewriting req.body
                const fakeText = a2aRpc.text;
                const fakeSender = a2aRpc.senderName;
                // Reuse the legacy handshake path below
                (req as any)._jsonRpcHandshake = { text: fakeText, sender: fakeSender, rpcId: a2aRpc.id, taskId: a2aRpc.taskId, contextId: a2aRpc.contextId };
              }
            } catch { /* not JSON, normal message */ }
            if ((req as any)._jsonRpcHandshake) {
              // Handle handshake directly in JSON-RPC path (can't fall through due to return)
              const hs = (req as any)._jsonRpcHandshake;
              const hsParsed = JSON.parse(hs.text);
              const peerEndpoint = fixLocalhostEndpoint(hsParsed.endpoint, req);
              const peerCard = hsParsed.card as { name?: string; description?: string } | undefined;
              const peerName = String(peerCard?.name || hsParsed.name || hs.sender || "Remote Agent");
              const inboundUserId = (req as any).ctx?.userId ?? "";
              const peerId = hsParsed.peerId || "";
              const userA2aContacts = (ctx.db.prepare(
                "SELECT * FROM messenger_contacts WHERE type = 'a2a' AND user_id = ?"
              ).all(inboundUserId) as Record<string, unknown>[]);
              const existing = userA2aContacts.find((c) => {
                try {
                  const cfg = JSON.parse(String(c.config || '{}'));
                  return cfg.endpoint === peerEndpoint && cfg.peerId === peerId;
                } catch { return false; }
              });
              if (!existing) {
                const contact = createContact(ctx.db, {
                  userId: inboundUserId,
                  name: peerName,
                  type: "a2a",
                  config: { endpoint: peerEndpoint, peerId, apiKey: hsParsed.token, ...(peerCard ? { peerCard } : {}) },
                });
                if (!peerCard) {
                  fetchPeerCard(peerEndpoint, hsParsed.token).then((fc) => {
                    if (fc) {
                      updateContact(ctx.db, contact.id, {
                        name: (fc.name as string) || contact.name,
                        config: { ...contact.config, peerCard: fc },
                      });
                      ctx.broadcast("messenger_changed", {});
                    }
                  }).catch(() => {});
                }
                ctx.broadcast("messenger_changed", {});
                notifyAgent(
                  `[Messenger A2A] 「${peerName}」已自动配对\n\n当前联系人列表:\n${contactSummary(inboundUserId)}`,
                  inboundUserId,
                );
                ctx.log.info("a2a auto-paired", { peer: peerName, contactId: contact.id });
              } else {
                const existCfg = JSON.parse(String(existing.config || '{}'));
                updateContact(ctx.db, String(existing.id), {
                  config: { ...existCfg, apiKey: hsParsed.token, peerId, ...(peerCard ? { peerCard } : {}) },
                  ...(existCfg.disabledReason === "peer_disconnected" ? { enabled: true } : {}),
                });
                ctx.broadcast("messenger_changed", {});
              }
              // Mint comm token for the peer to use when sending back
              const commUserId = inboundUserId;
              const commGrant = tokenMint
                ? tokenMint.mint(commUserId, 100 * 365 * 24 * 3600, { scope: ["messenger./a2a/receive"] })
                : null;
              if (commGrant?.token) {
                const targetContact = existing
                  ? { id: String(existing.id) }
                  : ctx.db.prepare("SELECT id FROM messenger_contacts WHERE type = 'a2a' AND user_id = ? ORDER BY created_at DESC LIMIT 1").get(inboundUserId) as { id: string } | undefined;
                if (targetContact) storeCommToken(ctx.db, commGrant.token, String(targetContact.id), commUserId);
              }
              // Return JSON-RPC response with comm token
              const rpcResp = buildA2AJsonRpcResponse(hs.rpcId, hs.taskId, hs.contextId, "Handshake accepted");
              (rpcResp as any).communicationToken = commGrant?.token;
              res.json({ ...rpcResp, communicationToken: commGrant?.token });
              return;
            } else {
            // Look up contact by comm token first (precise), fallback to name match
            const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
            const tokenLookup = bearer ? lookupCommTokenContact(ctx.db, bearer) : null;
            let contactId: string | undefined;
            let contactName: string | undefined;
            if (tokenLookup) {
              contactId = tokenLookup.contactId;
              const c = getContact(ctx.db, contactId);
              contactName = c?.name;
            } else {
              // Fallback: match by sender name
              const contacts = ctx.db.prepare(
                "SELECT * FROM messenger_contacts WHERE type = 'a2a' AND user_id = ? AND name = ?"
              ).all(inboundUserId, a2aRpc.senderName) as Record<string, unknown>[];
              contactId = contacts[0]?.id as string | undefined;
              contactName = contacts[0]?.name as string | undefined;
            }
            const displayName = contactName || a2aRpc.senderName;

            // ── Handle card update silently (don't store as chat message) ──
            try {
              const parsed = JSON.parse(a2aRpc.text);
              if (parsed._a2a_card_update && parsed.card) {
                const peerCard = parsed.card as { name?: string; description?: string };
                if (contactId && peerCard.name) {
                  updateContact(ctx.db, contactId, { name: peerCard.name });
                  const existing = getContact(ctx.db, contactId);
                  if (existing) {
                    const cfg = { ...(existing.config || {}), peerCard: parsed.card };
                    updateContact(ctx.db, contactId, { config: cfg });
                  }
                  ctx.broadcast("messenger_changed", {});
                }
                ctx.log.info("a2a card update received (jsonrpc)", { from: a2aRpc.senderName, name: peerCard.name });
                res.json(buildA2AJsonRpcResponse(a2aRpc.id, a2aRpc.taskId, a2aRpc.contextId, "Card updated"));
                return;
              }
            } catch { /* not JSON, normal message */ }

            if (contactId) {
              ctx.db.prepare(
                "INSERT INTO messenger_messages (id, user_id, contact_id, direction, text, status, created_at) VALUES (?, ?, ?, 'inbound', ?, 'received', ?)"
              ).run(crypto.randomUUID(), inboundUserId, contactId, a2aRpc.text, Date.now());
              ctx.broadcast("messenger_changed", {});
            }
            // Push to agent session inbox
            notifyA2a(displayName, a2aRpc.text, inboundUserId);
            const rpcResp = buildA2AJsonRpcResponse(a2aRpc.id, a2aRpc.taskId, a2aRpc.contextId, "Message received");
            res.json(rpcResp);
            } // end else (not handshake)
          } else {
            // Unsupported method
            res.json({ jsonrpc: "2.0", id: a2aRpc.id, error: { code: -32601, message: "Method not found" } });
          }
          return;
        }

        // ── Legacy tianshu protocol ──
        const { text, sender } = (req.body ?? {}) as { text?: string; sender?: string };
        if (!text) { res.status(400).json({ ok: false, error: "missing text" }); return; }

        // Check if this is a handshake message with pairing info
        try {
          const parsed = JSON.parse(text);
          if (parsed._a2a_handshake && parsed.endpoint && parsed.token) {
            // Fix localhost endpoints — replace with actual remote IP so cross-machine works
            const peerEndpoint = fixLocalhostEndpoint(parsed.endpoint, req);
            const peerCard = parsed.card as { name?: string; description?: string } | undefined;
            const peerName = String(peerCard?.name || parsed.name || sender || "Remote Agent");
            // Check if this user already has a contact pointing to this endpoint
            const inboundUserId = (req as any).ctx?.userId ?? "";
            const userA2aContacts = (ctx.db.prepare(
              "SELECT * FROM messenger_contacts WHERE type = 'a2a' AND user_id = ?"
            ).all(inboundUserId) as Record<string, unknown>[]);
            // Deduplicate by endpoint + peerId (same endpoint but different users = different contacts)
            const peerId = parsed.peerId || "";
            const existing = userA2aContacts.find(
              (c) => {
                try {
                  const cfg = JSON.parse(String(c.config || '{}'));
                  return cfg.endpoint === peerEndpoint && cfg.peerId === peerId;
                } catch { return false; }
              },
            );
            if (!existing) {
              const contact = createContact(ctx.db, {
                userId: inboundUserId,
                name: peerName,
                type: "a2a",
                config: { endpoint: peerEndpoint, peerId, apiKey: parsed.token, ...(peerCard ? { peerCard } : {}) },
              });
              // Fetch peer card if not included in handshake
              if (!peerCard) {
                fetchPeerCard(peerEndpoint, parsed.token).then((fc) => {
                  if (fc) {
                    updateContact(ctx.db, contact.id, {
                      name: (fc.name as string) || contact.name,
                      config: { ...contact.config, peerCard: fc },
                    });
                    ctx.broadcast("messenger_changed", {});
                  }
                }).catch(() => {});
              }
              ctx.broadcast("messenger_changed", {});
              notifyAgent(
                `[Messenger A2A] 「${peerName}」已自动配对\n\n当前联系人列表:\n${contactSummary(inboundUserId)}`,
                inboundUserId,
              );
              ctx.log.info("a2a auto-paired", { peer: peerName, contactId: contact.id });
            } else {
              // Re-enable if peer had disconnected, and update token
              const existCfg = JSON.parse(String(existing.config || '{}'));
              const updates: Record<string, unknown> = {
                config: { ...existCfg, apiKey: parsed.token, peerId, ...(peerCard ? { peerCard } : {}) },
              };
              if (existCfg.disabledReason === "peer_disconnected") {
                delete (updates.config as any).disabledReason;
                updates.enabled = true;
              }
              if (peerCard?.name) updates.name = peerCard.name;
              updateContact(ctx.db, String(existing.id), updates);
              ctx.broadcast("messenger_changed", {});
              ctx.log.info("a2a handshake from existing peer, updated", { peer: peerName });
            }
            // Consume pairing token — one-time use
            const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
            if (bearer) consumePairingToken(ctx.db, bearer);
            // Issue a long-lived scoped communication token for the peer to use
            const commUserId = (req as any).ctx?.userId ?? "";
            const commGrant = tokenMint
              ? tokenMint.mint(commUserId, 100 * 365 * 24 * 3600, { scope: ["messenger./a2a/receive"] })
              : null;
            // Store token→contact mapping so inbound messages route to the right contact
            // For newly created contacts, use the contact directly; for existing, use the existing row
            const newlyCreated = !existing ? (ctx.db.prepare(
              "SELECT * FROM messenger_contacts WHERE type = 'a2a' AND user_id = ? ORDER BY created_at DESC LIMIT 1"
            ).get(inboundUserId) as Record<string, unknown> | undefined) : null;
            const targetContact = existing || newlyCreated;
            if (commGrant?.token && targetContact) {
              storeCommToken(ctx.db, commGrant.token, String(targetContact.id), commUserId);
            }
            const hsResult = { ok: true, handshake: true, ...(commGrant ? { communicationToken: commGrant.token } : {}) };
            // If triggered from JSON-RPC path, wrap response in JSON-RPC format
            const jsonRpcHs = (req as any)._jsonRpcHandshake;
            if (jsonRpcHs) {
              res.json({
                jsonrpc: "2.0",
                id: jsonRpcHs.rpcId,
                result: {
                  id: crypto.randomUUID(),
                  contextId: jsonRpcHs.contextId || crypto.randomUUID(),
                  status: { state: "completed", timestamp: new Date().toISOString(),
                    message: { role: "agent", messageId: crypto.randomUUID(), parts: [{ text: JSON.stringify(hsResult) }] } },
                  artifacts: [], history: [], metadata: hsResult,
                },
              });
            } else {
              res.json(hsResult);
            }
            return;
          }
          // Handle agent card update from peer
          // Return this instance's agent card
          // Handle peer disconnect notification
          if (parsed._a2a_disconnect) {
            const disconnectBearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
            const disconnectLookup = disconnectBearer ? lookupCommTokenContact(ctx.db, disconnectBearer) : null;
            if (disconnectLookup) {
              const dc = getContact(ctx.db, disconnectLookup.contactId);
              if (dc) {
                updateContact(ctx.db, dc.id, { enabled: false, config: { ...dc.config, disabledReason: "peer_disconnected" } });
                ctx.broadcast("messenger_changed", {});
                notifyAgent(`[Messenger] 联系人「${dc.name}」已被对方删除`, disconnectLookup.userId);
              }
            }
            res.json({ ok: true, disconnect: true });
            return;
          }
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
            const cardRecipientId = (req as any).ctx?.userId ?? "";
            const userA2a = (ctx.db.prepare(
              "SELECT * FROM messenger_contacts WHERE type = 'a2a' AND user_id = ?"
            ).all(cardRecipientId) as Record<string, unknown>[]).map((r: any) => ({
              id: String(r.id), name: String(r.name), type: 'a2a' as const, config: JSON.parse(String(r.config || '{}')),
              waitReply: false, enabled: true, createdAt: 0, updatedAt: 0,
            }));
            const match = userA2a.length === 1
              ? userA2a[0]
              : userA2a.find((c) => sender && c.name.toLowerCase().includes(sender.toLowerCase()));
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

        // Find the recipient's contact for this sender.
        // Priority: 1) token→contact mapping (exact), 2) name match, 3) fallback
        const recipientUserId = (req as any).ctx?.userId ?? "";
        const tokenLookup = bearer ? lookupCommTokenContact(ctx.db, bearer) : null;
        let matchedContact: { id: string; name: string; type: 'a2a'; config: Record<string, unknown>; userId: string } | undefined;
        if (tokenLookup) {
          const row = ctx.db.prepare("SELECT * FROM messenger_contacts WHERE id = ?").get(tokenLookup.contactId) as Record<string, unknown> | undefined;
          if (row) {
            matchedContact = {
              id: String(row.id), name: String(row.name), type: 'a2a', config: JSON.parse(String(row.config || '{}')),
              userId: String(row.user_id || ''),
            };
          }
        }
        if (!matchedContact) {
          const recipientContacts = (ctx.db.prepare(
            "SELECT * FROM messenger_contacts WHERE type = 'a2a' AND user_id = ?"
          ).all(recipientUserId) as Record<string, unknown>[]).map((r: any) => ({
            id: String(r.id), name: String(r.name), type: 'a2a' as const, config: JSON.parse(String(r.config || '{}')),
            userId: String(r.user_id || ''),
          }));
          matchedContact = recipientContacts.length === 1
            ? recipientContacts[0]
            : recipientContacts.find((c) => sender && (
                c.name === sender || c.name.toLowerCase().includes(sender.toLowerCase())
              )) || recipientContacts[0];
        }
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

        // Broadcast so the panel refreshes contact list (lastMessage)
        ctx.broadcast("messenger_changed", {});
        notifyA2a(senderLabel, text, matchedContact?.userId);

        res.json({ ok: true });
      },
    };

    return {
      tools: {
        SendMessageTool: sendMessageTool,
        UpdateAgentCardTool: buildUpdateAgentCardTool(ctx.db, ctx.broadcast, () => adapters.get("a2a"), () => relayClient),
      },
      routes,
    };
  },
};

export default plugin;
