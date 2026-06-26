// WeChat channel plugin — server entry.
//
// User-facing surface is a single admin page (contributed via
// manifest as `WeChatAdminPage`). The page calls these four
// routes:
//
//   POST /api/p/wechat/login/start
//     → { ok, qrcode, qrCodeImageUrl }
//     Calls Tencent's iLink `get_bot_qrcode`. The QR id (`qrcode`)
//     is the cursor for the subsequent long-poll.
//
//   POST /api/p/wechat/login/poll  { qrcode, displayName? }
//     → { ok, scanned: true, binding } | { ok, scanned: false }
//     Long-polls `get_qrcode_status`. On scan success, creates a
//     channel_bindings row through host.channelBindings AND
//     starts the WeChatChannel adapter against it. From this
//     point the bot is live: inbound DMs route to the agent,
//     replies flow back through `adapter.send`.
//
//   GET /api/p/wechat/bindings
//     → { ok, bindings: ChannelBindingView[] }
//     Lists existing wechat bindings for the tenant. The admin
//     UI uses this to render the "logged-in accounts" list.
//
//   DELETE /api/p/wechat/bindings/:id
//     → { ok }
//     Stops the adapter and deletes the row. Token is forgotten.
//
// The iLink API base URL and bot_agent string are intentionally
// hard-coded in src/ilink-api.ts + src/channel.ts. They're
// platform constants of the iLink integration, not user-tunable
// dials. Exposing them as plugin config would have invited
// "what URL should I put here?" support questions for zero
// upside.

import type { Request, Response } from "express";
import type {
  ChannelAdapterFactory,
  ChannelBindingsCapability,
  PluginContext,
  PluginServerExports,
  PluginServerModule,
} from "@tianshu-ai/plugin-sdk";
import {
  getBotQrCode,
  getQrCodeStatus,
} from "./ilink-api.js";
import { WeChatChannel } from "./channel.js";

// Map of bindingId -> WeChatChannel instance, kept so the
// /stats admin route can read live adapter counters. The
// factory adds an entry every time the host instantiates an
// adapter; we don't get a destroy callback today, so entries
// for removed bindings stay until the plugin re-activates.
// Acceptable since the map is small + only used for debug.
const liveAdapters = new Map<string, WeChatChannel>();

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    // Channel factory — the host's adapter manager calls this
    // once per channel_bindings row. The adapter reads token +
    // identity from adapterCtx.config (set by /login/poll's
    // host.channelBindings.create() call below).
    const factory: ChannelAdapterFactory = (adapterCtx) => {
      const adapter = new WeChatChannel(adapterCtx);
      liveAdapters.set(adapterCtx.bindingId, adapter);
      return adapter;
    };

    // Pull the binding capability once at activate time. It's
    // a typed handle into host-side CRUD; we just relay route
    // requests through it.
    const bindings = ctx.capabilities.get<ChannelBindingsCapability>(
      "host.channelBindings",
    );
    if (!bindings) {
      throw new Error(
        "wechat plugin requires host.channelBindings capability; the host is too old or misconfigured.",
      );
    }

    return {
      channels: {
        WeChatChannel: factory,
      },
      routes: {
        // POST /login/start → { qrcode, qrCodeImageUrl }
        loginStart: async (_req: Request, res: Response) => {
          try {
            const resp = await getBotQrCode({});
            if (!resp.qrcode || !resp.qrcode_img_content) {
              res.status(502).json({
                ok: false,
                error: "iLink returned an empty QR code",
                upstream: resp,
              });
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

        // POST /login/poll { qrcode, displayName? }
        //   → { ok, scanned: false }   while pending
        //   → { ok, scanned: true, binding } after confirm
        loginPoll: async (req: Request, res: Response) => {
          const body = (req.body ?? {}) as {
            qrcode?: string;
            displayName?: string;
          };
          if (!body.qrcode) {
            res.status(400).json({ ok: false, error: "missing qrcode" });
            return;
          }
          try {
            const resp = await getQrCodeStatus({ qrcode: body.qrcode });
            const status = resp.status ?? "wait";

            // Terminal success: token issued. Persist a binding
            // + start its adapter in one capability call.
            if (status === "confirmed" && resp.bot_token) {
              const display =
                body.displayName?.trim() ||
                resp.username?.trim() ||
                resp.ilink_user_id ||
                "WeChat";
              // baseurl is Tencent's binding-specific host. When
              // non-empty we MUST use it for every subsequent
              // call; the QR-login host doesn't necessarily know
              // about this token after confirm.
              const bindingBaseUrl = resp.baseurl?.trim();
              const binding = await bindings.create({
                channelId: "wechat",
                pluginId: "wechat",
                displayName: display,
                config: {
                  token: resp.bot_token,
                  ilinkUserId: resp.ilink_user_id,
                  username: resp.username ?? resp.ilink_user_id,
                  baseUrl: bindingBaseUrl || undefined,
                },
                enabled: true,
              });
              res.json({ ok: true, scanned: true, status: "confirmed", binding });
              return;
            }

            // Terminal failure: QR expired or pairing blocked.
            if (status === "expired" || status === "verify_code_blocked") {
              res.status(410).json({
                ok: false,
                scanned: false,
                status,
                error:
                  status === "expired"
                    ? "QR code expired; refresh and try again."
                    : "Too many failed pairing attempts; try again later.",
              });
              return;
            }

            // Unsupported v0 paths: pairing-code prompt + host
            // redirect. Surface as errors for now; UI tells admin
            // to retry.
            if (status === "need_verifycode" || status === "scaned_but_redirect") {
              res.json({
                ok: false,
                scanned: false,
                status,
                error: `wechat login path not implemented yet: ${status}`,
              });
              return;
            }

            // Intermediate states ("wait", "scaned") — admin UI keeps polling.
            res.json({ ok: true, scanned: false, status });
          } catch (err) {
            res.status(502).json({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },

        // GET /bindings
        listBindings: (_req: Request, res: Response) => {
          const list = bindings.list({ channelId: "wechat" });
          // Strip the token before serialising \u2014 the admin UI
          // doesn't need to see it and we don't want it floating
          // around browser dev tools / log streams.
          const sanitised = list.map((b) => ({
            ...b,
            config: redactConfig(b.config),
          }));
          res.json({ ok: true, bindings: sanitised });
        },

        // GET /stats — diagnostic: per-binding long-poll counters.
        // Useful when debugging "why aren't my inbound messages
        // showing up". Returns null fields for any binding the
        // adapter hasn't started yet.
        // GET /sessions — list wechat channel sessions for the
        // current tenant. The sidebar section in client.tsx polls
        // this so plugin authors don't have to reach into host
        // session storage; the host's /api/channel-sessions is
        // still around but channel-agnostic. Per-channel rendering
        // (icon, pill, label) belongs to the plugin.
        listSessions: (_req: Request, res: Response) => {
          const rows = ctx.db
            .prepare<
              [],
              {
                id: string;
                channel_chat_id: string;
                channel_binding_id: string | null;
                title: string | null;
                created_at: number;
              }
            >(
              `SELECT id, channel_chat_id, channel_binding_id, title, created_at
                 FROM sessions
                WHERE channel_id = 'wechat'
                  AND kind = 'user'
                ORDER BY created_at DESC`,
            )
            .all();
          res.json({
            ok: true,
            sessions: rows.map((r) => ({
              id: r.id,
              channelChatId: r.channel_chat_id,
              bindingId: r.channel_binding_id,
              title: r.title,
              createdAt: r.created_at,
            })),
          });
        },

        getStats: (_req: Request, res: Response) => {
          const entries: Array<{ bindingId: string; stats: unknown }> = [];
          for (const [id, adapter] of liveAdapters) {
            entries.push({ bindingId: id, stats: adapter.stats });
          }
          res.json({ ok: true, adapters: entries });
        },

        // DELETE /bindings/:id
        deleteBinding: async (req: Request, res: Response) => {
          const raw = req.params.id;
          const id = Array.isArray(raw) ? raw[0] : raw;
          if (!id) {
            res.status(400).json({ ok: false, error: "missing binding id" });
            return;
          }
          const removed = await bindings.delete(id);
          if (!removed) {
            res.status(404).json({ ok: false, error: "binding not found" });
            return;
          }
          res.json({ ok: true });
        },
      },
    };
  },

  async deactivate() {
    // Channel adapters are stopped by the host's adapter manager
    // (it owns the lifecycle once a binding is registered).
  },
};

/** Replace anything that looks like a secret in `config` with
 *  a redaction marker before sending it across the wire. The
 *  admin UI uses display_name + status; nothing else from the
 *  config row is needed client-side. */
function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (k === "token" && typeof v === "string" && v.length > 0) {
      out[k] = "***";
    } else {
      out[k] = v;
    }
  }
  return out;
}

export default plugin;
