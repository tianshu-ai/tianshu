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
import { useThemeStore } from "../../stores/theme-store";

// `prose-invert` is Tailwind Typography's "white text on dark
// background" variant; only apply it when we're actually in
// dark mode. On light theme we want regular `prose` (dark text
// on light) — otherwise rendered markdown is white-on-white
// and invisible.
const PROSE_BASE = "prose prose-sm max-w-none text-[14px] leading-relaxed";

// Hoisted to a stable module-level reference. Inlining `[remarkGfm]`
// in JSX allocates a fresh array every render, and react-markdown
// keys its internal unified processor on the plugins array identity
// — so a new array forces a full processor rebuild on each render.
// During streaming the live bubble re-renders per token, so this
// turns "rebuild the whole remark pipeline every token" into "build
// once". `MARKDOWN_COMPONENTS` and `urlTransform` are already stable
// module-level references.
const REMARK_PLUGINS = [remarkGfm];

export function MarkdownBlock({
  children,
  className = "",
  noProse = false,
}: MarkdownBlockProps) {
  const isDark = useThemeStore((s) => s.resolved === "dark");
  // noProse callers get a bare <div> wrapper. That's the chat
  // bubble path: the bubble already owns the prose container +
  // border + padding, and double-wrapping in prose would compound
  // the typography settings (margins on first/last child, list
  // indents, etc.).
  const proseClass = `${PROSE_BASE}${isDark ? " prose-invert" : ""}`;
  const wrapperClass = noProse ? className : `${proseClass} ${className}`.trim();
  return (
    <div className={wrapperClass}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        urlTransform={urlTransform}
        components={MARKDOWN_COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
