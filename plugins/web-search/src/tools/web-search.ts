// `web_search(query, count?, language?, freshness?, provider?)`.
//
// One tool, two provider adapters, optional fallback. The plugin's
// `activate()` reads its API keys from `ctx.pluginConfig` and
// hands them into `buildWebSearchTool(cfg)` as a closure. The
// host re-activates the plugin when config changes, so the keys
// stay current without per-call config plumbing.
//
// Tenant config shape:
//
//   {
//     "plugins": {
//       "web-search": {
//         "config": {
//           "tavilyApiKey": "tvly-...",
//           "braveApiKey":  "BSA...",
//           "preferredProvider": "tavily" | "brave"  // optional
//         }
//       }
//     }
//   }
//
// If both keys are configured we prefer `preferredProvider` (or
// "tavily" by default) and fall back to the other one ONLY when
// the first returns a clearly transient error (network reset, 5xx,
// 429, or zero results when both providers are available). Bad
// keys (401/403) don't trigger fallback — that's a config problem
// the user needs to fix, not a runtime hiccup.

import { Type } from "typebox";
import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";
import {
  braveProvider,
  hostedProvider,
  searxngProvider,
  tavilyProvider,
  type ProviderName,
  type SearchOpts,
  type SearchResult,
  type SearchProvider,
} from "./providers.js";
import { ProviderHealth } from "./health.js";

/** Which search scheme the operator picked. The plugin supports
 *  two key-free schemes (hosted MCP + self-hosted SearXNG) and two
 *  key-based ones (Tavily + Brave) kept from the original plugin. */
export type SearchScheme = "hosted" | "searxng" | "tavily" | "brave";

export interface WebSearchPluginConfig {
  /** Operator's chosen scheme. Defaults to "hosted" (key-free). */
  scheme?: SearchScheme;
  // Key-free scheme config:
  /** Backend for the hosted MCP scheme. */
  hostedBackend?: "exa" | "parallel";
  /** Optional key for the hosted backend (higher limits; not
   *  required — the free tier works anonymously). */
  exaApiKey?: string;
  parallelApiKey?: string;
  /** Base URL of a self-hosted SearXNG instance. */
  searxngBaseUrl?: string;
  // Key-based scheme config (unchanged):
  tavilyApiKey?: string;
  braveApiKey?: string;
  /** Optional default timeout override (ms). 8000 if unset. */
  timeoutMs?: number;
}

export function buildWebSearchTool(
  cfg: WebSearchPluginConfig,
  health: ProviderHealth,
): AgentTool {
  return {
    schema: {
      name: "web_search",
      description:
        "Search the web for up-to-date information. Returns a JSON " +
        "array of `{ title, url, content, publishedDate }` objects, " +
        "ranked by the underlying provider. Backed by Tavily or " +
        "Brave Search depending on which API key the host has " +
        "configured. Use this for current events, recent docs, " +
        "anything that may have changed since training. Don't loop " +
        "many tiny searches \u2014 refine the query and increase `count`.",
      parameters: Type.Object({
        query: Type.String({
          description: "Free-text search query, 1-300 chars.",
        }),
        count: Type.Optional(
          Type.Number({
            description: "Number of results (1-20). Default 5.",
            minimum: 1,
            maximum: 20,
          }),
        ),
        language: Type.Optional(
          Type.String({
            description:
              "Language hint, ISO 639-1 or locale (e.g. \"zh-CN\", \"en\"). " +
              "Only applied by providers that accept it.",
          }),
        ),
        freshness: Type.Optional(
          Type.Union(
            [
              Type.Literal("day"),
              Type.Literal("week"),
              Type.Literal("month"),
              Type.Literal("year"),
            ],
            {
              description:
                "Recency filter. Default is no filter (all results, ranked by relevance).",
            },
          ),
        ),
        provider: Type.Optional(
          Type.Union(
            [
              Type.Literal("hosted"),
              Type.Literal("searxng"),
              Type.Literal("tavily"),
              Type.Literal("brave"),
            ],
            {
              description:
                "Force a specific provider. Default uses the scheme the host configured.",
            },
          ),
        ),
      }),
    },
    available(_ctx: AgentToolContext) {
      return isConfigured(cfg);
    },
    async execute(rawArgs, _ctx: AgentToolContext) {
      const args = rawArgs as {
        query?: string;
        count?: number;
        language?: string;
        freshness?: SearchOpts["freshness"];
        provider?: ProviderName;
      };
      const query =
        typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        return { ok: false, text: "query is required" };
      }
      if (query.length > 300) {
        return {
          ok: false,
          text: "query too long (max 300 chars). Trim or split into separate searches.",
        };
      }

      const fullOrder = providerOrder(cfg, args.provider);
      if (fullOrder.length === 0) {
        return {
          ok: false,
          text:
            "web_search is not configured. Open Settings → Plugins → Web " +
            "Search and pick a scheme: \"hosted\" (key-free, Exa/Parallel), " +
            "\"searxng\" (set your instance URL), or \"tavily\"/\"brave\" " +
            "(set an API key).",
        };
      }
      // Apply health cache: skip providers we already know are
      // dead (bad key). The agent gets to see the cached reason
      // in the error trail, so a stale cache shows up loudly.
      const skipped: Array<{
        provider: ProviderName;
        status: number;
        message: string;
      }> = [];
      const order = fullOrder.filter(({ provider }) => {
        const dead = health.isDead(provider.name);
        if (dead) {
          skipped.push({
            provider: provider.name,
            status: dead.status,
            message: `cached as dead since ${new Date(dead.deadSince).toISOString()}: ${dead.message}`,
          });
          return false;
        }
        return true;
      });
      if (order.length === 0) {
        return {
          ok: false,
          text:
            `web_search: every configured provider is in the dead-cache. ` +
            `Update the bad key(s) and click "Reset health cache" in ` +
            `Settings → Plugins → Web Search, or PATCH ` +
            `/api/p/web-search/health/reset.\n\nDead providers:\n` +
            skipped
              .map(
                (s) => `- ${s.provider} (status ${s.status}): ${s.message}`,
              )
              .join("\n"),
          data: { skipped },
        };
      }

      const opts: SearchOpts = {
        count: typeof args.count === "number" ? args.count : 5,
        language: args.language,
        freshness: args.freshness,
        timeoutMs: cfg.timeoutMs ?? 8000,
      };

      const errors: Array<{
        provider: string;
        status: number;
        message: string;
      }> = [...skipped];
      for (const { provider, key } of order) {
        const out = await provider.search(query, key, opts);
        if ("results" in out) {
          if (out.results.length === 0 && order.length > 1) {
            // Empty isn't an error per se, but if we have a fallback
            // it's worth one more shot — small queries sometimes
            // return nothing on Brave but plenty on Tavily.
            errors.push({
              provider: provider.name,
              status: 200,
              message: "zero results",
            });
            continue;
          }
          return formatSuccess(provider.name, query, out.results, errors);
        }
        const e = out.error;
        errors.push(e);
        // Auth errors: park the provider in the health cache so
        // future calls skip it without paying the round-trip.
        // Only auth gets cached — 5xx / network / 429 are usually
        // transient and would bake a bad cache entry.
        if (e.status === 401 || e.status === 403) {
          health.markDead(provider.name, e.status, e.message);
          // Don't fall back on auth errors — the operator needs to
          // fix the key. (Falling back to a probably-also-broken
          // sibling key just papers over the real problem.)
          break;
        }
      }

      return {
        ok: false,
        text: formatFailure(query, errors),
        data: { query, errors },
      };
    },
  };
}

/** Read raw `pluginConfig` (an opaque Record) into the typed
 *  shape this plugin actually uses. Plugin's `activate()` calls
 *  this once at startup. */
export function readWebSearchConfig(raw: unknown): WebSearchPluginConfig {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof r[k] === "string" && r[k] ? (r[k] as string) : undefined;
  const scheme: SearchScheme | undefined =
    r.scheme === "hosted" ||
    r.scheme === "searxng" ||
    r.scheme === "tavily" ||
    r.scheme === "brave"
      ? r.scheme
      : undefined;
  return {
    scheme,
    hostedBackend:
      r.hostedBackend === "parallel" || r.hostedBackend === "exa"
        ? r.hostedBackend
        : undefined,
    exaApiKey: str("exaApiKey"),
    parallelApiKey: str("parallelApiKey"),
    searxngBaseUrl: str("searxngBaseUrl"),
    tavilyApiKey: str("tavilyApiKey"),
    braveApiKey: str("braveApiKey"),
    timeoutMs:
      typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs)
        ? r.timeoutMs
        : undefined,
  };
}

/** Resolve the effective scheme. Explicit `scheme` wins; otherwise
 *  infer from what's configured, preferring the key-free hosted
 *  scheme so a fresh install works out of the box. */
export function effectiveScheme(cfg: WebSearchPluginConfig): SearchScheme {
  if (cfg.scheme) return cfg.scheme;
  if (cfg.searxngBaseUrl) return "searxng";
  if (cfg.tavilyApiKey) return "tavily";
  if (cfg.braveApiKey) return "brave";
  return "hosted"; // key-free default
}

/** True when the effective scheme has everything it needs to run. */
export function isConfigured(cfg: WebSearchPluginConfig): boolean {
  switch (effectiveScheme(cfg)) {
    case "hosted":
      return true; // key-free
    case "searxng":
      return Boolean(cfg.searxngBaseUrl);
    case "tavily":
      return Boolean(cfg.tavilyApiKey);
    case "brave":
      return Boolean(cfg.braveApiKey);
  }
}

/** Pack the hosted provider's opaque `key` blob (backend + optional
 *  api key). See hostedProvider in providers.ts. */
function hostedKey(cfg: WebSearchPluginConfig): string {
  const backend = cfg.hostedBackend ?? "exa";
  const apiKey = backend === "parallel" ? cfg.parallelApiKey : cfg.exaApiKey;
  return JSON.stringify({ backend, apiKey });
}

/** Decide which providers to try, in order. Returns at most two
 *  entries (the configured pair, preferred first). */
function providerOrder(
  cfg: WebSearchPluginConfig,
  override: ProviderName | undefined,
): Array<{ provider: SearchProvider; key: string }> {
  // Build the entry for a single scheme, or null when that scheme
  // isn't usable (missing credential).
  const entryFor = (
    scheme: SearchScheme,
  ): { provider: SearchProvider; key: string } | null => {
    switch (scheme) {
      case "hosted":
        return { provider: hostedProvider, key: hostedKey(cfg) };
      case "searxng":
        return cfg.searxngBaseUrl
          ? { provider: searxngProvider, key: cfg.searxngBaseUrl }
          : null;
      case "tavily":
        return cfg.tavilyApiKey
          ? { provider: tavilyProvider, key: cfg.tavilyApiKey }
          : null;
      case "brave":
        return cfg.braveApiKey
          ? { provider: braveProvider, key: cfg.braveApiKey }
          : null;
    }
  };

  // Explicit per-call override: honour it if usable, else fall
  // through to the configured scheme.
  if (override) {
    const e = entryFor(override);
    if (e) return [e];
  }

  // No cross-scheme fallback: the operator picked a scheme, we use
  // it. (Mixing a self-hosted SearXNG with a paid Tavily fallback
  // would be surprising.) Return the single effective scheme.
  const e = entryFor(effectiveScheme(cfg));
  return e ? [e] : [];
}

function formatSuccess(
  provider: string,
  query: string,
  results: SearchResult[],
  priorErrors: Array<{ provider: string; message: string }>,
) {
  const head =
    priorErrors.length === 0
      ? `${results.length} result${results.length === 1 ? "" : "s"} from ${provider} for "${query}":`
      : `${results.length} result${results.length === 1 ? "" : "s"} from ${provider} (after ${priorErrors.length} fallback attempt${priorErrors.length === 1 ? "" : "s"}) for "${query}":`;
  const lines = results.map((r, i) => {
    const date = r.publishedDate ? ` (${r.publishedDate})` : "";
    const snippet = (r.content ?? "").trim().slice(0, 280);
    return `${i + 1}. ${r.title}\n   ${r.url}${date}\n   ${snippet}`;
  });
  return {
    ok: true,
    text: [head, "", ...lines].join("\n"),
    data: { query, provider, results },
  };
}

function formatFailure(
  query: string,
  errors: Array<{ provider: string; status: number; message: string }>,
) {
  const lines = errors.map(
    (e) => `- ${e.provider} (status ${e.status}): ${e.message}`,
  );
  return [
    `web_search failed for "${query}". Provider attempts:`,
    ...lines,
    "",
    "If this is a config problem (status 401 / 403), update the key " +
      "in tenant config under `plugins.web-search.config`. If it's a " +
      "transient network error, retry the query.",
  ].join("\n");
}
