// Host-provided <MarkdownBlock> primitive.
//
// Thin wrapper over ReactMarkdown that re-uses the canonical
// remark plugins + components map + urlTransform used by the chat
// bubble. By centralising here:
//   - the chat-bubble path and the files preview path render the
//     same Markdown the same way (no skew between surfaces)
//   - swapping the markdown renderer in the future is one line
//
// We expose it as `MarkdownBlockHost` so the bootstrap layer can
// install it under the plugin-sdk UiPrimitives slot. The plugin-sdk
// consumer hook (`useUiPrimitives().MarkdownBlock`) returns the
// installed component.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MarkdownBlockProps } from "@tianshu-ai/plugin-sdk/client";
import {
  MARKDOWN_COMPONENTS,
  urlTransform,
} from "../../lib/markdown-components.js";

const DEFAULT_PROSE =
  "prose prose-invert prose-sm max-w-none text-[14px] leading-relaxed";

export function MarkdownBlock({ children, className = "" }: MarkdownBlockProps) {
  return (
    <div className={`${DEFAULT_PROSE} ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={MARKDOWN_COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
