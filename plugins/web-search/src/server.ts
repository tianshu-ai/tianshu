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
import {
  buildWebSearchTool,
  buildWebFetchTool,
  readWebSearchConfig,
  effectiveScheme,
  isConfigured,
} from "./tools/index.js";
import { ProviderHealth } from "./tools/health.js";

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    const cfg = readWebSearchConfig(ctx.pluginConfig);
    const scheme = effectiveScheme(cfg);
    if (!isConfigured(cfg)) {
      ctx.log.warn(
        `web-search: scheme "${scheme}" is selected but not fully ` +
          `configured. Open Settings → Plugins → Web Search ` +
          `(searxng needs a base URL; tavily/brave need a key). ` +
          `web_fetch still works without any config.`,
      );
    } else {
      const detail =
        scheme === "hosted"
          ? `hosted (${cfg.hostedBackend ?? "exa"}${
              (cfg.hostedBackend === "parallel"
                ? cfg.parallelApiKey
                : cfg.exaApiKey)
                ? ", keyed"
                : ", key-free"
            })`
          : scheme === "searxng"
            ? `searxng (${cfg.searxngBaseUrl})`
            : scheme;
      ctx.log.info(`web-search: enabled — scheme ${detail}; web_fetch on`);
    }

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
            scheme,
            configured: isConfigured(cfg),
            providers: {
              hosted: {
                configured: true,
                backend: cfg.hostedBackend ?? "exa",
                keyed: Boolean(
                  (cfg.hostedBackend === "parallel"
                    ? cfg.parallelApiKey
                    : cfg.exaApiKey),
                ),
              },
              searxng: { configured: Boolean(cfg.searxngBaseUrl) },
              tavily: { configured: Boolean(cfg.tavilyApiKey) },
              brave: { configured: Boolean(cfg.braveApiKey) },
            },
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
          if (
            target === "tavily" ||
            target === "brave" ||
            target === "hosted" ||
            target === "searxng"
          ) {
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
