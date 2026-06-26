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
import { ImagePreview } from "./ImagePreview.js";
import { TablePreview } from "./TablePreview.js";

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
      // SVG is special: pass the raw source through so the
      // preview can offer a View source toggle. For other image
      // types content is null and the preview falls back to a
      // plain <img>.
      const isSvg = ext === "svg" || mimeType === "image/svg+xml";
      return (
        <ImagePreview
          src={rawUrl}
          filename={filename}
          svgSource={isSvg && content ? content : undefined}
          className={className}
        />
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

  // Office surfaces: docx / xlsx / pptx (+ legacy doc/xls/ppt and
  // OpenDocument odt/ods/odp). We don't render these yet — doing it
  // right requires a server-side LibreOffice path, which is its own
  // PR. For now we show a friendly placeholder so users aren't left
  // with a generic "Binary file". The Download button (Modal
  // headerAction) is still right above.
  const OFFICE_EXTS = new Set([
    "doc", "docx", "dot", "dotx",
    "xls", "xlsx", "xlsm", "xlsb",
    "ppt", "pptx", "pps", "ppsx",
    "odt", "ods", "odp", "odg",
    "rtf",
  ]);
  const isOffice = OFFICE_EXTS.has(ext);
  if (isOffice) {
    return (
      <div
        className={`flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center ${className}`}
      >
        <div className="text-sm font-medium text-gray-200">
          Office preview is coming soon
        </div>
        <div className="max-w-md text-[12px] leading-relaxed text-gray-500">
          In-browser rendering for{" "}
          <code className="font-mono text-gray-400">.{ext}</code> files needs a
          server-side LibreOffice pass that hasn't shipped yet. Use the{" "}
          <span className="text-gray-300">Download</span> button above to open
          this file in your local Office / LibreOffice / Pages.
        </div>
        {sizeBytes != null && (
          <div className="text-[11px] text-gray-600">{formatSize(sizeBytes)}</div>
        )}
      </div>
    );
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

  // Tabular surfaces.
  if (ext === "csv" || mimeType === "text/csv") {
    return <TablePreview content={content} delimiter="," className={className} />;
  }
  if (ext === "tsv" || mimeType === "text/tab-separated-values") {
    return <TablePreview content={content} delimiter="\t" className={className} />;
  }

  // Markdown surface. Markdown content can be tall; wrap it in
  // a flex column with overflow-auto so long files scroll inside
  // the modal instead of pushing the modal body past its bound.
  const isMarkdown =
    MARKDOWN_EXTS.has(ext) ||
    mimeType === "text/markdown" ||
    mimeType === "text/x-markdown";
  if (isMarkdown) {
    return (
      <div
        className={`min-h-0 flex-1 overflow-auto p-4 ${className}`}
      >
        <MarkdownBlock>{content}</MarkdownBlock>
      </div>
    );
  }

  // HTML surface: live iframe preview with a source-view toggle.
  // HtmlPreview is already a `flex min-h-0 flex-1 flex-col`, so
  // we pass through `className` and let it own the layout.
  const isHtml = ext === "html" || ext === "htm";
  if (isHtml) {
    return <HtmlPreview html={content} className={className} />;
  }

  // Code surface: shiki-highlighted with line numbers + copy button.
  // Wrap CodeBlock in a flex column with overflow-auto. CodeBlock
  // itself is laid out side-by-side (gutter + body) and doesn't
  // own bounded height; the wrapper provides it.
  const codeLang = filename ? resolveCodeLang(filename) : null;
  if (codeLang) {
    return (
      <div
        className={`min-h-0 flex-1 overflow-auto ${className}`}
      >
        <CodeBlock code={content} lang={codeLang} />
      </div>
    );
  }

  // Plain text fallback: preserve every byte. Same overflow
  // treatment as the other text branches so long files scroll
  // instead of breaking the modal layout.
  return (
    <pre
      className={`min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-xs text-gray-200 ${className}`}
    >
      {content}
    </pre>
  );
}
