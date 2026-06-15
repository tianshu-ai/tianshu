---
name: web-search-howto
description: How to use the `web_search` tool for tasks that need fresh information from the open web — current events, recent docs, prices, release notes, anything not in your training set or in the user's local files.
scope: worker
---

# Web search

`web_search` returns a JSON array of `{title, url, content,
publishedDate}` objects from Tavily or Brave Search (whichever
the host has an API key for; you don't have to pick).

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
- `provider`: force `"tavily"` or `"brave"` if you want a
  specific source. Default is "host's preferred provider with
  fallback".

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

## When the snippet isn't enough

`content` is 1-3 sentences. For the actual page body, fetch
the URL through whatever HTTP fetcher you have available
(`read_file` on a previously-saved page, the browser tools,
etc.). `web_search` itself does not return page bodies; that's
intentional — fetching only the URLs you actually need keeps
the tool fast and cheap.

## Citing sources

When you use a result in a final answer, cite it with the
title and URL. The agent who reads your output (the user, or
the next worker in the chain) shouldn't have to retrieve it
themselves to verify your claim.
