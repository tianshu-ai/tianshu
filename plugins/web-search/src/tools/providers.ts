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

/** Each provider implements this. `key` is the API key from
 *  `pluginConfig`; the surrounding tool decides which provider(s)
 *  to call based on which keys are present. */
export interface SearchProvider {
  readonly name: "tavily" | "brave";
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
