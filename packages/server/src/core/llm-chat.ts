/**
 * General-purpose LLM chat helper.
 *
 * Provides a simple `llmChat()` function that any server-side code
 * (plugins, routes, board apps) can use to call an LLM with messages.
 * Handles model resolution, API key injection, and streaming.
 *
 * Usage:
 *   import { llmChat } from "../core/llm-chat.js";
 *   const result = await llmChat({
 *     tenantId: "default",
 *     messages: [{ role: "user", content: "Hello" }],
 *     model: "anthropic/claude-sonnet-4-6", // optional, uses default
 *     stream: false,
 *   });
 */

import {
  buildModel,
  findModel,
  getDefaultModel,
  resolveApiKey,
  type ResolvedModelInfo,
} from "./llm.js";
import { resolveTenantConfig } from "./config.js";
import { getTianshuHome } from "./paths.js";
import { buildModels } from "./pi-models.js";
import type { Message } from "@earendil-works/pi-ai";

export interface LlmChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmChatOptions {
  /** Tenant id. Default: "default". */
  tenantId?: string;
  /** Full model id (e.g. "anthropic/claude-sonnet-4-6"). Uses default if omitted. */
  model?: string;
  /** Messages to send. */
  messages: LlmChatMessage[];
  /** Max output tokens. Default: 4096. */
  maxTokens?: number;
  /** Temperature. Default: provider default. */
  temperature?: number;
  /** System prompt (prepended as system message). */
  system?: string;
}

export interface LlmChatResult {
  ok: boolean;
  text: string;
  model: string;
  usage?: { input: number; output: number; total: number };
  error?: string;
}

/**
 * Call an LLM and return the full text response.
 * Non-streaming, simple request/response.
 */
export async function llmChat(opts: LlmChatOptions): Promise<LlmChatResult> {
  const tenantId = opts.tenantId ?? "default";
  const home = getTianshuHome();

  let config;
  try {
    config = resolveTenantConfig(tenantId, home);
  } catch (err) {
    return { ok: false, text: "", model: "", error: `config error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const modelInfo: ResolvedModelInfo | undefined = opts.model
    ? findModel(config, opts.model)
    : getDefaultModel(config);

  if (!modelInfo) {
    return { ok: false, text: "", model: opts.model ?? "", error: `model not found: ${opts.model ?? "(default)"}` };
  }

  const piModel = buildModel(modelInfo);
  const apiKey = resolveApiKey(modelInfo);
  const models = buildModels(piModel, apiKey);

  // Build messages in pi-ai format
  const messages: Message[] = [];
  let systemPrompt = opts.system ?? "";
  for (const m of opts.messages) {
    if (m.role === "system") {
      systemPrompt += (systemPrompt ? "\n" : "") + m.content;
    } else {
      messages.push({ role: m.role, content: m.content, timestamp: Date.now() } as unknown as Message);
    }
  }

  try {
    // Use streamSimple to get the full response
    let fullText = "";
    const context = {
      messages,
      ...(systemPrompt ? { systemPrompt } : {}),
    };
    const stream = models.streamSimple(piModel, context, {
      maxTokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature,
    });
    for await (const event of stream) {
      console.log(`[llm-chat] event: ${event.type}`);
      if (event.type === "text_delta") {
        fullText += event.delta;
      } else if (event.type === "done") {
        if (!fullText && event.message?.content) {
          for (const part of event.message.content) {
            if ((part as { type: string }).type === "text") {
              fullText += (part as { text: string }).text ?? "";
            }
          }
        }
      }
    }
    return {
      ok: true,
      text: fullText,
      model: modelInfo.id,
    };
  } catch (err) {
    return {
      ok: false,
      text: "",
      model: modelInfo.id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
