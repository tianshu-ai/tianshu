// Messenger plugin — server entry.
//
// Exposes a `send_message` tool so the agent can push messages to
// configured contacts (WeChat friends, A2A-connected agents, etc.).
// Settings panel manages contacts via REST routes.

import type {
  PluginContext,
  PluginServerExports,
  PluginServerModule,
  PluginRouteHandler,
} from "@tianshu-ai/plugin-sdk";
import type { Request, Response } from "express";
import { ensureSchema, type Db } from "./schema.js";
import {
  listContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  type ContactType,
} from "./schema.js";
import { buildSendMessageTool, type SendAdapter } from "./tool.js";
import { createWeChatAdapter } from "./adapters/wechat.js";

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    ensureSchema(ctx.db);

    // ── adapters ────────────────────────────────────────────────
    const adapters = new Map<string, SendAdapter>();

    // WeChat adapter: the host registers a "channelHub.send" custom
    // capability for builtin plugins that need outbound channel access.
    // Falls back gracefully if not available (wechat plugin not active).
    const channelSendCap = (ctx as any)._channelSend as
      | ((bindingId: string, msg: { target: string; text: string }) => Promise<void>)
      | undefined;
    adapters.set("wechat", createWeChatAdapter({
      channelSend: channelSendCap,
    }));

    // WS / A2A adapter: TODO — phase 2.
    // adapters.set("ws", createA2AAdapter({ ... }));

    ctx.log.info("messenger activated", {
      adapters: [...adapters.keys()],
    });

    // ── tool ────────────────────────────────────────────────────
    const sendMessageTool = buildSendMessageTool({
      db: ctx.db,
      adapters,
    });

    // ── REST routes ─────────────────────────────────────────────
    const routes: Record<string, PluginRouteHandler> = {
      listContacts: (_req: Request, res: Response) => {
        const contacts = listContacts(ctx.db);
        res.json({ ok: true, contacts });
      },

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
        ctx.broadcast("messenger_changed", {});
        res.json({ ok: true, contact });
      },

      updateContact: (req: Request, res: Response) => {
        const id = (req as any).params?.id;
        if (!id) { res.status(400).json({ ok: false, error: "id required" }); return; }
        const { name, type, config, waitReply, enabled } = req.body ?? {};
        const updates: Record<string, unknown> = {};
        if (name !== undefined) updates.name = name;
        if (type !== undefined) updates.type = type;
        if (config !== undefined) updates.config = config;
        if (waitReply !== undefined) updates.waitReply = waitReply;
        if (enabled !== undefined) updates.enabled = enabled;
        const ok = updateContact(ctx.db, id, updates as any);
        if (ok) ctx.broadcast("messenger_changed", {});
        res.json({ ok });
      },

      deleteContact: (req: Request, res: Response) => {
        const id = (req as any).params?.id;
        if (!id) { res.status(400).json({ ok: false, error: "id required" }); return; }
        const ok = deleteContact(ctx.db, id);
        if (ok) ctx.broadcast("messenger_changed", {});
        res.json({ ok });
      },

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
    };

    return {
      tools: { SendMessageTool: sendMessageTool },
      routes,
    };
  },
};

export default plugin;
