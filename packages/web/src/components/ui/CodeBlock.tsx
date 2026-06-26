// CodeBlock — syntax-highlighted source viewer.
//
// Used by DocumentViewer when the filename's extension matches a
// recognised programming-language list. Falls back to a plain
// <pre> for unknown extensions; the host caller doesn't have to
// know which is which.
//
// Highlighting engine: shiki/bundle/web. Lazy-imported on first
// use so the initial bundle stays small (the shiki dist + every
// language grammar would otherwise be pulled in on every page
// load, even ones that never open a file).
//
// Theme: we use shiki's CSS-variables mode (`theme: "css-variables"`)
// rather than hardcoding `github-dark`. shiki emits class names
// like `.shiki .pl-c` and we map them to CSS variables under
// `--shiki-*` in index.css. Switching to a future light theme is
// then a one-line CSS variable swap, not a re-render of every
// CodeBlock.
//
// Layout: line numbers in a narrow left gutter (Tailwind `text-fg-fainter`
// monospace), copy button hovers in the top-right and slides in on
// row hover. Overflow handled by the wrapper's `overflow-auto`.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useThemeStore } from "../../stores/theme-store";

// shiki's web bundle entry. Types live here too. Lazy via dynamic
// import so the parse-tables (~hundreds of KB total across all
// langs) stay out of the initial bundle.
type HighlighterCore = {
  codeToHtml(code: string, options: {
    lang: string;
    theme: string;
  }): string;
  loadLanguage(lang: string): Promise<void>;
  getLoadedLanguages(): string[];
};

// Single shared highlighter instance. Created on first call, then
// reused across every CodeBlock render. Theme list is fixed to
// `css-variables` so output classes match the rules in index.css.
let highlighterPromise: Promise<HighlighterCore> | null = null;

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const { createHighlighter } = await import("shiki/bundle/web");
      const hi = await createHighlighter({
        // Load both light + dark up front so toggling the user
        // theme doesn't await another wasm round trip. The total
        // theme weight is tiny next to the per-language grammars.
        themes: ["github-dark", "github-light"],
        langs: ["plaintext"],
      });
      return hi as unknown as HighlighterCore;
    })();
  }
  return highlighterPromise;
}

// Map file extension → shiki language id. We only list mappings
// that diverge from the bare extension; everything else just
// passes through (e.g. `.ts` → `ts`, which shiki accepts as a
// language id directly).
const EXT_TO_LANG: Record<string, string> = {
  // shells
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  // C family
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  // JVM / .NET friends
  kt: "kotlin",
  // markup
  yml: "yaml",
  htm: "html",
  // config
  conf: "ini",
  // dockerfile (extension-less in practice; handled in resolve())
};

const SUPPORTED_EXTS = new Set<string>([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "php", "go", "rs", "java", "kt", "swift", "scala",
  "c", "cpp", "cc", "cxx", "h", "hpp", "cs", "m", "mm",
  "sh", "bash", "zsh", "fish", "ps1",
  "json", "yaml", "yml", "toml", "ini", "conf", "xml",
  "css", "scss", "sass", "less", "html", "htm",
  "sql", "graphql", "proto",
  "lua", "perl", "pl",
  "dockerfile", "makefile",
]);

/** Returns the shiki language id for a filename, or null if we
 *  don't recognise it. Caller falls back to <pre>. */
export function resolveCodeLang(filename: string): string | null {
  const lower = filename.toLowerCase();
  // Special-case extension-less filenames.
  if (lower === "dockerfile" || lower.endsWith("/dockerfile")) return "docker";
  if (lower === "makefile" || lower.endsWith("/makefile")) return "makefile";

  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = lower.slice(dot + 1);
  if (!SUPPORTED_EXTS.has(ext)) return null;
  return EXT_TO_LANG[ext] ?? ext;
}

export interface CodeBlockProps {
  code: string;
  /** shiki language id (resolved via `resolveCodeLang(filename)`
   *  or supplied explicitly by the caller). */
  lang: string;
  /** Optional className passed through to the wrapper. */
  className?: string;
}

export function CodeBlock({ code, lang, className = "" }: CodeBlockProps) {
  // We render with two fallback steps:
  //   1. plain <pre> while highlighter (and language grammar)
  //      are loading. Looks like the old experience; only the
  //      gutter and copy button hint that something fancier is
  //      coming.
  //   2. raw highlighted HTML once shiki resolves.
  // This avoids a flash-of-blank-content on slow networks and
  // means the viewer is usable even if shiki fails to load (the
  // try/catch below logs and stays on the <pre>).
  const [html, setHtml] = useState<string | null>(null);
  const cancelRef = useRef(false);
  // Subscribe to the resolved theme so a light/dark flip
  // re-runs codeToHtml against the matching shiki theme. The
  // user sees highlight colors track the chrome instantly
  // without reload.
  const themeName = useThemeStore((s) =>
    s.resolved === "light" ? "github-light" : "github-dark",
  );

  useEffect(() => {
    cancelRef.current = false;
    (async () => {
      try {
        const hi = await getHighlighter();
        if (!hi.getLoadedLanguages().includes(lang)) {
          await hi.loadLanguage(lang);
        }
        const rendered = hi.codeToHtml(code, {
          lang,
          theme: themeName,
        });
        if (!cancelRef.current) setHtml(rendered);
      } catch (err) {
        console.warn(
          `[CodeBlock] highlight failed (${lang}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    })();
    return () => {
      cancelRef.current = true;
    };
  }, [code, lang, themeName]);

  // Pre-compute line count for the gutter. We do this against the
  // RAW code, not the highlighted HTML, because they share the
  // same number of \n-separated lines.
  const lineCount = useMemo(() => {
    if (code.length === 0) return 1;
    // The highlighter may strip a trailing newline; count what's
    // actually in the source and clamp to at least 1.
    const lines = code.split("\n").length;
    return Math.max(1, code.endsWith("\n") ? lines - 1 : lines);
  }, [code]);

  return (
    <div className={`group relative ${className}`}>
      <CopyButton text={code} />
      {/* Two-column layout: gutter on the left, code body on the
          right. Both columns MUST use identical font-size +
          line-height (12px / 1.6) so line numbers stay aligned
          with their corresponding source line. Previously the
          gutter used 11px which slowly drifted out of sync — by
          line 50 the gutter was ≈80px short, so the last 3–4
          lines of a long file had no line number. */}
      <div className="flex">
        {/* Gutter: line numbers in monospace dim grey. */}
        <pre
          aria-hidden
          className="select-none border-r border-border-subtle bg-bg-base px-3 py-3 text-right font-mono text-[12px] leading-[1.6] text-fg-fainter"
        >
          {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
        </pre>
        {/* Body: either the highlighted HTML or a plain <pre>
            while shiki resolves. We do NOT add our own padding
            here because shiki's <pre> output already carries one
            via `theme.colors.bg` styling — a wrapper `p-3` would
            double-pad and push the first source line ~12px down
            relative to line number "1" in the gutter. Instead we
            wrap shiki's output in a container that resets its
            built-in padding so both columns share the same baseline. */}
        <div className="min-w-0 flex-1 overflow-auto">
          {html ? (
            // shiki output is sanitized (only span/pre/code with
            // class attrs). It can be dangerously set. The
            // `code` content is from the file, never from a user
            // network input.
            // shiki injects `padding: 1rem` (and a background
            // color) directly onto its outer <pre>. We override
            // that via a CSS rule on `.shiki-host > pre` in
            // index.css so the body's first source line aligns
            // with the gutter's "1".
            <div
              className="shiki-host font-mono text-[12px] leading-[1.6]"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <pre className="whitespace-pre px-3 py-3 font-mono text-[12px] leading-[1.6] text-fg-default">
              {code}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="absolute right-2 top-2 z-10 rounded-md border border-border-subtle/80 bg-bg-elevated/80 p-1.5 text-fg-muted opacity-0 backdrop-blur transition-opacity hover:bg-bg-raised group-hover:opacity-100"
      title={copied ? "Copied" : "Copy"}
      onClick={() => {
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => {
            // best-effort; clipboard write can be denied
          });
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}
