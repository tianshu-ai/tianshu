// Host-level tool: generate_image
//
// Uses tenant-configured image-gen models (see Settings → Models).
// Picks `config.models.imageGenModelId` when set, otherwise falls
// back to the first mode:"image-gen" model in the catalog.
//
// The tool is only registered when the tenant has at least one
// image-gen model configured — see handler.ts where we skip
// registration when listImageGenModels(config).length === 0.

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import type { ResolvedConfig } from "../../core/config.js";
import { findModel, listModels, resolveApiKey } from "../../core/llm.js";
import type { ToolExecutor } from "../../tools/index.js";

const GENERATED_DIR = "generated-images";

function extForMime(mime: string): string {
  if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("gif")) return ".gif";
  return ".png";
}

function saveImageToWorkspace(
  userHomeDir: string,
  base64: string,
  mimeType: string,
): { relPath: string; absPath: string } | null {
  try {
    const dir = path.join(userHomeDir, GENERATED_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const ext = extForMime(mimeType);
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const absPath = path.join(dir, filename);
    const bytes = Buffer.from(base64, "base64");
    fs.writeFileSync(absPath, bytes);
    return { relPath: `${GENERATED_DIR}/${filename}`, absPath };
  } catch {
    return null;
  }
}

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

/**
 * Whether the generate_image tool should be registered for this tenant.
 *
 * Rule: only when `models.imageGenModelId` is explicitly set to a
 * resolvable image-gen model. An empty / unset id means the operator
 * intentionally left it off — do not fall back to "first available".
 */
export function isImageGenEnabled(config: ResolvedConfig): boolean {
  const id = config.models?.imageGenModelId;
  if (!id) return false;
  const m = findModel(config, id);
  return !!m && m.mode === "image-gen";
}

export function buildGenerateImageHostTool(
  config: ResolvedConfig,
  userHomeDir: string | undefined,
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

      // Only use the explicitly configured image-gen model. When
      // unset the tool is not registered at all (see isImageGenEnabled),
      // so this branch only runs when the operator picked a model.
      const configuredId = config.models?.imageGenModelId;
      const model = configuredId
        ? findModel(config, configuredId)
        : undefined;
      if (!model || model.mode !== "image-gen") {
        return {
          ok: false,
          text:
            "No image generation model selected. Choose one in " +
            "Settings → Models → Image generation model.",
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

      // Save to workspace/generated-images/ so the UI can render it.
      // The relPath is included in the tool text so the frontend regex
      // can spot it and show an <img> pointing at /api/generated-images.
      let textOut = description;
      if (userHomeDir) {
        const saved = saveImageToWorkspace(userHomeDir, imageData, imageMime);
        if (saved) {
          textOut = `${description}\n\n${saved.relPath}`;
        }
      }

      return {
        ok: true,
        text: textOut,
        images: [{ base64: imageData, mimeType: imageMime }],
      };
    },
  };
}
