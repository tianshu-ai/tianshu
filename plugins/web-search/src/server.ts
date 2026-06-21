// Server side of the `web-search` plugin.
//
// One agent tool (`web_search`), backed by Tavily / Brave Search
// JSON APIs. The plugin's `activate()` reads its API keys from
// `ctx.pluginConfig` (cleartext at this layer; the host has
// already merged secrets/ into pluginConfig before calling us)
// and bakes them into a closure handed to the tool builder.
//
// The plugin also keeps a `ProviderHealth` cache shared by every
// invocation in this activation, so a worker that searches ten
// times in a row pays the round-trip on a known-bad key only
// once. The cache is cleared automatically when the plugin
// re-activates (any config change does this) and via the
// `POST /health/reset` admin route below.

import type { Request, Response } from "express";
import type {
  PluginContext,
  PluginServerExports,
  PluginServerModule,
} from "@tianshu-ai/plugin-sdk";
import { buildWebSearchTool, readWebSearchConfig } from "./tools/index.js";
import { ProviderHealth } from "./tools/health.js";

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    const cfg = readWebSearchConfig(ctx.pluginConfig);
    const haveTavily = !!cfg.tavilyApiKey;
    const haveBrave = !!cfg.braveApiKey;
    if (!haveTavily && !haveBrave) {
      ctx.log.warn(
        "web-search: no API keys configured. Open Settings → Plugins → Web Search and add a Tavily or Brave key.",
      );
    } else {
      ctx.log.info(
        `web-search: enabled with ${
          [haveTavily && "Tavily", haveBrave && "Brave"]
            .filter(Boolean)
            .join(" + ") || "(no providers)"
        }`,
      );
    }

    const health = new ProviderHealth();

    return {
      tools: {
        WebSearchTool: buildWebSearchTool(cfg, health),
      },
      routes: {
        // GET /api/p/web-search/health
        getHealth: (_req: Request, res: Response) => {
          res.json({
            ok: true,
            providers: {
              tavily: { configured: haveTavily },
              brave: { configured: haveBrave },
            },
            preferredProvider: cfg.preferredProvider ?? "tavily",
            timeoutMs: cfg.timeoutMs ?? 8000,
            dead: health.snapshot(),
          });
        },
        // POST /api/p/web-search/health/reset
        // Body is optional: { provider?: "tavily" | "brave" }.
        // Without `provider` the whole cache clears.
        resetHealth: (req: Request, res: Response) => {
          const body = req.body as { provider?: unknown } | undefined;
          const target = body?.provider;
          if (target === "tavily" || target === "brave") {
            health.resetOne(target);
            res.json({ ok: true, cleared: [target] });
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
    // ProviderHealth is per-activation; the GC takes care of it
    // when activate() is called again (registry invalidate cycle).
  },
};

export default plugin;
