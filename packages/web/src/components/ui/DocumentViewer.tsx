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
import { PdfPreview } from "./PdfPreview.js";
import { AudioPreview, VideoPreview } from "./MediaPreview.js";

const MARKDOWN_EXTS = new Set(["md", "markdown"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "ogv", "mov", "m4v", "mkv"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"]);

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
  rawUrl,
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
  const isImage =
    (mimeType && mimeType.startsWith("image/")) || IMAGE_EXTS.has(ext);
  const isPdf = ext === "pdf" || mimeType === "application/pdf";
  const isVideo =
    (mimeType && mimeType.startsWith("video/")) || VIDEO_EXTS.has(ext);
  const isAudio =
    (mimeType && mimeType.startsWith("audio/")) || AUDIO_EXTS.has(ext);

  // Binary surfaces that we KNOW how to render (image / pdf /
  // video / audio) all need a `rawUrl` to stream bytes from —
  // the host's read endpoint returns text content and a `binary`
  // marker, but the bytes themselves come from a separate stream
  // route (typically /api/p/files/raw). If the caller didn't
  // pass rawUrl we degrade to the binary placeholder rather than
  // a broken <img>/<iframe>/<video>.
  if ((isImage || isPdf || isVideo || isAudio) && rawUrl) {
    if (isImage) {
      return (
        <div
          className={`flex min-h-0 flex-1 items-center justify-center bg-gray-950 ${className}`}
        >
          <img
            src={rawUrl}
            alt={filename ?? "image"}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      );
    }
    if (isPdf) {
      return <PdfPreview src={rawUrl} title={filename} className={className} />;
    }
    if (isVideo) {
      return <VideoPreview src={rawUrl} className={className} />;
    }
    if (isAudio) {
      return <AudioPreview src={rawUrl} className={className} />;
    }
  }

  if (binary && !isImage) {
    return (
      <div className={`p-6 text-center text-sm text-gray-500 ${className}`}>
        Binary file{sizeBytes != null ? ` (${formatSize(sizeBytes)})` : ""}. No
        preview available.
      </div>
    );
  }

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
