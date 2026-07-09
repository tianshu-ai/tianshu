// pi 0.80 `Models` construction.
//
// Background — what 0.80 changed:
//   pi-agent-core 0.79's `AgentHarness` took a
//   `getApiKeyAndHeaders: () => ({ apiKey })` callback and drove the
//   per-request LLM call through pi-ai's *global* `stream()` dispatch
//   (the singleton api-registry keyed by `model.api`).
//
//   0.80 keeps `AgentHarness` (and `harness.compact()`!) but removes
//   that callback. The harness now owns a `models: Models` instance
//   and calls `models.streamSimple(model, ctx, opts)` / `compact(...,
//   models, ...)`. `Models` resolves request auth itself, through each
//   provider's `auth.apiKey.resolve()`, rather than receiving a raw
//   apiKey per turn.
//
//   So the migration is: build a `Models` that wraps a single provider
//   whose `auth.apiKey.resolve()` hands back tianshu's already-resolved
//   per-tenant apiKey. The actual wire-level streaming still uses the
//   builtin api implementations — we borrow them from the `/compat`
//   api-registry (`getApiProvider(model.api)`), which is the same
//   dispatch table 0.79's global `stream()` used.
//
// Why per-run (not a long-lived singleton):
//   tianshu resolves the apiKey per chat run (placeholder expansion +
//   env at request time, see core/llm.ts:resolveApiKey). A `Models`
//   built here closes over exactly one (model, apiKey) pair and lives
//   for the duration of one harness — matching the previous
//   per-run `getApiKeyAndHeaders` lifetime. No global mutable state,
//   no cross-tenant leakage.

import {
  createModels,
  createProvider,
  type Model,
  type Models,
  type Api,
} from "@earendil-works/pi-ai";
import {
  getApiProvider,
  registerBuiltInApiProviders,
} from "@earendil-works/pi-ai/compat";
import {
  resolveResilience,
  wrapStreamFn,
  type StreamFn,
} from "./model-retry.js";
import type { ModelResilienceConfig } from "./config.js";

// The compat module registers the builtin api implementations on
// import (it self-calls `registerBuiltInApiProviders()` at module
// load). We call it again defensively — it is idempotent ("does not
// clobber existing entries", per its doc) — so this helper is safe to
// use even if some future refactor stops importing compat elsewhere
// first.
let registered = false;
function ensureBuiltinsRegistered(): void {
  if (registered) return;
  registerBuiltInApiProviders();
  registered = true;
}

/**
 * Build a single-provider `Models` collection for one resolved
 * (model, apiKey) pair, suitable for passing to `new AgentHarness({
 * models })` or to the standalone `compact()` / `generateSummary()`
 * helpers.
 *
 * The provider's auth always reports configured and resolves to the
 * supplied apiKey; the model already carries its `baseUrl` (set by
 * core/llm.ts:buildModel), so we leave baseUrl off the AuthResult and
 * let the model's own baseUrl flow through `Models.streamSimple`.
 */
export interface BuildModelsOptions {
  /** Retry policy from config.models.resilience. Undefined => defaults. */
  resilience?: ModelResilienceConfig;
  /** Re-resolve the apiKey for a retry after an auth failure (expired
   *  JWT). Should return the freshly-expanded key. When omitted, an
   *  auth-failure retry reuses the original key (still useful if the
   *  provider's own token cache refreshed out of band). */
  reResolveApiKey?: () => string;
}

export function buildModels(
  piModel: Model<Api>,
  apiKey: string,
  options?: BuildModelsOptions,
): Models {
  ensureBuiltinsRegistered();

  const apiStreams = getApiProvider(piModel.api);
  if (!apiStreams) {
    // Should never happen for a builtin api id; surfaces a clear
    // error instead of a confusing "stream is not a function" deep in
    // the harness if someone configures an unknown `provider.api`.
    throw new Error(
      `[pi-models] no builtin API implementation registered for api="${piModel.api}" ` +
        `(provider="${piModel.provider}", model="${piModel.id}")`,
    );
  }

  const provider = createProvider({
    id: piModel.provider,
    name: piModel.provider,
    // baseUrl is informational here; the per-request model carries the
    // authoritative baseUrl. We mirror it so status/UI reads are sane.
    baseUrl: piModel.baseUrl,
    auth: {
      apiKey: {
        name: `${piModel.provider} api key`,
        // No interactive `login` — tianshu manages keys via tenant
        // config, not pi's credential store. `resolve` ignores the
        // (absent) stored credential and always yields the apiKey we
        // closed over. Returning `undefined` would mark the provider
        // "unconfigured" and fail the request, so we always return a
        // result even for an empty key (matches 0.79, where an empty
        // apiKey was passed through to the provider unchanged).
        resolve: async () => ({
          auth: { apiKey },
          source: "tenant-config",
        }),
      },
    },
    models: [piModel],
    api: {
      stream: wrapWithRetry(apiStreams.stream, piModel, options),
      streamSimple: wrapWithRetry(apiStreams.streamSimple, piModel, options),
    },
  });

  const models = createModels();
  models.setProvider(provider);
  return models;
}

/** Wrap one api-registry stream function with the resilience policy,
 *  threading through the model label and (optional) apiKey re-resolver.
 *  The cast bridges pi-ai's per-api `StreamFunction` generics to the
 *  untyped dispatch `StreamFn` the retry wrapper operates on — both are
 *  `(model, context, options?) => AssistantMessageEventStream`. */
function wrapWithRetry(
  fn: (...args: never[]) => ReturnType<StreamFn>,
  piModel: Model<Api>,
  options: BuildModelsOptions | undefined,
): typeof fn {
  const resilience = resolveResilience(options?.resilience);
  if (!resilience.enabled || resilience.maxAttempts <= 1) return fn;
  const wrapped = wrapStreamFn(fn as unknown as StreamFn, {
    resilience,
    reResolveApiKey: options?.reResolveApiKey,
    label: `${piModel.provider}/${piModel.id}`,
  });
  return wrapped as unknown as typeof fn;
}
