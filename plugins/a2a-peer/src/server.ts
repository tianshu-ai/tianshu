// A2A Peer plugin — server entry.
//
// Enables tianshu-to-tianshu connections via invite-code pairing
// and bidirectional messaging.

import type { Request, Response } from "express";
import type {
  PluginContext,
  PluginServerExports,
  PluginServerModule,
  AgentTool,
  AgentToolContext,
} from "@tianshu-ai/plugin-sdk";
import {
  ensureSchema,
  listPeers,
  getPeer,
  createPeer,
  updatePeer,
  deletePeer,
  createInvite,
  getInviteByCode,
  markInviteUsed,
  logPeerMessage,
  listPeerMessages,
  type Peer,
} from "./schema.js";

// ── Types ───────────────────────────────────────────────────────

interface SessionInboxCapability {
  push(message: string): void;
}

// ── Helpers ─────────────────────────────────────────────────────

function genToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let t = "";
  for (let i = 0; i < 48; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

function getAgentCard(ctx: PluginContext): Record<string, unknown> {
  const branding = ctx.tenantConfig?.branding ?? {};
  return {
    name: (branding.name as string) || "Tianshu Agent",
    emoji: (branding.emoji as string) || "⭐",
    version: "0.1.0",
    capabilities: ["streaming", "text"],
  };
}

/**
 * Auth model (simplified):
 *
 * Each peer pair shares TWO tokens:
 *   - outboundToken: stored in peer.authToken, used BY US to send TO them
 *   - inboundToken:  stored in peer.agentCard._inboundToken, used BY THEM to send TO US
 *
 * When A creates invite + B connects:
 *   1. B generates inboundTokenForA (= token A will use to auth to B)
 *   2. B calls A's /pair with { returnToken: inboundTokenForA }
 *   3. A generates inboundTokenForB (= token B will use to auth to A)
 *   4. A stores peer(B) with authToken=inboundTokenForA (outbound to B)
 *      and returns { peerToken: inboundTokenForB }
 *   5. B stores peer(A) with authToken=inboundTokenForB (outbound to A)
 *      and _inboundToken=inboundTokenForA (verify inbound from A)
 *
 * On receive, we check _inboundToken across all peers.
 * For peers created via acceptPair, the peerToken we gave them IS our
 * inbound token — we store it so we can verify.
 */

// ── Plugin ──────────────────────────────────────────────────────

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    ensureSchema(ctx.db);

    const inbox = ctx.capabilities.get<SessionInboxCapability>("host.sessionInbox");
    function notifyAgent(message: string) { if (inbox) inbox.push(message); }

    /** Find peer by inbound auth token. */
    function findPeerByInboundToken(token: string): Peer | undefined {
      const all = listPeers(ctx.db);
      return all.find((p) => {
        if (p.status !== "active") return false;
        const inbound = (p.agentCard as Record<string, unknown>)?._inboundToken;
        return inbound === token;
      });
    }

    /** Send message to a peer. */
    async function sendToPeer(peer: Peer, text: string, sender: string): Promise<{ ok: boolean; error?: string }> {
      try {
        const resp = await fetch(`${peer.endpointUrl.replace(/\/$/, "")}/api/p/a2a-peer/receive`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${peer.authToken}`,
          },
          body: JSON.stringify({ text, sender }),
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          return { ok: false, error: `HTTP ${resp.status}: ${body}` };
        }
        logPeerMessage(ctx.db, { peerId: peer.id, direction: "outbound", sender, text });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // ── Agent tool ────────────────────────────────────────────

    const peerMessageTool: AgentTool = {
      schema: {
        name: "peer_message",
        description: "Send a message to a connected tianshu peer, or list peers. action='list' | action='send' (requires 'to' and 'message').",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "send"] },
            to: { type: "string", description: "Peer name" },
            message: { type: "string", description: "Message text" },
          },
          required: ["action"],
        },
      },
      async execute(args: Record<string, unknown>, _toolCtx: AgentToolContext) {
        const action = String(args.action);
        if (action === "list") {
          const peers = listPeers(ctx.db);
          if (peers.length === 0) return { ok: true, text: "No connected peers." };
          const lines = peers.map((p) => `- ${p.name} (${p.status})`);
          return { ok: true, text: `Connected peers:\n${lines.join("\n")}` };
        }
        if (action === "send") {
          const name = String(args.to || "");
          const text = String(args.message || "");
          if (!name || !text) return { ok: false, text: "Both 'to' and 'message' are required." };
          const peers = listPeers(ctx.db);
          const peer = peers.find((p) => p.name.toLowerCase() === name.toLowerCase() && p.status === "active");
          if (!peer) return { ok: false, text: `Peer "${name}" not found or not active.` };
          const result = await sendToPeer(peer, text, "agent");
          return result.ok
            ? { ok: true, text: `Message sent to ${peer.name}.` }
            : { ok: false, text: `Failed to send: ${result.error}` };
        }
        return { ok: false, text: `Unknown action: ${action}` };
      },
    };

    // ── Routes ────────────────────────────────────────────────

    const routes: Record<string, (req: Request, res: Response) => void | Promise<void>> = {

      // GET /peers
      listPeers: (_req, res) => {
        const peers = listPeers(ctx.db).map((p) => ({
          id: p.id, name: p.name, endpointUrl: p.endpointUrl,
          agentCard: { ...p.agentCard, _inboundToken: undefined },
          status: p.status, createdAt: p.createdAt,
        }));
        res.json({ ok: true, peers });
      },

      // POST /invite — generate invite code
      createInvite: (_req, res) => {
        const invite = createInvite(ctx.db);
        res.json({ ok: true, code: invite.code, expiresAt: invite.expiresAt });
      },

      // POST /pair — called by REMOTE to accept invite (no auth)
      acceptPair: (req, res) => {
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

        // inboundTokenForB = token we give B so B can send TO US
        const inboundTokenForB = genToken();
        const peerName = String(agentCard.name || "Remote Peer");

        // Store B as peer:
        //   authToken = returnToken (we use this to send TO B)
        //   _inboundToken = inboundTokenForB (B uses this to send TO US)
        const peer = createPeer(ctx.db, {
          name: peerName,
          endpointUrl,
          agentCard: { ...agentCard, _inboundToken: inboundTokenForB },
          authToken: returnToken,
        });
        markInviteUsed(ctx.db, invite.id, peer.id);

        ctx.broadcast("a2a_peer_changed", {});
        notifyAgent(`[A2A Peer] 新连接：「${peerName}」(${endpointUrl})`);

        res.json({ ok: true, peerToken: inboundTokenForB, agentCard: getAgentCard(ctx) });
      },

      // POST /connect — called by LOCAL user to pair with remote
      connectPeer: async (req, res) => {
        const { code, remoteUrl } = (req.body ?? {}) as { code?: string; remoteUrl?: string };
        if (!code || !remoteUrl) {
          res.status(400).json({ ok: false, error: "missing code or remoteUrl" });
          return;
        }

        // inboundTokenForA = token A (remote) will use to send TO US
        const inboundTokenForA = genToken();

        // Figure out our public URL
        const publicUrl = String(ctx.pluginConfig.publicUrl || "");
        if (!publicUrl) {
          res.status(400).json({ ok: false, error: "publicUrl not configured in plugin settings" });
          return;
        }

        try {
          const resp = await fetch(`${remoteUrl.replace(/\/$/, "")}/api/p/a2a-peer/pair`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              code: code.toUpperCase(),
              endpointUrl: publicUrl,
              agentCard: getAgentCard(ctx),
              returnToken: inboundTokenForA,
            }),
            signal: AbortSignal.timeout(15000),
          });

          const body = await resp.json() as Record<string, unknown>;
          if (!resp.ok || !body.ok) {
            res.status(resp.status >= 400 ? resp.status : 502).json({ ok: false, error: body.error || `HTTP ${resp.status}` });
            return;
          }

          const remoteCard = (body.agentCard as Record<string, unknown>) || {};
          const peerName = String(remoteCard.name || "Remote Peer");

          // Store A as peer:
          //   authToken = peerToken (we use this to send TO A)
          //   _inboundToken = inboundTokenForA (A uses this to send TO US)
          createPeer(ctx.db, {
            name: peerName,
            endpointUrl: remoteUrl,
            agentCard: { ...remoteCard, _inboundToken: inboundTokenForA },
            authToken: String(body.peerToken),
          });

          ctx.broadcast("a2a_peer_changed", {});
          notifyAgent(`[A2A Peer] 已连接到：「${peerName}」(${remoteUrl})`);

          res.json({ ok: true, peer: { name: peerName, endpointUrl: remoteUrl } });
        } catch (err) {
          res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      },

      // POST /receive — receive message from remote peer
      receiveMessage: (req, res) => {
        const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
        if (!token) { res.status(401).json({ ok: false, error: "unauthorized" }); return; }

        const peer = findPeerByInboundToken(token);
        if (!peer) { res.status(403).json({ ok: false, error: "invalid token" }); return; }

        const { text, sender } = (req.body ?? {}) as { text?: string; sender?: string };
        if (!text) { res.status(400).json({ ok: false, error: "missing text" }); return; }

        logPeerMessage(ctx.db, { peerId: peer.id, direction: "inbound", sender: sender || peer.name, text });

        ctx.broadcast("a2a_peer_message", { peerId: peer.id, peerName: peer.name, sender: sender || peer.name, text });
        notifyAgent(`[A2A Peer] 「${peer.name}」: ${text}`);

        res.json({ ok: true });
      },

      // POST /send — send message to peer (from local UI)
      sendMessage: async (req, res) => {
        const { peerId, text } = (req.body ?? {}) as { peerId?: string; text?: string };
        if (!peerId || !text) { res.status(400).json({ ok: false, error: "missing peerId or text" }); return; }
        const peer = getPeer(ctx.db, peerId);
        if (!peer || peer.status !== "active") { res.status(404).json({ ok: false, error: "peer not found" }); return; }
        const result = await sendToPeer(peer, text, "user");
        if (result.ok) {
          ctx.broadcast("a2a_peer_message", { peerId: peer.id, peerName: peer.name, sender: "me", text, direction: "outbound" });
        }
        res.json(result);
      },

      // GET /messages/:peerId
      listMessages: (req, res) => {
        const peerId = (req.params as Record<string, string>).peerId;
        if (!peerId) { res.status(400).json({ ok: false }); return; }
        res.json({ ok: true, messages: listPeerMessages(ctx.db, peerId) });
      },

      // DELETE /peers/:id
      removePeer: (req, res) => {
        const id = (req.params as Record<string, string>).id;
        const ok = deletePeer(ctx.db, id);
        if (ok) ctx.broadcast("a2a_peer_changed", {});
        res.json({ ok });
      },

      // PUT /peers/:id
      updatePeerRoute: (req, res) => {
        const id = (req.params as Record<string, string>).id;
        const { status } = (req.body ?? {}) as { status?: string };
        if (!status || !["active", "disabled"].includes(status)) {
          res.status(400).json({ ok: false, error: "invalid status" });
          return;
        }
        const ok = updatePeer(ctx.db, id, { status: status as "active" | "disabled" });
        if (ok) ctx.broadcast("a2a_peer_changed", {});
        res.json({ ok });
      },
    };

    ctx.log.info("a2a-peer activated", { peers: listPeers(ctx.db).length });

    return {
      tools: { PeerMessageTool: peerMessageTool },
      routes,
    };
  },
};

export default plugin;
