// Host-provided <DocumentViewer> primitive.
//
// Dispatches on filename / mime type to the right renderer:
//   - .md / .markdown                 → MarkdownBlock
//   - text/* and source-code-like ext → <pre> (no syntax highlight
//                                      yet; tracked as follow-up)
//   - image/*                          → <img>
//   - binary / unknown                 → "binary file" placeholder
//
// Loading / error / empty states are handled inline so callers
// don't each reimplement them.
//
// The Markdown surface here uses the SAME components + remark
// plugins the chat bubble uses (via lib/markdown-components.tsx),
// so a `.md` file rendered in the files preview looks pixel-
// identical to the same content rendered in chat.
//
// Markdown dispatch policy: ONLY files whose extension is `.md`
// or `.markdown` get the Markdown renderer. Everything else
// (.txt, .json, .py, .ts, …) falls through to plain `<pre>` so a
// stray `# heading` line in source code doesn't get rendered as
// a giant H1. Discussed up-front with Yu; the conservative path
// is the right one.

import { Loader2 } from "lucide-react";
import type { DocumentViewerProps } from "@tianshu-ai/plugin-sdk/client";
import { MarkdownBlock } from "./MarkdownBlock.js";
import { CodeBlock, resolveCodeLang } from "./CodeBlock.js";
import { HtmlPreview } from "./HtmlPreview.js";

const MARKDOWN_EXTS = new Set(["md", "markdown"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);

function extOf(name?: string): string {
  if (!name) return "";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

function formatSize(n?: number): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function DocumentViewer({
  content,
  mimeType,
  filename,
  binary,
  loading,
  error,
  sizeBytes,
  className = "",
}: DocumentViewerProps) {
  if (loading) {
    return (
      <div className={`flex h-32 items-center justify-center ${className}`}>
        <Loader2 size={20} className="animate-spin text-gray-500" />
      </div>
    );
  }
  if (error) {
    return (
      <div className={`p-6 text-center text-sm text-rose-300 ${className}`}>
        {error}
      </div>
    );
  }

  const ext = extOf(filename);
  // Image: caller is expected to set `binary=true` for non-image
  // binaries and supply the image bytes through a URL elsewhere
  // (we don't load images here \u2014 the files plugin renders <img>
  // against its own /raw endpoint). When sniffing detects an image
  // extension but no content is provided, fall through to the
  // binary placeholder.
  const isImage =
    (mimeType && mimeType.startsWith("image/")) || IMAGE_EXTS.has(ext);
  if (binary && !isImage) {
    return (
      <div className={`p-6 text-center text-sm text-gray-500 ${className}`}>
        Binary file{sizeBytes != null ? ` (${formatSize(sizeBytes)})` : ""}. No
        preview available.
      </div>
    );
  }

  // Image: caller passes a data URL or remote URL through
  // `content` (string). We don't have a separate src field today;
  // if you need image support, lift content into a data:image/png
  // URL or render the <img> yourself outside DocumentViewer.
  // (The files plugin will continue to render its own <img>
  // because it has a dedicated /raw route; we don't change that.)

  if (content == null) {
    return (
      <div className={`p-6 text-center text-sm text-gray-500 ${className}`}>
        No content.
      </div>
    );
  }

  // Markdown surface.
  const isMarkdown =
    MARKDOWN_EXTS.has(ext) ||
    mimeType === "text/markdown" ||
    mimeType === "text/x-markdown";
  if (isMarkdown) {
    return (
      <div className={`p-4 ${className}`}>
        <MarkdownBlock>{content}</MarkdownBlock>
      </div>
    );
  }

  // HTML surface: live iframe preview with a source-view toggle.
  // We sniff via extension since the read endpoint already returns
  // text/plain for HTML files.
  const isHtml = ext === "html" || ext === "htm";
  if (isHtml) {
    return (
      <div className={`flex min-h-0 flex-1 flex-col ${className}`}>
        <HtmlPreview html={content} />
      </div>
    );
  }

  // Code surface: shiki-highlighted with line numbers + copy button.
  // resolveCodeLang() returns null for unknown extensions — those
  // fall through to the plain-text branch below so we don't lie
  // about what we can highlight.
  const codeLang = filename ? resolveCodeLang(filename) : null;
  if (codeLang) {
    return (
      <div className={`min-h-0 flex-1 ${className}`}>
        <CodeBlock code={content} lang={codeLang} />
      </div>
    );
  }

  // Plain text fallback: preserve every byte. `whitespace-pre-wrap`
  // wraps lines that would overflow horizontally; `break-all` keeps
  // long URL-ish tokens from blowing out the column. Mono font +
  // tight leading so it reads like source.
  return (
    <pre
      className={`whitespace-pre-wrap break-all p-4 font-mono text-xs text-gray-200 ${className}`}
    >
      {content}
    </pre>
  );
}
