// generate_image tool — the agent calls this when it needs to
// create an image from a text prompt during conversation.

import { Type } from "typebox";
import type { AgentTool, AgentToolContext, PluginContext } from "@tianshu-ai/plugin-sdk";
import {
  generateImage,
  type GeminiConfig,
  type ImageGenResult,
} from "../providers/index.js";

export interface ImageGenPluginConfig {
  modelId?: string;
  defaultAspectRatio?: string;
}

export function buildGenerateImageTool(
  cfg: ImageGenPluginConfig,
  pluginCtx: PluginContext,
): AgentTool {
  return {
    schema: {
      name: "generate_image",
      description:
        "Generate an image from a text prompt. Returns the image " +
        "inline in the conversation. Use this when the user asks " +
        "you to draw, create, or generate an image, illustration, " +
        "diagram, icon, or any visual content. Write a detailed " +
        "English prompt for best results — describe subject, style, " +
        "lighting, composition, colors. The prompt is sent directly " +
        "to the image model.",
      parameters: Type.Object({
        prompt: Type.String({
          description:
            "Detailed image description in English. Be specific about " +
            "subject, style, composition, lighting, colors, mood. " +
            "Example: 'A serene Japanese garden with a wooden bridge " +
            "over a koi pond, cherry blossoms falling, soft morning " +
            "light, watercolor style'",
        }),
        aspect_ratio: Type.Optional(
          Type.String({
            description:
              'Aspect ratio. "1:1" (square, default), "16:9" (landscape), ' +
              '"9:16" (portrait), "4:3", "3:4".',
          }),
        ),
      }),
    },

    async execute(
      args: Record<string, unknown>,
      ctx: AgentToolContext,
    ): Promise<unknown> {
      const prompt = String(args.prompt ?? "");
      if (!prompt.trim()) {
        throw new Error("prompt is required");
      }

      const aspectRatio =
        typeof args.aspect_ratio === "string"
          ? args.aspect_ratio
          : cfg.defaultAspectRatio ?? "1:1";

      // Pick the configured model, or fall back to the first
      // image-gen model in the tenant catalog.
      const imageModels = pluginCtx.listModels?.("image-gen") ?? [];
      if (imageModels.length === 0) {
        throw new Error(
          "No image generation model configured. " +
          "Go to Settings → Models and add a model with mode \"image-gen\".",
        );
      }
      const model = cfg.modelId
        ? (pluginCtx.resolveModel?.(cfg.modelId) ?? imageModels[0]!)
        : imageModels[0]!;
      if (model.mode !== "image-gen") {
        throw new Error(
          `Model "${model.id}" is not an image-gen model. " +
          "Pick one from Settings → Image Generation."`,
        );
      }

      const geminiCfg: GeminiConfig = {
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        model: model.modelId,
        api: model.api,
      };

      ctx.log.info(
        `generate_image: provider=${model.providerId} model=${model.modelId} ratio=${aspectRatio} prompt=${prompt.slice(0, 80)}...`,
      );

      let result: ImageGenResult;
      try {
        result = await generateImage(
          geminiCfg,
          { prompt, aspectRatio },
          ctx.signal,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log.error(`generate_image failed: ${msg}`);
        throw new Error(`Image generation failed: ${msg}`);
      }

      // Return in the { ok, text, images } shape that
      // agent-tool-adapter.ts's normaliseToolResult + extractImages
      // recognises. The images array entries are passed through as
      // ImageContent in the tool_result message, so the vision
      // model can see the generated image on this turn.
      const description =
        result.text ?? `Generated image for: ${prompt.slice(0, 100)}`;
      return {
        ok: true,
        text: description,
        images: [{ base64: result.data, mimeType: result.mimeType }],
      };
    },
  };
}
