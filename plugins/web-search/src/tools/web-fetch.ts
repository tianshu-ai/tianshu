// `web_fetch(url, extractMode?, maxChars?)`.
//
// A plain HTTP GET that extracts readable content and returns it
// as markdown or text. No JavaScript execution, no API key, no
// external service — this is the "grab a single page" capability
// that pairs with web_search. For JS-heavy or login-gated pages
// the agent should use the browser tool instead.
//
// Dependency-free on purpose: the plugin ships without turndown /
// readability so it stays a tiny self-contained builtin. The
// extractor below is a pragmatic tag-stripper, not a full DOM
// parser — good enough for article bodies, docs, and JSON/text
// endpoints.
//
// SSRF: we block private / loopback / link-local / metadata hosts
// before fetching AND re-check after redirects, so an agent can't
// be steered into probing the internal network.

import { Type } from "typebox";
import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";

export interface WebFetchConfig {
  /** Per-request timeout (ms). Falls back to 8000. */
  timeoutMs?: number;
  /** Hard cap on returned characters. Falls back to 20000. */
  maxCharsDefault?: number;
}

export function buildWebFetchTool(cfg: WebFetchConfig): AgentTool {
  const timeoutMs = cfg.timeoutMs ?? 8000;
  const maxCharsDefault = cfg.maxCharsDefault ?? 20000;
  return {
    schema: {
      name: "web_fetch",
      description:
        "Fetch a single URL over HTTP(S) and return its readable " +
        "content as markdown or text. No JavaScript is executed, so " +
        "for JS-heavy or login-gated pages use the browser tool " +
        "instead. Blocks private/internal hosts. Use this to read a " +
        "specific page you already have the URL for (e.g. a search " +
        "result). Returns extracted body text, not raw HTML.",
      parameters: Type.Object({
        url: Type.String({
          description: "The http(s) URL to fetch.",
        }),
        extractMode: Type.Optional(
          Type.Union([Type.Literal("markdown"), Type.Literal("text")], {
            description:
              "Output format after content extraction. Default \"markdown\".",
          }),
        ),
        maxChars: Type.Optional(
          Type.Number({
            description:
              "Truncate output to this many characters. Default 20000.",
            minimum: 100,
            maximum: 200000,
          }),
        ),
      }),
    },
    async execute(rawArgs, _ctx: AgentToolContext) {
      const args = rawArgs as {
        url?: string;
        extractMode?: "markdown" | "text";
        maxChars?: number;
      };
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) return { ok: false, text: "url is required" };
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, text: "url must start with http:// or https://" };
      }
      const guard = await blockedHost(url);
      if (guard) {
        return { ok: false, text: `blocked: ${guard}` };
      }

      const cap =
        typeof args.maxChars === "number" ? args.maxChars : maxCharsDefault;
      const mode = args.extractMode === "text" ? "text" : "markdown";

      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        const res = await fetch(url, {
          redirect: "manual",
          headers: {
            // Chrome-like UA + language so sites don't serve a
            // bot-blocked or empty variant.
            "user-agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "accept-language": "en,zh-CN;q=0.8",
            accept:
              "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          },
          signal: ctl.signal,
        }).finally(() => clearTimeout(timer));

        // Follow one redirect manually so we can re-run the SSRF
        // guard on the target (auto-follow would skip the check).
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          if (!loc) {
            return { ok: false, text: `redirect with no Location (${res.status})` };
          }
          const next = new URL(loc, url).toString();
          const g2 = await blockedHost(next);
          if (g2) return { ok: false, text: `blocked after redirect: ${g2}` };
          return await this.execute(
            { url: next, extractMode: mode, maxChars: cap },
            _ctx,
          );
        }

        if (!res.ok) {
          return {
            ok: false,
            text: `HTTP ${res.status} fetching ${url}`,
          };
        }

        const ctype = res.headers.get("content-type") ?? "";
        const body = await res.text();

        let out: string;
        if (ctype.includes("application/json")) {
          out = body;
        } else if (ctype.includes("text/html") || /<html[\s>]/i.test(body)) {
          out = mode === "text" ? htmlToText(body) : htmlToMarkdown(body);
        } else {
          // Plain text, markdown, csv, etc. — return as-is.
          out = body;
        }

        const truncated = out.length > cap;
        const text = truncated ? out.slice(0, cap) : out;
        return {
          ok: true,
          text,
          data: {
            url,
            contentType: ctype,
            chars: text.length,
            truncated,
          },
        };
      } catch (err) {
        return {
          ok: false,
          text: `fetch failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    },
  };
}

// ─── SSRF guard ────────────────────────────────────────────────

/** Returns a reason string when the URL's host is disallowed, or
 *  null when it's safe to fetch. Blocks loopback, private, CGN,
 *  link-local, ULA, and cloud metadata addresses by literal match;
 *  we don't resolve DNS here (the host's guarded fetch layer does
 *  deeper checks), this is a cheap first line of defence. */
async function blockedHost(rawUrl: string): Promise<string | null> {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "invalid URL";
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    return "localhost is not allowed";
  }
  // IPv6 literal in brackets is stripped by URL().hostname already.
  if (host === "::1" || host === "0.0.0.0") return "loopback is not allowed";
  // Cloud metadata.
  if (host === "169.254.169.254" || host === "metadata.google.internal") {
    return "metadata endpoint is not allowed";
  }
  // IPv4 literal → range check.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return "loopback range is not allowed";
    if (a === 10) return "private range 10/8 is not allowed";
    if (a === 172 && b >= 16 && b <= 31)
      return "private range 172.16/12 is not allowed";
    if (a === 192 && b === 168) return "private range 192.168/16 is not allowed";
    if (a === 169 && b === 254) return "link-local range is not allowed";
    if (a === 100 && b >= 64 && b <= 127)
      return "carrier-grade NAT range is not allowed";
    if (a === 0) return "reserved range is not allowed";
  }
  // IPv6 private / link-local literals.
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return "IPv6 private/link-local range is not allowed";
  }
  return null;
}

// ─── HTML extraction (dependency-free) ─────────────────────────

/** Strip an HTML document down to its main textual content and
 *  convert the structural tags we care about to markdown. This is
 *  deliberately simple: remove noise elements, unwrap the rest,
 *  map headings/links/lists/code to markdown, collapse whitespace. */
function htmlToMarkdown(html: string): string {
  let s = stripNoise(html);

  // Headings.
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, inner) => {
    const hashes = "#".repeat(Number(lvl));
    return `\n\n${hashes} ${collapse(stripTags(inner))}\n\n`;
  });
  // Links → [text](href).
  s = s.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, inner) => {
      const text = collapse(stripTags(inner));
      return text ? `[${text}](${href})` : href;
    },
  );
  // Bold / strong, italic / em.
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, i) => `**${collapse(stripTags(i))}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, i) => `*${collapse(stripTags(i))}*`);
  // Inline code + code blocks.
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => `\n\n\`\`\`\n${decode(stripTags(inner))}\n\`\`\`\n\n`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) => `\`${collapse(stripTags(inner))}\``);
  // List items.
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => `\n- ${collapse(stripTags(inner))}`);
  // Paragraphs / breaks / block boundaries.
  s = s.replace(/<\/(p|div|section|article|ul|ol|table|tr|h[1-6])>/gi, "\n\n");
  s = s.replace(/<br\s*\/?>(\s*)/gi, "\n");

  // Everything else: drop tags, decode entities, tidy whitespace.
  s = stripTags(s);
  s = decode(s);
  return tidy(s);
}

function htmlToText(html: string): string {
  const s = decode(stripTags(stripNoise(html)));
  return tidy(s);
}

/** Remove script/style/nav/header/footer/svg/noscript blocks and
 *  HTML comments outright — they're noise for text extraction. */
function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

/** Decode the handful of HTML entities that actually show up in
 *  body text. Numeric entities handled generically. */
function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    });
}

/** Collapse internal whitespace in an inline fragment. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Final document tidy: trim lines, collapse >2 blank lines. */
function tidy(s: string): string {
  return s
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, (m) => m))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
