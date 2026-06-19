// LLM provider check: at least one provider configured, each
// provider's apiKey resolves to a non-empty value, defaultModel
// points at something real.
//
// Optional reachability probe (`probe: true`) hits each provider's
// /v1/models or equivalent with a short timeout. Off by default
// because the startup hook can't afford 5s per provider.

import {
  loadGlobalConfig,
  type GlobalConfig,
  type ProviderEntry,
} from "../../core/config.js";
import { CheckGroup } from "../render.js";

export interface ProvidersCheckOpts {
  home?: string;
  /** When true, hit each provider's models endpoint. */
  probe?: boolean;
  probeTimeoutMs?: number;
  /** Inject pre-loaded config (test seam). */
  config?: GlobalConfig;
}

const PLACEHOLDER_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)(?::-(.*))?\}$/;

interface ResolvedKey {
  literal: string | null;
  envVar: string | null;
  fallback: string | null;
}

/** Mirrors core/llm.ts's `${VAR}` / `${VAR:-fallback}` resolution
 *  but tells us *what* it resolved (env var name, fallback) so we
 *  can produce useful diagnostics. */
function resolveKey(raw: string | undefined): ResolvedKey {
  if (!raw) return { literal: null, envVar: null, fallback: null };
  const m = PLACEHOLDER_PATTERN.exec(raw.trim());
  if (!m) return { literal: raw, envVar: null, fallback: null };
  const [, name, fallback] = m;
  const fromEnv = process.env[name!];
  const literal = fromEnv && fromEnv.length > 0 ? fromEnv : (fallback ?? null);
  return {
    literal: literal && literal.length > 0 ? literal : null,
    envVar: name ?? null,
    fallback: fallback ?? null,
  };
}

export async function checkProviders(
  opts: ProvidersCheckOpts = {},
): Promise<CheckGroup> {
  const lines: CheckGroup["lines"] = [];
  let config: GlobalConfig;
  try {
    config = opts.config ?? loadGlobalConfig(opts.home);
  } catch (err) {
    return {
      title: "LLM providers",
      lines: [
        {
          severity: "blocker",
          text: "config.json failed to load",
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }

  const providers = config.models?.providers ?? {};
  const ids = Object.keys(providers);

  if (ids.length === 0) {
    lines.push({
      severity: "blocker",
      text: "no providers configured",
      detail: "Add at least one entry under `models.providers` in config.json (or run `tianshu setup --wizard`).",
    });
    return { title: "LLM providers", lines };
  }

  for (const id of ids) {
    const entry = providers[id] as ProviderEntry;
    const resolved = resolveKey(entry.apiKey);
    if (!resolved.literal) {
      lines.push({
        severity: "blocker",
        text: `${id}: API key not set`,
        detail: resolved.envVar
          ? `apiKey references \${${resolved.envVar}} but that env var is empty. Set it in .env or your shell.`
          : `apiKey field is missing on this provider.`,
      });
      continue;
    }
    const modelCount = entry.models?.length ?? 0;
    const baseDetail = resolved.envVar
      ? `${modelCount} model(s); key from \${${resolved.envVar}}`
      : `${modelCount} model(s)`;

    if (opts.probe) {
      const probeRes = await probeProvider(id, entry, opts.probeTimeoutMs ?? 5000);
      if (probeRes.ok) {
        lines.push({
          severity: "ok",
          text: `${id} reachable`,
          detail: `${baseDetail}; ${probeRes.latencyMs}ms`,
        });
      } else {
        lines.push({
          severity: "warning",
          text: `${id}: probe failed`,
          detail: `${baseDetail}. ${probeRes.error}`,
        });
      }
    } else {
      lines.push({
        severity: "ok",
        text: `${id} configured`,
        detail: baseDetail,
      });
    }
  }

  // defaultModel should resolve to one of the configured providers.
  const def = config.defaultModel;
  if (!def) {
    lines.push({
      severity: "warning",
      text: "no defaultModel set",
      detail: "callers without an explicit modelId will fail. Set `defaultModel` in config.json.",
    });
  } else {
    const slash = def.indexOf("/");
    const provId = slash > 0 ? def.slice(0, slash) : null;
    if (provId && providers[provId]) {
      lines.push({
        severity: "ok",
        text: `defaultModel resolves`,
        detail: def,
      });
    } else {
      lines.push({
        severity: "blocker",
        text: `defaultModel references unknown provider`,
        detail: `\`${def}\` — provider id is "${provId ?? "(missing /)"}"; known: ${ids.join(", ")}`,
      });
    }
  }

  return { title: "LLM providers", lines };
}

interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

async function probeProvider(
  id: string,
  entry: ProviderEntry,
  timeoutMs: number,
): Promise<ProbeResult> {
  const start = Date.now();
  const url = pickProbeUrl(entry);
  if (!url) {
    return {
      ok: false,
      latencyMs: 0,
      error: `no probe URL known for api=${entry.api ?? "(none)"}`,
    };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: probeHeaders(entry),
      signal: ac.signal,
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return {
        ok: false,
        latencyMs,
        error: `HTTP ${res.status} from ${url}`,
      };
    }
    return { ok: true, latencyMs };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error:
        err instanceof Error
          ? err.name === "AbortError"
            ? `timeout after ${timeoutMs}ms`
            : err.message
          : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function pickProbeUrl(entry: ProviderEntry): string | undefined {
  const base = entry.baseUrl?.replace(/\/+$/, "");
  // OpenAI-style providers expose /v1/models. Anthropic /v1/messages
  // requires a POST so we just probe /v1/models which 404s but
  // confirms reachability + auth — actually, we use the OpenAI-
  // compat `/v1/models` against our gateway. Real Anthropic URL is
  // also fine to skip the probe (network present is enough).
  if (entry.api === "openai-completions" && base) return `${base}/v1/models`;
  if (entry.api === "anthropic-messages" && base) return `${base}/v1/models`;
  if (entry.api === "google-generative-ai" && base) return `${base}/v1/models`;
  return undefined;
}

function probeHeaders(entry: ProviderEntry): Record<string, string> {
  const apiKey = resolveKey(entry.apiKey).literal;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!apiKey) return headers;
  if (entry.api === "anthropic-messages") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}
