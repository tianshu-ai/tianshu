// `web_search(query, count?, language?, freshness?)`.
//
// One key-free backend: the hosted MCP endpoints. The operator's
// only choice is which one — Exa or Parallel (config `backend`).
// No API keys, no self-hosting, no scheme selection.
//
// Tenant config shape:
//
//   {
//     "plugins": {
//       "web-search": {
//         "config": {
//           "backend": "exa" | "parallel",   // default "exa"
//           "timeoutMs": 8000                 // optional
//         }
//       }
//     }
//   }

import { Type } from "typebox";
import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";
import {
  hostedProvider,
  type HostedBackend,
  type SearchOpts,
  type SearchResult,
} from "./providers.js";
import { ProviderHealth } from "./health.js";

export interface WebSearchPluginConfig {
  /** Which hosted MCP endpoint to query. Default "exa". */
  backend?: HostedBackend;
  /** Optional default timeout override (ms). 8000 if unset. */
  timeoutMs?: number;
}

export function buildWebSearchTool(
  cfg: WebSearchPluginConfig,
  health: ProviderHealth,
): AgentTool {
  const backend: HostedBackend = cfg.backend ?? "exa";
  return {
    schema: {
      name: "web_search",
      description:
        "Search the web for up-to-date information. Returns a JSON " +
        "array of `{ title, url, content, publishedDate }` objects. " +
        "Key-free \u2014 backed by a hosted search endpoint (Exa or " +
        "Parallel, chosen by the host). Use this for current events, " +
        "recent docs, anything that may have changed since training. " +
        "Don't loop many tiny searches \u2014 refine the query and " +
        "increase `count`. Use web_fetch to read a result's full page.",
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
              "Language hint, ISO 639-1 or locale (e.g. \"zh-CN\", \"en\").",
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
                "Recency filter. Default is no filter (ranked by relevance).",
            },
          ),
        ),
      }),
    },
    available(_ctx: AgentToolContext) {
      // Always available — the hosted backend needs no credential.
      return true;
    },
    async execute(rawArgs, _ctx: AgentToolContext) {
      const args = rawArgs as {
        query?: string;
        count?: number;
        language?: string;
        freshness?: SearchOpts["freshness"];
      };
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        return { ok: false, text: "query is required" };
      }
      if (query.length > 300) {
        return {
          ok: false,
          text: "query too long (max 300 chars). Trim or split into separate searches.",
        };
      }

      // Health cache: skip the backend if a prior auth failure
      // parked it (rare for the free endpoints, but the trail is
      // useful if it ever happens).
      const dead = health.isDead("hosted");
      if (dead) {
        return {
          ok: false,
          text:
            `web_search: the hosted backend is in the dead-cache ` +
            `(status ${dead.status}: ${dead.message}). Reset it in ` +
            `Settings \u2192 Plugins \u2192 Web Search or POST ` +
            `/api/p/web-search/health/reset.`,
          data: { dead },
        };
      }

      const opts: SearchOpts = {
        count: typeof args.count === "number" ? args.count : 5,
        language: args.language,
        freshness: args.freshness,
        timeoutMs: cfg.timeoutMs ?? 8000,
      };

      const out = await hostedProvider.search(query, backend, opts);
      if ("results" in out) {
        return formatSuccess(backend, query, out.results);
      }
      const e = out.error;
      if (e.status === 401 || e.status === 403) {
        health.markDead("hosted", e.status, e.message);
      }
      return {
        ok: false,
        text: formatFailure(query, e),
        data: { query, error: e },
      };
    },
  };
}

/** Read raw `pluginConfig` into the typed shape. */
export function readWebSearchConfig(raw: unknown): WebSearchPluginConfig {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  return {
    backend:
      r.backend === "parallel" || r.backend === "exa" ? r.backend : undefined,
    timeoutMs:
      typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs)
        ? r.timeoutMs
        : undefined,
  };
}

function formatSuccess(
  backend: string,
  query: string,
  results: SearchResult[],
) {
  const head = `${results.length} result${
    results.length === 1 ? "" : "s"
  } from ${backend} for "${query}":`;
  const lines = results.map((r, i) => {
    const date = r.publishedDate ? ` (${r.publishedDate})` : "";
    const snippet = (r.content ?? "").trim().slice(0, 280);
    return `${i + 1}. ${r.title}\n   ${r.url}${date}\n   ${snippet}`;
  });
  return {
    ok: true,
    text: [head, "", ...lines].join("\n"),
    data: { query, provider: backend, results },
  };
}

function formatFailure(
  query: string,
  error: { provider: string; status: number; message: string },
) {
  return [
    `web_search failed for "${query}":`,
    `- ${error.provider} (status ${error.status}): ${error.message}`,
    "",
    "The hosted endpoint may be rate-limiting or temporarily down. " +
      "Retry shortly, or switch the backend (Exa \u2194 Parallel) in " +
      "Settings \u2192 Plugins \u2192 Web Search.",
  ].join("\n");
}
