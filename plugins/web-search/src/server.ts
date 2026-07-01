// Server side of the `web-search` plugin.
//
// Two agent tools:
//   - web_search  — key-free hosted MCP search (Exa or Parallel;
//                    the operator picks the backend in config)
//   - web_fetch   — dependency-free single-page fetch → markdown
//
// The plugin's `activate()` reads its config from
// `ctx.pluginConfig` and bakes it into the tool builders. A shared
// `ProviderHealth` cache is cleared on re-activation (any config
// change) and via `POST /health/reset`.

import type { Request, Response } from "express";
import type {
  PluginContext,
  PluginServerExports,
  PluginServerModule,
} from "@tianshu-ai/plugin-sdk";
import {
  buildWebSearchTool,
  buildWebFetchTool,
  readWebSearchConfig,
} from "./tools/index.js";
import { ProviderHealth } from "./tools/health.js";

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    const cfg = readWebSearchConfig(ctx.pluginConfig);
    const backend = cfg.backend ?? "exa";
    ctx.log.info(
      `web-search: enabled — key-free hosted search via ${backend}; web_fetch on`,
    );

    const health = new ProviderHealth();

    return {
      tools: {
        WebSearchTool: buildWebSearchTool(cfg, health),
        WebFetchTool: buildWebFetchTool({ timeoutMs: cfg.timeoutMs }),
      },
      routes: {
        // GET /api/p/web-search/health
        getHealth: (_req: Request, res: Response) => {
          res.json({
            ok: true,
            backend,
            timeoutMs: cfg.timeoutMs ?? 8000,
            dead: health.snapshot(),
          });
        },
        // POST /api/p/web-search/health/reset
        // Body optional: { provider?: "hosted" }. Without it the
        // whole cache clears.
        resetHealth: (req: Request, res: Response) => {
          const body = req.body as { provider?: unknown } | undefined;
          if (body?.provider === "hosted") {
            health.resetOne("hosted");
            res.json({ ok: true, cleared: ["hosted"] });
            return;
          }
          const before = health.snapshot().map((e) => e.provider);
          health.reset();
          res.json({ ok: true, cleared: before });
        },
      },
    };
  },
  async deactivate() {
    // ProviderHealth is per-activation; GC handles it on re-activate.
  },
};

export default plugin;
