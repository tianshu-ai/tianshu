// Image generation plugin server entry.

import type { Request, Response } from "express";
import type {
  PluginContext,
  PluginServerExports,
  PluginServerModule,
} from "@tianshu-ai/plugin-sdk";
import {
  buildGenerateImageTool,
  type ImageGenPluginConfig,
} from "./tools/generate.js";

function readConfig(ctx: PluginContext): ImageGenPluginConfig {
  const raw = (ctx.pluginConfig ?? {}) as Record<string, unknown>;
  return {
    defaultAspectRatio:
      typeof raw.defaultAspectRatio === "string"
        ? raw.defaultAspectRatio
        : undefined,
  };
}

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    const cfg = readConfig(ctx);
    const imageModels = ctx.listModels?.("image-gen") ?? [];
    ctx.log.info(
      `image-gen: ${imageModels.length} image-gen model(s) available` +
        (imageModels.length
          ? `: ${imageModels.map((m) => m.id).join(", ")}`
          : ""),
    );

    return {
      tools: {
        GenerateImageTool: buildGenerateImageTool(cfg, ctx),
      },
      routes: {
        // GET /api/p/image-gen/status
        getStatus: async (_req: Request, res: Response) => {
          const models = ctx.listModels?.("image-gen") ?? [];
          res.json({
            available: models.length > 0,
            models: models.map((m) => ({
              id: m.id,
              providerId: m.providerId,
              modelId: m.modelId,
              api: m.api,
            })),
            defaultAspectRatio: cfg.defaultAspectRatio ?? "1:1",
          });
        },
      },
    };
  },
};

export default plugin;
