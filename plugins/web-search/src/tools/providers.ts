// Web search backend: hosted MCP only.
//
// The plugin used to ship four schemes (Tavily / Brave / hosted
// MCP / SearXNG). Per Yu it's now just the key-free hosted MCP
// path — you only choose which anonymous endpoint to hit: Exa or
// Parallel. Both expose a hosted MCP endpoint answering anonymous
// JSON-RPC `tools/call` requests on a free tier (the same approach
// OpenCode uses). No API key, no account, no self-hosting.
//
// The `SearchProvider` shape is kept so web_search's plumbing
// (health cache, error trail) doesn't have to special-case a
// single provider; `key` here is just the backend name
// ("exa" | "parallel"), not a credential.

export interface SearchResult {
  title: string;
  url: string;
  /** 1-3 sentence snippet. */
  content: string;
  /** ISO-8601 / free-form date string from the provider when
   *  available; best-effort, agents shouldn't parse strictly. */
  publishedDate?: string | null;
}

export interface SearchOpts {
  /** 1-20. The provider clamps. */
  count: number;
  /** Free-text language hint (unused by the hosted endpoints today,
   *  kept for tool-schema compatibility). */
  language?: string;
  /** Recency window (unused by the hosted endpoints today, kept for
   *  tool-schema compatibility). */
  freshness?: "day" | "week" | "month" | "year";
  /** Network timeout per fetch (ms). */
  timeoutMs: number;
}

export interface ProviderError {
  provider: string;
  /** http status if the provider responded; 0 for transport errors. */
  status: number;
  message: string;
}

/** The only backend name today. Kept as a type so the health cache
 *  and error trail stay generic. */
export type ProviderName = "hosted";

/** Which hosted MCP endpoint to query. */
export type HostedBackend = "exa" | "parallel";

export interface SearchProvider {
  readonly name: ProviderName;
  /** `key` carries the backend name ("exa" | "parallel"). */
  search(
    query: string,
    key: string,
    opts: SearchOpts,
  ): Promise<{ results: SearchResult[] } | { error: ProviderError }>;
}

export const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

function normBackend(key: string): HostedBackend {
  return key === "parallel" ? "parallel" : "exa";
}

export const hostedProvider: SearchProvider = {
  name: "hosted",
  async search(query, key, opts) {
    const backend = normBackend(key);
    const url = backend === "parallel" ? PARALLEL_MCP_URL : EXA_MCP_URL;

    // MCP tool + args differ per backend.
    const toolName = backend === "parallel" ? "web_search" : "web_search_exa";
    const toolArgs =
      backend === "parallel"
        ? { objective: query, search_queries: [query] }
        : { query, numResults: clamp(opts.count, 1, 20), type: "auto" };

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": "tianshu-web-search/0.3",
    };

    const rpc = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: toolArgs },
    };

    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(rpc),
        signal: ctl.signal,
      }).finally(() => clearTimeout(timer));
      if (!res.ok) {
        return {
          error: {
            provider: "hosted",
            status: res.status,
            message: `${backend}: ${await safeText(res)}`,
          },
        };
      }
      const raw = await res.text();
      const text = extractMcpText(raw);
      if (text === null) {
        return {
          error: {
            provider: "hosted",
            status: 0,
            message: `${backend}: could not parse MCP response`,
          },
        };
      }
      // Exa returns a plain-text block (Title:/URL:/Published:/
      // Highlights:, results split by `---`). Parallel returns
      // JSON (array or {results:[...]}). Parse per backend, with a
      // cross-fallback so a format change on either side degrades
      // gracefully instead of returning nothing.
      const primary =
        backend === "exa" ? parseExaText(text) : parseHostedResults(text);
      const final = (
        primary.length > 0
          ? primary
          : backend === "exa"
            ? parseHostedResults(text)
            : parseExaText(text)
      ).slice(0, clamp(opts.count, 1, 20));
      return { results: final };
    } catch (err) {
      return {
        error: {
          provider: "hosted",
          status: 0,
          message: `${backend}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      };
    }
  },
};

/** MCP endpoints answer either as plain JSON or as an SSE stream
 *  (`data: {...}` lines). Pull the inner `result.content[].text`
 *  payload out of whichever we got. Returns null if nothing
 *  usable is found. */
function extractMcpText(body: string): string | null {
  const tryOne = (s: string): string | null => {
    try {
      const j = JSON.parse(s) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const item = j.result?.content?.find((c) => typeof c.text === "string");
      return item?.text ?? null;
    } catch {
      return null;
    }
  };
  const trimmed = body.trim();
  const direct = trimmed ? tryOne(trimmed) : null;
  if (direct !== null) return direct;
  // SSE: scan `data:` lines.
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      const got = tryOne(line.slice(5).trim());
      if (got !== null) return got;
    }
  }
  return null;
}

/** Parallel-style payload: JSON, either an array or `{results:[...]}`. */
function parseHostedResults(text: string): SearchResult[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const t = text.trim();
    return t ? [{ title: "result", url: "", content: t.slice(0, 2000) }] : [];
  }
  const arr: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { results?: unknown[] })?.results)
      ? (data as { results: unknown[] }).results
      : [];
  return arr.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const str = (...keys: string[]): string => {
      for (const k of keys) {
        if (typeof r[k] === "string" && r[k]) return r[k] as string;
      }
      return "";
    };
    return {
      title: str("title", "name"),
      url: str("url", "link"),
      content: str("text", "snippet", "content", "summary").slice(0, 1000),
      publishedDate: str("publishedDate", "published_date", "date") || null,
    };
  });
}

/** Exa's plain-text MCP payload: blocks split by a `---` line, each
 *  carrying `Title:` / `URL:` / `Published:` / `Highlights:`. */
function parseExaText(text: string): SearchResult[] {
  const blocks = text
    .split(/\n\s*---\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const out: SearchResult[] = [];
  for (const block of blocks) {
    const title = block.match(/^\s*Title:\s*(.+)$/im)?.[1]?.trim() ?? "";
    const url = block.match(/^\s*URL:\s*(\S+)/im)?.[1]?.trim() ?? "";
    const published = block.match(/^\s*Published:\s*(.+)$/im)?.[1]?.trim();
    const hi = block.split(/^\s*Highlights:\s*$/im)[1] ?? "";
    const content = hi
      .replace(/\n\.\.\.\n/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1000);
    if (!title && !url) continue;
    out.push({
      title: title || url,
      url,
      content,
      publishedDate: published && published !== "N/A" ? published : null,
    });
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 300);
  } catch {
    return "<failed to read response body>";
  }
}
