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

import type { ComponentProps } from "react";
import { rewriteWorkspaceUri } from "./workspace-uri.js";

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
  return (
    <img
      src={src}
      alt={alt ?? ""}
      loading="lazy"
      className="my-2 max-h-96 max-w-full rounded-lg border border-gray-700/50"
      {...rest}
    />
  );
}

export const MARKDOWN_COMPONENTS = { img: MarkdownImg } as const;
