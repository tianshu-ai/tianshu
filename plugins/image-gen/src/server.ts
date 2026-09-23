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
  geminiGenerateImage,
  type GeminiConfig,
} from "./providers/index.js";

function readConfig(ctx: PluginContext): ImageGenPluginConfig {
  const raw = (ctx.pluginConfig ?? {}) as Record<string, unknown>;
  return {
    provider: (raw.provider as "gemini") ?? "gemini",
    geminiBaseUrl: typeof raw.geminiBaseUrl === "string" ? raw.geminiBaseUrl : undefined,
    geminiApiKey: typeof raw.geminiApiKey === "string" ? raw.geminiApiKey : undefined,
    geminiModel: typeof raw.geminiModel === "string" ? raw.geminiModel : undefined,
    defaultAspectRatio: typeof raw.defaultAspectRatio === "string" ? raw.defaultAspectRatio : undefined,
  };
}

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    const cfg = readConfig(ctx);
    ctx.log.info(
      `image-gen: provider=${cfg.provider ?? "gemini"}, model=${cfg.geminiModel ?? "default"}`,
    );

    return {
      tools: {
        GenerateImageTool: buildGenerateImageTool(cfg),
      },
      routes: {
        // GET /api/p/image-gen/status — check if the provider is configured
        getStatus: async (_req: Request, res: Response) => {
          const provider = cfg.provider ?? "gemini";
          const configured =
            provider === "gemini"
              ? !!(cfg.geminiBaseUrl || cfg.geminiApiKey)
              : false;
          res.json({
            provider,
            configured,
            geminiModel: cfg.geminiModel ?? "gemini-2.0-flash-preview-image-generation",
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
          const geminiCfg: GeminiConfig = {
            baseUrl: cfg.geminiBaseUrl ?? "https://generativelanguage.googleapis.com",
            apiKey: cfg.geminiApiKey ?? "",
            model: cfg.geminiModel ?? "gemini-2.0-flash-preview-image-generation",
          };
          const prompt =
            typeof req.body?.prompt === "string"
              ? req.body.prompt
              : "A cute cat wearing a tiny hat, digital art style";
          try {
            const result = await geminiGenerateImage(
              geminiCfg,
              { prompt, aspectRatio: cfg.defaultAspectRatio ?? "1:1" },
              AbortSignal.timeout(30_000),
            );
            res.json({
              ok: true,
              mimeType: result.mimeType,
              text: result.text,
              // Don't send full base64 in test — just confirm it worked
              dataLength: result.data.length,
              preview: `data:${result.mimeType};base64,${result.data.slice(0, 100)}...`,
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
