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

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    // Channel factory — the host's adapter manager calls this
    // once per channel_bindings row. The adapter reads token +
    // identity from adapterCtx.config (set by /login/poll's
    // host.channelBindings.create() call below).
    const factory: ChannelAdapterFactory = (adapterCtx) =>
      new WeChatChannel(adapterCtx);

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
            if (!resp.token) {
              // Not yet confirmed; admin UI keeps polling.
              res.json({ ok: true, scanned: false });
              return;
            }
            // Got a token. Persist a binding + start its adapter
            // in one capability call. The host writes the row,
            // updates status to "running" if start() succeeds,
            // or "error" + status_detail if it doesn't. Either
            // way the row sticks around for admin visibility.
            const display =
              body.displayName?.trim() ||
              resp.username?.trim() ||
              "WeChat";
            const binding = await bindings.create({
              channelId: "wechat",
              pluginId: "wechat",
              displayName: display,
              config: {
                token: resp.token,
                ilinkUserId: resp.username,
                username: resp.username,
              },
              enabled: true,
            });
            res.json({ ok: true, scanned: true, binding });
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
