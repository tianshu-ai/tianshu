// Server-side entrypoint for the WeChat channel plugin.
//
// What this file does:
//   1. Exports a ChannelAdapterFactory under `channels.WeChatChannel`.
//      The host's adapter manager instantiates it once per binding
//      row (each binding == one logged-in WeChat account).
//   2. Exposes three admin routes for the login flow:
//        POST /api/p/wechat/login/start { tenantId? }
//          → returns { qrcode, qrCodeImageUrl }
//        POST /api/p/wechat/login/poll  { qrcode, bindingId?, tenantId? }
//          → long-polls Tencent's QR-status endpoint, persists the
//            resulting token onto the binding's state-dir, and
//            updates the binding row (creating one if missing).
//        GET  /api/p/wechat/status
//          → diagnostic snapshot for the admin UI.
//
// The plugin assumes channel system support (channels: section in
// manifest, channelFactoryFor on PluginRegistry, adapter manager
// running) is already wired by the host. It does NOT activate the
// adapter itself — admin does that via the channel bindings CRUD
// once a token exists.

import type { Request, Response } from "express";
import path from "node:path";
import type {
  ChannelAdapterFactory,
  PluginContext,
  PluginServerExports,
  PluginServerModule,
} from "@tianshu-ai/plugin-sdk";
import {
  getBotQrCode,
  getQrCodeStatus,
} from "./ilink-api.js";
import { WeChatChannel, type WeChatChannelConfig } from "./channel.js";
import { WeChatState } from "./state.js";

interface WeChatPluginConfig extends WeChatChannelConfig {}

function readPluginConfig(raw: unknown): WeChatPluginConfig {
  const cfg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    baseUrl: typeof cfg.baseUrl === "string" ? cfg.baseUrl : undefined,
    botAgent: typeof cfg.botAgent === "string" ? cfg.botAgent : undefined,
  };
}

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    const pluginCfg = readPluginConfig(ctx.pluginConfig);
    const defaultBaseUrl = pluginCfg.baseUrl ?? "https://ilinkai.weixin.qq.com";

    // Channel factory — the host calls this once per binding.
    // We pass per-binding state directly via the adapter context,
    // so the same factory function serves every binding without
    // global mutable state.
    const factory: ChannelAdapterFactory = (adapterCtx) => {
      return new WeChatChannel({
        ...adapterCtx,
        config: {
          // Plugin-level defaults flow through; per-binding config
          // overrides if present.
          ...pluginCfg,
          ...(adapterCtx.config ?? {}),
        },
      });
    };

    return {
      channels: {
        WeChatChannel: factory,
      },
      routes: {
        // POST /api/p/wechat/login/start
        // Body (optional): { baseUrl?: string }
        // Returns: { qrcode, qrCodeImageUrl, baseUrl }
        loginStart: async (req: Request, res: Response) => {
          const body = (req.body ?? {}) as { baseUrl?: string };
          const baseUrl = body.baseUrl?.trim() || defaultBaseUrl;
          try {
            const resp = await getBotQrCode({ baseUrl });
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
              baseUrl,
            });
          } catch (err) {
            res.status(502).json({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },

        // POST /api/p/wechat/login/poll
        // Body: { qrcode, baseUrl?, bindingId?, displayName? }
        // - If bindingId is given AND exists, that binding's stateDir
        //   receives the token (admin-driven flow).
        // - If bindingId is missing, we synth one and write the
        //   token to its dir; the admin should then create a
        //   channel_bindings row pointing at it.
        loginPoll: async (req: Request, res: Response) => {
          const body = (req.body ?? {}) as {
            qrcode?: string;
            baseUrl?: string;
            bindingId?: string;
            displayName?: string;
          };
          if (!body.qrcode) {
            res.status(400).json({ ok: false, error: "missing qrcode" });
            return;
          }
          const baseUrl = body.baseUrl?.trim() || defaultBaseUrl;

          try {
            const resp = await getQrCodeStatus({ baseUrl, qrcode: body.qrcode });
            if (!resp.token) {
              // Not yet authorised; long-poll returned without a
              // token. Caller is expected to poll again.
              res.json({ ok: true, scanned: false, upstream: resp });
              return;
            }

            // Token in hand. We DO NOT persist here — the caller
            // is expected to mint a channel_bindings row carrying
            // this token in its `config.token` field, after which
            // the channel adapter manager can start a fresh
            // adapter against it. Two reasons:
            //   1. Plugin login routes are stateless on disk; the
            //      binding row IS the persistent source of truth.
            //   2. The host already owns the binding write path
            //      (POST /api/admin/channels/bindings, future PR).
            //      Coupling persistence into the plugin would
            //      duplicate that contract.
            res.json({
              ok: true,
              scanned: true,
              token: resp.token,
              username: resp.username,
              ilinkUserId: resp.username,
            });
          } catch (err) {
            res.status(502).json({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },

        // GET /api/p/wechat/status
        getStatus: (_req: Request, res: Response) => {
          res.json({
            ok: true,
            channel: "wechat",
            apiBaseUrl: defaultBaseUrl,
            botAgent: pluginCfg.botAgent ?? "tianshu",
            // The admin UI can pair this with /admin/channels for
            // binding-level status.
          });
        },
      },
    };
  },

  async deactivate() {
    // Channel adapters are stopped by the host's adapter manager
    // (it owns the lifecycle once a binding is registered).
    // Nothing else to clean up here.
  },
};

export default plugin;
