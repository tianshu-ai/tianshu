// Probe the configured default model with a minimal LLM call.
//
// Used by the setup wizard's "smart" flow: if the user already
// has a working config, we skip the wizard and go straight to
// `tianshu doctor`. If the probe fails we drop into the wizard.
//
// The probe is a 1-token "hi" completion with a 6-second timeout.
// We catch every conceivable error path (config malformed,
// provider unreachable, key wrong, model id wrong, network
// flaking) and surface it as a structured `ProbeResult`. Callers
// branch on that, never on raw exceptions.

// pi 0.80: global `completeSimple()` dispatch lives behind `/compat`.
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import {
  buildModel,
  getDefaultModel,
  resolveApiKey,
} from "../core/llm.js";
import { loadGlobalConfig, mergeConfigs } from "../core/config.js";

export interface ProbeResult {
  /** Convenience: was the call successful end-to-end? */
  ok: boolean;
  /** What we tried — useful for logging / wizard pre-fill. */
  modelId?: string;
  baseUrl?: string;
  /** When `ok=false`, why. */
  error?: {
    /**
     * Categorical reason. The wizard branches on this:
     *   no-config / no-default-model → ask everything from scratch.
     *   bad-key                       → re-prompt for key only.
     *   network / timeout             → re-prompt for baseUrl.
     *   unknown                       → drop into the full wizard.
     */
    kind:
      | "no-config"
      | "no-default-model"
      | "no-api-key"
      | "bad-key"
      | "model-not-found"
      | "network"
      | "timeout"
      | "unknown";
    message: string;
  };
  /** Wall time. Quick bonus for the doctor. */
  durationMs: number;
}

export interface ProbeOpts {
  home?: string;
  /** Default 6s; bumpable for slow corp gateways. */
  timeoutMs?: number;
}

export async function probeDefaultModel(
  opts: ProbeOpts = {},
): Promise<ProbeResult> {
  const start = Date.now();
  let config;
  try {
    config = loadGlobalConfig(opts.home);
  } catch (err) {
    return {
      ok: false,
      durationMs: Date.now() - start,
      error: {
        kind: "no-config",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // Resolve through mergeConfigs so models.defaultModelId is
  // correctly picked up (raw GlobalConfig skips the resolve logic).
  const resolved = mergeConfigs(config, {});
  const info = getDefaultModel(resolved);
  if (!info) {
    return {
      ok: false,
      durationMs: Date.now() - start,
      error: {
        kind: "no-default-model",
        message:
          "no providers configured (or defaultModel doesn't resolve to one).",
      },
    };
  }

  const apiKey = resolveApiKey(info);
  if (!apiKey) {
    return {
      ok: false,
      modelId: info.id,
      baseUrl: info.baseUrl,
      durationMs: Date.now() - start,
      error: {
        kind: "no-api-key",
        message: `apiKey for ${info.providerId} resolved to empty; set ${
          info.apiKeyTemplate ?? `the provider's API key`
        } in config or .env.`,
      },
    };
  }

  let model: Model<Api>;
  try {
    model = buildModel(info);
  } catch (err) {
    return {
      ok: false,
      modelId: info.id,
      baseUrl: info.baseUrl,
      durationMs: Date.now() - start,
      error: {
        kind: "unknown",
        message: `buildModel failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 6000);
  try {
    // 1-token "hi" — cheapest possible round-trip that exercises
    // the auth + endpoint + model id end-to-end.
    const ctx: Context = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi" }],
          timestamp: Date.now(),
        },
      ],
    };
    await completeSimple(model, ctx, { signal: ac.signal, apiKey });
    clearTimeout(timer);
    return {
      ok: true,
      modelId: info.id,
      baseUrl: info.baseUrl,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      modelId: info.id,
      baseUrl: info.baseUrl,
      durationMs: Date.now() - start,
      error: classifyError(err),
    };
  }
}

function classifyError(err: unknown): NonNullable<ProbeResult["error"]> {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (err instanceof Error && err.name === "AbortError") {
    return { kind: "timeout", message: msg };
  }
  if (
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("authentication")
  ) {
    return { kind: "bad-key", message: msg };
  }
  if (
    lower.includes("404") ||
    lower.includes("model not found") ||
    lower.includes("does not exist")
  ) {
    return { kind: "model-not-found", message: msg };
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("network") ||
    lower.includes("fetch failed")
  ) {
    return { kind: "network", message: msg };
  }
  return { kind: "unknown", message: msg };
}
