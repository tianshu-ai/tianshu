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
import {
  generateImage,
  type GeminiConfig,
} from "./providers/index.js";

function readConfig(ctx: PluginContext): ImageGenPluginConfig {
  const raw = (ctx.pluginConfig ?? {}) as Record<string, unknown>;
  return {
    provider: (raw.provider as "gemini") ?? "gemini",
    modelId: typeof raw.modelId === "string" && raw.modelId ? raw.modelId : undefined,
    defaultAspectRatio: typeof raw.defaultAspectRatio === "string" ? raw.defaultAspectRatio : undefined,
  };
}

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    const cfg = readConfig(ctx);
    ctx.log.info(
      `image-gen: provider=${cfg.provider ?? "gemini"}, modelId=${cfg.modelId ?? "(not set)"}`,
    );

    return {
      tools: {
        GenerateImageTool: buildGenerateImageTool(cfg, ctx),
      },
      routes: {
        // GET /api/p/image-gen/status — check if the provider is configured
        getStatus: async (_req: Request, res: Response) => {
          const provider = cfg.provider ?? "gemini";
          const modelId = cfg.modelId;
          let modelResolved = false;
          let modelInfo: Record<string, unknown> = {};

          if (modelId && ctx.resolveModel) {
            const m = ctx.resolveModel(modelId);
            if (m) {
              modelResolved = true;
              modelInfo = {
                providerId: m.providerId,
                modelId: m.modelId,
                api: m.api,
                baseUrl: m.baseUrl,
                mode: m.mode,
              };
            }
          }

          res.json({
            provider,
            modelId: modelId ?? null,
            modelResolved,
            modelInfo,
            defaultAspectRatio: cfg.defaultAspectRatio ?? "1:1",
          });
        },

        // POST /api/p/image-gen/test — test generation with a simple prompt
        testGenerate: async (req: Request, res: Response) => {
          const provider = cfg.provider ?? "gemini";
          if (provider !== "gemini") {
            res.status(400).json({ error: `Provider ${provider} not supported yet` });
            return;
          }

          const modelId = cfg.modelId;
          if (!modelId) {
            res.status(400).json({ error: "No model configured. Set modelId in plugin settings." });
            return;
          }

          const model = ctx.resolveModel?.(modelId);
          if (!model) {
            res.status(400).json({ error: `Model "${modelId}" not found in configured providers.` });
            return;
          }

          const geminiCfg: GeminiConfig = {
            baseUrl: model.baseUrl,
            apiKey: model.apiKey,
            model: model.modelId,
            api: model.api,
          };

          const prompt =
            typeof req.body?.prompt === "string"
              ? req.body.prompt
              : "A cute cat wearing a tiny hat, digital art style";
          try {
            const result = await generateImage(
              geminiCfg,
              { prompt, aspectRatio: cfg.defaultAspectRatio ?? "1:1" },
              AbortSignal.timeout(30_000),
            );
            res.json({
              ok: true,
              mimeType: result.mimeType,
              text: result.text,
              dataLength: result.data.length,
            });
          } catch (err) {
            res.status(500).json({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      },
    };
  },
};

export default plugin;
