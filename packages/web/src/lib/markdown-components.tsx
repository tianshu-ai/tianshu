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

import { useState, type ComponentProps } from "react";
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

export const MARKDOWN_COMPONENTS = { img: MarkdownImg } as const;
