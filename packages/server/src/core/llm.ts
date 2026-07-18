// Provider catalog → pi-ai `Model<Api>` resolution.
//
// The user-facing config (config.json `models.providers`) maps cleanly
// onto pi-ai's runtime Model shape. We do that mapping here.
//
// Model IDs surfaced to the rest of the system are
// `<providerId>/<modelEntry.id>`, e.g. `anthropic/claude-sonnet-4-6` or
// `local-llama/Qwen3.6-35B-A3B-Q8_0.gguf`.
//
// Placeholder substitution (`${VAR}` / `${VAR:-fallback}`) happens at
// request time, not at config-load time, so secrets do not sit in
// process memory longer than necessary.

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelEntry, ModelsCatalog, ProviderEntry, ResolvedConfig } from "./config.js";

export interface ResolvedModelInfo {
  /** Full id, e.g. "anthropic/claude-sonnet-4-6". */
  id: string;
  providerId: string;
  modelId: string;
  name: string;
  api: Api;
  baseUrl: string;
  group?: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  supportsImages: boolean;
  /** Per-image byte cap before we hand it to the provider. */
  imageMaxBytes: number;
  mode: "chat" | "image-gen";
  compat?: Record<string, unknown>;
  /** Raw apiKey string from config (may still contain ${VAR} placeholders). */
  apiKeyTemplate?: string;
}

const DEFAULT_API_BY_PROVIDER: Record<string, Api> = {
  anthropic: "anthropic-messages",
  openai: "openai-completions",
  google: "google-generative-ai",
};

// Provider per-image byte caps (base64 size, not raw).
//
// We default to 1 MB across the board even though Anthropic accepts
// up to 5 MB and OpenAI/Gemini up to 20 MB. Reasoning:
//   - Vision encoders internally downscale to ~1568px long edge
//     anyway; bigger inputs gain nothing visible to the model but
//     cost real money on per-pixel pricing.
//   - Smaller payloads cut latency dramatically (round-trip
//     dominates above ~2 MB on most networks; gateways like Bedrock
//     impose 60s end-to-end timeouts that high-res phone photos
//     blow through).
//   - Tenants who genuinely need higher fidelity (medical imaging,
//     OCR-heavy layouts) override per-model via
//     `provider.models[].imageMaxBytes` in tenant config.
const DEFAULT_IMAGE_MAX_BYTES_BY_PROVIDER: Record<string, number> = {
  anthropic: 1 * 1024 * 1024,
  openai: 1 * 1024 * 1024,
  google: 1 * 1024 * 1024,
};
const DEFAULT_IMAGE_MAX_BYTES_FALLBACK = 1 * 1024 * 1024;

function defaultImageMaxBytes(providerId: string): number {
  return (
    DEFAULT_IMAGE_MAX_BYTES_BY_PROVIDER[providerId] ??
    DEFAULT_IMAGE_MAX_BYTES_FALLBACK
  );
}

/** Walk a ResolvedConfig and emit one `ResolvedModelInfo` per (provider, model). */
export function listModels(config: ResolvedConfig): ResolvedModelInfo[] {
  const out: ResolvedModelInfo[] = [];
  const catalog = config.models;
  if (!catalog) return out;
  for (const [providerId, provider] of Object.entries(catalog.providers)) {
    if (!provider.models) continue;
    for (const m of provider.models) {
      // Embedding models are a separate catalog (listEmbeddingModels);
      // they are never selectable as chat/agent models.
      if (m.mode === "embedding") continue;
      out.push(toModelInfo(providerId, provider, m));
    }
  }
  return out;
}

/** A resolved embedding model: everything the wiki (or any plugin)
 *  needs to call an OpenAI-compatible `/embeddings` endpoint. Built
 *  from a `mode: "embedding"` catalog entry. apiKey placeholders are
 *  already expanded. */
export interface ResolvedEmbeddingModel {
  /** Full id `<provider>/<model>` — the value stored in plugin config. */
  id: string;
  providerId: string;
  /** Model id passed as `model` in the /embeddings request. */
  model: string;
  name: string;
  /** Provider base URL; the caller POSTs `<baseUrl>/embeddings`. */
  baseUrl: string;
  /** Resolved API key (env placeholders expanded). May be empty for
   *  keyless local servers. */
  apiKey: string;
  /** Optional output dimensions. */
  dimensions?: number;
}

/** Enumerate every `mode: "embedding"` model in the catalog. */
export function listEmbeddingModels(
  config: ResolvedConfig,
): ResolvedEmbeddingModel[] {
  const out: ResolvedEmbeddingModel[] = [];
  const catalog = config.models;
  if (!catalog) return out;
  for (const [providerId, provider] of Object.entries(catalog.providers)) {
    if (!provider.models) continue;
    for (const m of provider.models) {
      if (m.mode !== "embedding") continue;
      out.push({
        id: `${providerId}/${m.id}`,
        providerId,
        model: m.id,
        name: m.name ?? m.id,
        baseUrl: provider.baseUrl ?? "",
        apiKey: expandEnvPlaceholders(provider.apiKey) ?? "",
        dimensions: m.dimensions,
      });
    }
  }
  return out;
}

/** Resolve a single embedding model by its full id `<provider>/<model>`. */
export function findEmbeddingModel(
  config: ResolvedConfig,
  fullId: string | undefined,
): ResolvedEmbeddingModel | undefined {
  if (!fullId) return undefined;
  return listEmbeddingModels(config).find((m) => m.id === fullId);
}

/** Look up by full id `<provider>/<model>`. Returns undefined if missing. */
export function findModel(
  config: ResolvedConfig,
  fullId: string,
): ResolvedModelInfo | undefined {
  const slash = fullId.indexOf("/");
  if (slash < 0) return undefined;
  const providerId = fullId.slice(0, slash);
  const modelId = fullId.slice(slash + 1);
  const provider = config.models?.providers?.[providerId];
  if (!provider) return undefined;
  const entry = provider.models?.find((m) => m.id === modelId);
  if (!entry) return undefined;
  return toModelInfo(providerId, provider, entry);
}

/** Resolve the configured default model, falling back to the first listed. */
export function getDefaultModel(config: ResolvedConfig): ResolvedModelInfo | undefined {
  if (config.defaultModel) {
    const found = findModel(config, config.defaultModel);
    if (found) return found;
  }
  return listModels(config)[0];
}

/**
 * Build a pi-ai `Model<Api>` from a ResolvedModelInfo.
 */
export function buildModel(info: ResolvedModelInfo): Model<Api> {
  return {
    id: info.modelId,
    name: info.name,
    api: info.api,
    provider: info.providerId,
    baseUrl: info.baseUrl,
    reasoning: info.reasoning,
    input: info.supportsImages ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    ...(info.compat ? { compat: info.compat as never } : {}),
  };
}

/**
 * Resolve the API key string for a model, expanding `${VAR}` placeholders.
 * Falls back to `DEFAULT_API_KEY` env, then to `"test-key-1"` (the
 * convention used by the closed-source repo's local SAP proxy).
 */
export function resolveApiKey(info: ResolvedModelInfo): string {
  const expanded = expandEnvPlaceholders(info.apiKeyTemplate);
  if (expanded && expanded.length > 0) return expanded;
  return process.env.DEFAULT_API_KEY ?? "test-key-1";
}

// ─── internals ────────────────────────────────────────────────────

function toModelInfo(
  providerId: string,
  provider: ProviderEntry,
  entry: ModelEntry,
): ResolvedModelInfo {
  const api =
    (provider.api as Api | undefined) ?? DEFAULT_API_BY_PROVIDER[providerId] ?? "openai-completions";
  return {
    id: `${providerId}/${entry.id}`,
    providerId,
    modelId: entry.id,
    name: entry.name ?? entry.id,
    api,
    baseUrl: provider.baseUrl ?? "",
    group: provider.group,
    reasoning: entry.reasoning ?? false,
    contextWindow: entry.contextWindow ?? 128000,
    maxTokens: entry.maxTokens ?? 4096,
    supportsImages: entry.supportsImages ?? true,
    imageMaxBytes: entry.imageMaxBytes ?? defaultImageMaxBytes(providerId),
    mode: entry.mode === "image-gen" ? "image-gen" : "chat",
    compat: entry.compat,
    apiKeyTemplate: provider.apiKey,
  };
}

/** `${VAR}` and `${VAR:-fallback}` → process.env[VAR] | fallback | "". */
function expandEnvPlaceholders(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_m, name, fallback) => {
    return process.env[name] ?? fallback ?? "";
  });
}

export const __internal = { expandEnvPlaceholders };

// Quiet unused-import fix when typings shift.
export type { ModelsCatalog };
