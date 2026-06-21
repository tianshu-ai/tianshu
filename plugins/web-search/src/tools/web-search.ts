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
  tavilyProvider,
  type SearchOpts,
  type SearchResult,
  type SearchProvider,
} from "./providers.js";
import { ProviderHealth, type ProviderName } from "./health.js";

export interface WebSearchPluginConfig {
  tavilyApiKey?: string;
  braveApiKey?: string;
  preferredProvider?: "tavily" | "brave";
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
          Type.Union([Type.Literal("tavily"), Type.Literal("brave")], {
            description:
              "Force a specific provider. Default uses the host's preferred provider with automatic fallback.",
          }),
        ),
      }),
    },
    available(_ctx: AgentToolContext) {
      return Boolean(cfg.tavilyApiKey ?? cfg.braveApiKey);
    },
    async execute(rawArgs, _ctx: AgentToolContext) {
      const args = rawArgs as {
        query?: string;
        count?: number;
        language?: string;
        freshness?: SearchOpts["freshness"];
        provider?: "tavily" | "brave";
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
            "web_search has no API keys configured. Open Settings → Plugins → Web Search and add a Tavily or Brave API key.",
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
  return {
    tavilyApiKey:
      typeof r.tavilyApiKey === "string" && r.tavilyApiKey
        ? r.tavilyApiKey
        : undefined,
    braveApiKey:
      typeof r.braveApiKey === "string" && r.braveApiKey
        ? r.braveApiKey
        : undefined,
    preferredProvider:
      r.preferredProvider === "tavily" || r.preferredProvider === "brave"
        ? r.preferredProvider
        : undefined,
    timeoutMs:
      typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs)
        ? r.timeoutMs
        : undefined,
  };
}

/** Decide which providers to try, in order. Returns at most two
 *  entries (the configured pair, preferred first). */
function providerOrder(
  cfg: WebSearchPluginConfig,
  override: "tavily" | "brave" | undefined,
): Array<{ provider: SearchProvider; key: string }> {
  const haveTavily = !!cfg.tavilyApiKey;
  const haveBrave = !!cfg.braveApiKey;
  if (override) {
    if (override === "tavily" && haveTavily) {
      return [{ provider: tavilyProvider, key: cfg.tavilyApiKey! }];
    }
    if (override === "brave" && haveBrave) {
      return [{ provider: braveProvider, key: cfg.braveApiKey! }];
    }
    // Override asked for a provider with no key configured; skip
    // it and fall through to the default ordering rather than
    // returning [], so the agent still gets results.
  }
  const preferTavily = (cfg.preferredProvider ?? "tavily") === "tavily";
  const order: Array<{ provider: SearchProvider; key: string }> = [];
  if (preferTavily) {
    if (haveTavily)
      order.push({ provider: tavilyProvider, key: cfg.tavilyApiKey! });
    if (haveBrave)
      order.push({ provider: braveProvider, key: cfg.braveApiKey! });
  } else {
    if (haveBrave)
      order.push({ provider: braveProvider, key: cfg.braveApiKey! });
    if (haveTavily)
      order.push({ provider: tavilyProvider, key: cfg.tavilyApiKey! });
  }
  return order;
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
