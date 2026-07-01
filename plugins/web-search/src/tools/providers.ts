// Two adapters with the same shape so the surrounding tool can
// fall back from one to the other without branching on provider
// names. Both providers serve a JSON API; the only async is one
// fetch + json parse per call.
//
// Why the contract is `(query, opts) => SearchResult[]` and not
// the provider's native shape:
//   - the agent shouldn't have to know which provider answered
//   - errors are uniform (one place that throws, one error log)
//   - if we add Exa / Serper / a self-hosted SearXNG later it
//     drops in here without touching the tool

export interface SearchResult {
  title: string;
  url: string;
  /** 1-3 sentence snippet. Empty when the provider didn't supply
   *  one (Tavily always supplies, Brave usually does). */
  content: string;
  /** ISO-8601 string from the provider, when available. Useful for
   *  recency filtering downstream; agents reading the JSON should
   *  treat this as best-effort and not parse strictly. */
  publishedDate?: string | null;
}

export interface SearchOpts {
  /** 1-20. Tavily max 20, Brave max 20. The tool clamps. */
  count: number;
  /** Free-text language hint, passed through where the provider
   *  supports it. e.g. `"zh-CN"`, `"en"`. */
  language?: string;
  /** Recency window. Maps to provider-specific values; absence
   *  means "no recency filter". */
  freshness?: "day" | "week" | "month" | "year";
  /** Network timeout per fetch (ms). 8000 is the tool's default. */
  timeoutMs: number;
}

export interface ProviderError {
  provider: string;
  /** http status if the provider responded; 0 for transport errors. */
  status: number;
  message: string;
}

export type ProviderName =
  | "tavily"
  | "brave"
  | "hosted"
  | "searxng";

/** Each provider implements this. `key` is the credential from
 *  `pluginConfig` (an API key for tavily/brave, an endpoint URL
 *  for searxng, or the empty string for the key-free hosted MCP
 *  provider); the surrounding tool decides which provider(s) to
 *  call based on which are configured. */
export interface SearchProvider {
  readonly name: ProviderName;
  search(
    query: string,
    key: string,
    opts: SearchOpts,
  ): Promise<{ results: SearchResult[] } | { error: ProviderError }>;
}

export const tavilyProvider: SearchProvider = {
  name: "tavily",
  async search(query, key, opts) {
    // Tavily's "advanced" mode summarises content; "basic" returns
    // bare snippets. We pick basic — the agent will fetch the page
    // when it needs the body, and basic is faster + cheaper.
    const body: Record<string, unknown> = {
      api_key: key,
      query,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      max_results: clamp(opts.count, 1, 20),
    };
    if (opts.freshness) {
      body.time_range = opts.freshness;
    }
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      }).finally(() => clearTimeout(timer));
      if (!res.ok) {
        return {
          error: {
            provider: "tavily",
            status: res.status,
            message: await safeText(res),
          },
        };
      }
      const json = (await res.json()) as {
        results?: Array<{
          title?: string;
          url?: string;
          content?: string;
          published_date?: string;
        }>;
      };
      const results: SearchResult[] = (json.results ?? []).map((r) => ({
        title: typeof r.title === "string" ? r.title : "",
        url: typeof r.url === "string" ? r.url : "",
        content: typeof r.content === "string" ? r.content : "",
        publishedDate: r.published_date ?? null,
      }));
      return { results };
    } catch (err) {
      return {
        error: {
          provider: "tavily",
          status: 0,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};

export const braveProvider: SearchProvider = {
  name: "brave",
  async search(query, key, opts) {
    // Brave's web search returns up to 20 in `web.results`; news /
    // images live in sibling sections we ignore for now.
    const params = new URLSearchParams({
      q: query,
      count: String(clamp(opts.count, 1, 20)),
      safesearch: "off",
      // Brave understands ISO 639-1 + locale; we only forward the
      // first 5 chars to keep the param valid (`zh-CN` → `zh-CN`,
      // `en` → `en`).
      ...(opts.language ? { search_lang: opts.language.slice(0, 5) } : {}),
      // Recency: Brave uses pd / pw / pm / py.
      ...(opts.freshness
        ? {
            freshness: { day: "pd", week: "pw", month: "pm", year: "py" }[
              opts.freshness
            ],
          }
        : {}),
    });
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
      const res = await fetch(
        `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
        {
          headers: {
            "x-subscription-token": key,
            accept: "application/json",
            "accept-encoding": "gzip",
          },
          signal: ctl.signal,
        },
      ).finally(() => clearTimeout(timer));
      if (!res.ok) {
        return {
          error: {
            provider: "brave",
            status: res.status,
            message: await safeText(res),
          },
        };
      }
      const json = (await res.json()) as {
        web?: {
          results?: Array<{
            title?: string;
            url?: string;
            description?: string;
            page_age?: string;
          }>;
        };
      };
      const results: SearchResult[] = (json.web?.results ?? []).map((r) => ({
        title: typeof r.title === "string" ? r.title : "",
        url: typeof r.url === "string" ? r.url : "",
        content: typeof r.description === "string" ? r.description : "",
        publishedDate: r.page_age ?? null,
      }));
      return { results };
    } catch (err) {
      return {
        error: {
          provider: "brave",
          status: 0,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};

// ─── hosted MCP provider (Parallel / Exa free endpoints) ───────
//
// Key-free web search. Both Parallel and Exa expose a hosted MCP
// endpoint that answers anonymous JSON-RPC `tools/call` requests
// (a free tier). If the operator supplies an EXA/PARALLEL key we
// attach it, but the whole point of this provider is that it
// works with none. Same approach OpenCode uses.
//
// `key` here is NOT an API key — it's a JSON blob the tool packs
// with the chosen backend + optional key:  {"backend":"exa"|
// "parallel", "apiKey":"..."}. The tool builds it; callers never
// see it.

export const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

interface HostedKey {
  backend: "exa" | "parallel";
  apiKey?: string;
}

function parseHostedKey(key: string): HostedKey {
  try {
    const j = JSON.parse(key) as Partial<HostedKey>;
    return {
      backend: j.backend === "parallel" ? "parallel" : "exa",
      apiKey: typeof j.apiKey === "string" && j.apiKey ? j.apiKey : undefined,
    };
  } catch {
    return { backend: "exa" };
  }
}

export const hostedProvider: SearchProvider = {
  name: "hosted",
  async search(query, key, opts) {
    const { backend, apiKey } = parseHostedKey(key);
    const url =
      backend === "parallel"
        ? PARALLEL_MCP_URL
        : apiKey
          ? `${EXA_MCP_URL}?exaApiKey=${encodeURIComponent(apiKey)}`
          : EXA_MCP_URL;

    // MCP tool + args differ per backend.
    const toolName = backend === "parallel" ? "web_search" : "web_search_exa";
    const toolArgs =
      backend === "parallel"
        ? {
            objective: query,
            search_queries: [query],
          }
        : {
            query,
            numResults: clamp(opts.count, 1, 20),
            type: "auto",
          };

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": "tianshu-web-search/0.2",
    };
    if (backend === "parallel" && apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

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
      const results = (
        backend === "exa" ? parseExaText(text) : parseHostedResults(text)
      );
      const final = (
        results.length > 0
          ? results
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
          message: `${backend}: ${err instanceof Error ? err.message : String(err)}`,
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

/** The MCP `text` payload is itself JSON (or JSON-ish) describing
 *  results. Both Exa and Parallel return an array of
 *  `{title,url,text/snippet,publishedDate}`-ish objects, sometimes
 *  wrapped in `{ results: [...] }`. Be liberal. */
function parseHostedResults(text: string): SearchResult[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // Non-JSON payload: hand it back as a single synthetic result
    // so the agent at least sees the content.
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
      publishedDate:
        str("publishedDate", "published_date", "date") || null,
    };
  });
}

/** Parse Exa's plain-text MCP payload into results. Each block is
 *  separated by a line containing only `---`, and carries
 *  `Title:`, `URL:`, `Published:`, and `Highlights:` labels. */
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
    // Highlights are everything after the `Highlights:` label.
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

// ─── SearXNG provider (self-hosted meta-search) ────────────────
//
// `key` is the operator's SearXNG base URL (e.g.
// "http://localhost:8080" or "https://searx.example.com"). We hit
// its JSON API (`/search?format=json`). No API key; the endpoint
// is the credential.

export const searxngProvider: SearchProvider = {
  name: "searxng",
  async search(query, key, opts) {
    const base = key.replace(/\/+$/, "");
    if (!base) {
      return {
        error: {
          provider: "searxng",
          status: 0,
          message: "no SearXNG base URL configured",
        },
      };
    }
    const params = new URLSearchParams({
      q: query,
      format: "json",
      safesearch: "0",
    });
    if (opts.language) params.set("language", opts.language.slice(0, 5));
    if (opts.freshness) {
      // SearXNG time_range accepts day/week/month/year directly.
      params.set("time_range", opts.freshness);
    }
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
      const res = await fetch(`${base}/search?${params.toString()}`, {
        headers: { accept: "application/json" },
        signal: ctl.signal,
      }).finally(() => clearTimeout(timer));
      if (!res.ok) {
        return {
          error: {
            provider: "searxng",
            status: res.status,
            message: await safeText(res),
          },
        };
      }
      const json = (await res.json()) as {
        results?: Array<{
          title?: string;
          url?: string;
          content?: string;
          publishedDate?: string;
        }>;
      };
      const results: SearchResult[] = (json.results ?? [])
        .slice(0, clamp(opts.count, 1, 20))
        .map((r) => ({
          title: typeof r.title === "string" ? r.title : "",
          url: typeof r.url === "string" ? r.url : "",
          content: typeof r.content === "string" ? r.content : "",
          publishedDate: r.publishedDate ?? null,
        }));
      return { results };
    } catch (err) {
      return {
        error: {
          provider: "searxng",
          status: 0,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};

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
