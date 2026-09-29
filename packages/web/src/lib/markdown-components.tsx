// Shared Markdown rendering primitives.
//
// Originally hardcoded in MessageBubble.tsx for the chat-bubble
// path. Pulled out so the DocumentViewer (files preview, workboard
// task transcripts, any future plugin) renders Markdown identically
// to the chat surface — same prose typography, same workspace://
// resolution, same lazy-loaded images.
//
// Two exports:
//   - urlTransform: rewrites workspace:// URIs to their HTTP raw
//     route so links and inline images Just Work. Symmetric for
//     `[text](workspace:///foo)` and `![alt](workspace:///foo)`.
//   - MARKDOWN_COMPONENTS: the components map passed to
//     <ReactMarkdown components={...} />. Today it only customises
//     <img> (lazy load + max-height + rounded border); add new
//     element overrides here so every Markdown surface stays in
//     sync.

import { useState, type ComponentProps, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { rewriteWorkspaceUri } from "./workspace-uri.js";
import { ImageLightbox } from "../components/ui/ImageLightbox";

/** URL transform applied to both `[text](url)` and `![alt](src)`.
 *  Behaviour is intentionally symmetric: a `workspace://` link in
 *  prose resolves to the raw file route just like an inline image
 *  would. The actual rewrite lives in lib/workspace-uri.ts so it
 *  can be unit-tested without React. */
export function urlTransform(url: string): string {
  if (!url) return url;
  return rewriteWorkspaceUri(url);
}

function MarkdownImg(props: ComponentProps<"img">) {
  const { src, alt, ...rest } = props;
  const [open, setOpen] = useState(false);
  return (
    <>
      <img
        src={src}
        alt={alt ?? ""}
        loading="lazy"
        onClick={() => src && setOpen(true)}
        className="my-2 max-h-96 max-w-full cursor-zoom-in rounded-lg border border-border-default/50"
        {...rest}
      />
      {src && (
        <ImageLightbox
          src={src}
          alt={alt}
          isOpen={open}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// ─── Code block copy button ─────────────────────────────────────
// Fenced code blocks (```` ```lang ... ``` ````) render as <pre><code>.
// We wrap <pre> to add a hover copy button (top-right), matching
// the style of CodeBlock.tsx's CopyButton.

function CodeCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="absolute right-2 top-2 z-10 rounded-md border border-border-subtle/80 bg-bg-elevated/80 p-1 text-fg-muted opacity-0 backdrop-blur transition-opacity hover:bg-bg-raised group-hover:opacity-100"
      title={copied ? "Copied" : "Copy"}
      onClick={() => {
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => {});
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

/** Extract plain text from a <pre> element's children (the <code>
 *  inside may carry span wrappers from syntax highlighting). */
function extractText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return extractText((children as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function MarkdownPre(props: ComponentProps<"pre">) {
  const { children, ...rest } = props;
  const text = extractText(children);
  return (
    <pre {...rest} className={`group relative ${props.className ?? ""}`}>
      <CodeCopyButton text={text.replace(/\n$/, "")} />
      {children}
    </pre>
  );
}

export const MARKDOWN_COMPONENTS = { img: MarkdownImg, pre: MarkdownPre } as const;
