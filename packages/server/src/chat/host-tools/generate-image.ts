// Host-level tool: generate_image
//
// Uses tenant-configured image-gen models (see Settings → Models).
// Picks `config.models.imageGenModelId` when set, otherwise falls
// back to the first mode:"image-gen" model in the catalog.
//
// The tool is only registered when the tenant has at least one
// image-gen model configured — see handler.ts where we skip
// registration when listImageGenModels(config).length === 0.

import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import type { ResolvedConfig } from "../../core/config.js";
import { findModel, listModels, resolveApiKey } from "../../core/llm.js";
import type { ToolExecutor } from "../../tools/index.js";

interface GenerateImageArgs {
  prompt?: string;
  aspect_ratio?: string;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<
        | { text?: string }
        | { inlineData?: { mimeType: string; data: string } }
      >;
    };
  }>;
}

/** Return the list of image-gen models available in the tenant catalog. */
export function listImageGenModels(config: ResolvedConfig) {
  return listModels(config).filter((m) => m.mode === "image-gen");
}

export function buildGenerateImageHostTool(
  config: ResolvedConfig,
  signal?: AbortSignal,
): { schema: Tool; executor: ToolExecutor } {
  return {
    schema: {
      name: "generate_image",
      description:
        "Generate an image from a text prompt. Returns the image " +
        "inline in the conversation so you can see and describe it. " +
        "Use this when the user asks you to draw, create, or generate " +
        "an image, illustration, diagram, icon, or any visual content. " +
        "Write a detailed English prompt for best results — describe " +
        "subject, style, lighting, composition, colors. The prompt is " +
        "sent directly to the image model.",
      parameters: Type.Object({
        prompt: Type.String({
          description:
            "Detailed image description in English. Be specific about " +
            "subject, style, composition, lighting, colors, mood.",
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
    executor: async (args: Record<string, unknown>) => {
      const a = args as GenerateImageArgs;
      const prompt = String(a.prompt ?? "").trim();
      if (!prompt) {
        return { ok: false, text: "prompt is required" };
      }
      const aspectRatio =
        typeof a.aspect_ratio === "string" && a.aspect_ratio
          ? a.aspect_ratio
          : "1:1";

      // Pick the configured image-gen model, else the first available.
      const configuredId = config.models?.imageGenModelId;
      let model = configuredId ? findModel(config, configuredId) : undefined;
      if (!model || model.mode !== "image-gen") {
        model = listImageGenModels(config)[0];
      }
      if (!model) {
        return {
          ok: false,
          text:
            "No image generation model available. Add a model with " +
            'mode "image-gen" in Settings → Models.',
        };
      }

      const secret = resolveApiKey(model);
      const isNative = model.api === "google-generative-ai";

      const url = isNative
        ? secret
          ? `${model.baseUrl}/v1beta/models/${model.modelId}:generateContent?key=${encodeURIComponent(secret)}`
          : `${model.baseUrl}/v1beta/models/${model.modelId}:generateContent`
        : `${model.baseUrl}/v1beta/models/${model.modelId}:generateContent`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (!isNative && secret) {
        headers["Authorization"] = `Bearer ${secret}`;
      }

      const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ["image", "text"],
          imageConfig: { aspectRatio },
        },
      };

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        return {
          ok: false,
          text: `Image generation network error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        return {
          ok: false,
          text: `Image generation failed: HTTP ${res.status} — ${errBody.slice(0, 500)}`,
        };
      }

      const json = (await res.json()) as GeminiResponse;

      let imageData: string | undefined;
      let imageMime = "image/png";
      let text: string | undefined;

      const parts = json.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if ("inlineData" in part && part.inlineData) {
          imageData = part.inlineData.data;
          imageMime = part.inlineData.mimeType;
        } else if ("text" in part && part.text) {
          text = part.text;
        }
      }

      if (!imageData) {
        return {
          ok: false,
          text: "Model returned no image. The prompt may have been refused by a safety filter.",
        };
      }

      const description = text ?? `Generated image for: ${prompt.slice(0, 100)}`;
      return {
        ok: true,
        text: description,
        images: [{ base64: imageData, mimeType: imageMime }],
      };
    },
  };
}
