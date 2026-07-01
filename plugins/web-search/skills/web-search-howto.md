---
name: web-search-howto
description: How to use `web_search` and `web_fetch` for tasks that need fresh information from the open web — current events, recent docs, prices, release notes, anything not in your training set or in the user's local files.
scope: worker
---

# Web search & fetch

This plugin gives you two tools:

- **`web_search`** — returns a JSON array of `{title, url,
  content, publishedDate}` results. The host picks the backend
  scheme (you don't): key-free hosted MCP (Exa/Parallel),
  a self-hosted SearXNG instance, or Tavily/Brave. Same result
  shape regardless.
- **`web_fetch`** — fetches ONE URL and returns its readable
  body as markdown or text. No API key, no JavaScript. Use it
  to read a page you got from a search result.

## web_search

## Basic call

```
web_search({ query: "anthropic claude 4.7 release notes" })
```

Returns up to 5 results. Read titles + snippets first, only
fetch the URL with `read_file`-style web fetchers when the
snippet is insufficient.

## Tuning

- `count` (1-20, default 5): more results when you're sweeping
  ("recent papers on retrieval-augmented generation"); fewer
  when you know there's a canonical source ("python 3.13
  release date").
- `freshness`: `"day" | "week" | "month" | "year"`. Use this
  for "what happened this week / this month" — without it,
  search ranks by relevance over the whole web, which buries
  recent news under older authoritative pages.
- `language`: ISO 639-1 or locale, e.g. `"zh-CN"`, `"en"`.
  Biases engines toward language-specific sources. Skip this
  for technical English-language queries; technical content is
  usually English regardless of locale.
- `provider`: force `"hosted"`, `"searxng"`, `"tavily"`, or
  `"brave"` if you want a specific backend. Default is the
  scheme the host configured. Usually leave it unset.

## Anti-patterns

- **Don't loop tiny searches.** Five searches with one keyword
  each is worse than one search with the keywords combined.
  `web_search({query: "claude 4.7 anthropic 2026 benchmark"})`
  beats five separate searches.
- **Don't ask `web_search` to summarise.** It doesn't. Read the
  snippets, fetch the page if you need the full text, then
  summarise yourself.
- **Don't dump all results into the final answer.** Pick the
  one or two most authoritative URLs, quote the relevant line,
  cite. Agents who paste 10 result blocks turn answers into
  noise.

## web_fetch — reading a page

`web_search` `content` is only 1-3 sentences. For the actual
page body, call `web_fetch`:

```
web_fetch({ url: "https://example.com/article" })
```

- `extractMode`: `"markdown"` (default) or `"text"`.
- `maxChars`: truncate the output (default 20000).

`web_fetch` does a plain HTTP GET and extracts readable
content — it does **not** run JavaScript. For JS-heavy or
login-gated pages, use the browser tools instead. It blocks
private/internal hosts, so you can't fetch `localhost` or
cloud metadata endpoints.

Fetch only the URLs you actually need — one or two authoritative
pages beats fetching every result.

## Citing sources

When you use a result in a final answer, cite it with the
title and URL. The agent who reads your output (the user, or
the next worker in the chain) shouldn't have to retrieve it
themselves to verify your claim.
