// Gemini image generation via the native generateContent API.
//
// Uses responseModalities: ["image", "text"] to get the model to
// return an inline image in the response parts.
//
// Reference:
//   POST /v1beta/models/{model}:generateContent
//   generationConfig.responseModalities = ["image", "text"]
//   generationConfig.imageConfig = { aspectRatio, imageSize }
//
// Response: candidates[].content.parts[].inlineData.{mimeType, data}

export interface GeminiConfig {
  baseUrl: string;
  apiKey: string;
  /** The bare model name (no provider prefix), e.g. "gemini-2.0-flash-preview-image-generation". */
  model: string;
  /** API protocol — "google-generative-ai" uses native Gemini, others use OpenAI compat. */
  api: string;
}

export interface ImageGenRequest {
  prompt: string;
  aspectRatio?: string;
  /** "1K" | "2K" | "4K" — only gemini-3-pro supports 2K/4K */
  imageSize?: string;
}

export interface ImageGenResult {
  /** base64-encoded image data */
  data: string;
  mimeType: string;
  /** Optional text description returned alongside the image */
  text?: string;
}

/**
 * Call Gemini's generateContent API with image output modality.
 * Returns the first image part from the response.
 */
export async function generateImage(
  config: GeminiConfig,
  req: ImageGenRequest,
  signal?: AbortSignal,
): Promise<ImageGenResult> {
  const { baseUrl, apiKey, model, api } = config;

  // Native Gemini API: POST /v1beta/models/{model}:generateContent
  // OpenAI-compat proxies: we still need the native endpoint for image gen
  // because responseModalities is a Gemini-specific feature.
  const isNative = api === "google-generative-ai";

  let url: string;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (isNative) {
    // Native Gemini: API key in query param
    url = apiKey
      ? `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`
      : `${baseUrl}/v1beta/models/${model}:generateContent`;
  } else {
    // OpenAI-compat proxy (e.g. SAP AI Proxy) — use Bearer auth
    // and the Gemini native path (proxy should forward it)
    url = `${baseUrl}/v1beta/models/${model}:generateContent`;
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
  }

  const body = {
    contents: [
      {
        parts: [{ text: req.prompt }],
      },
    ],
    generationConfig: {
      responseModalities: ["image", "text"],
      imageConfig: {
        aspectRatio: req.aspectRatio ?? "1:1",
        ...(req.imageSize ? { imageSize: req.imageSize } : {}),
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(
      `Gemini image generation failed: HTTP ${res.status} — ${errorBody.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<
          | { text?: string }
          | { inlineData?: { mimeType: string; data: string } }
        >;
      };
    }>;
  };

  // Extract image and text from response parts
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
    throw new Error(
      "Gemini returned no image. The model may have refused the prompt or hit a safety filter.",
    );
  }

  return { data: imageData, mimeType: imageMime, text };
}
