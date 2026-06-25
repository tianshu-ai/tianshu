// HtmlPreview — renders an HTML file either as a live page
// (default) or as syntax-highlighted source.
//
// Live mode embeds the content in a sandboxed <iframe>. Sandbox
// flags are intentional:
//   - allow-scripts:  the page can run its own JS (otherwise an
//                     interactive demo, an HTML chart, etc.
//                     wouldn't work)
//   - allow-popups:   user-clicked links open in a new tab via
//                     window.open / target=_blank
// We deliberately do NOT enable `allow-same-origin`. The iframe
// runs as a different origin from tianshu, so even if the HTML
// is hostile it can't read tianshu cookies / localStorage / etc.
//
// We use srcdoc (inline source) rather than navigating the iframe
// to /api/p/files/raw. srcdoc keeps relative links from accidentally
// targeting the tianshu API (e.g. a `<a href="/dashboard">` inside
// the HTML would otherwise hit /dashboard on tianshu's origin) and
// lets us pull the bytes through the same JSON read endpoint
// caller already uses for everything else \u2014 no extra fetch round
// trip just because the content is HTML.
//
// Source toggle: top-right inside the preview area. The caller's
// Modal headerActions still has the Download button; the
// Render / Source toggle sits below that on the iframe header,
// because it's a content-mode switch not a global modal action.

import { useState } from "react";
import { Code, Eye } from "lucide-react";
import { CodeBlock } from "./CodeBlock.js";

export interface HtmlPreviewProps {
  /** HTML source. */
  html: string;
  /** Optional className passed through to the wrapper. */
  className?: string;
  /** Initial mode. Defaults to "render". */
  initialMode?: "render" | "source";
}

export function HtmlPreview({
  html,
  className = "",
  initialMode = "render",
}: HtmlPreviewProps) {
  const [mode, setMode] = useState<"render" | "source">(initialMode);

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className}`}>
      <div className="flex items-center justify-end gap-1 border-b border-gray-800 bg-gray-950/50 px-3 py-1.5">
        <ModeToggle mode={mode} onChange={setMode} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "render" ? (
          <iframe
            // Each remount on `html` change creates a fresh isolated
            // browsing context; the previous page's JS dies.
            key={html.slice(0, 64) + html.length}
            srcDoc={html}
            // No `allow-same-origin` on purpose; iframe runs as a
            // null origin so it can't reach tianshu cookies.
            sandbox="allow-scripts allow-popups allow-forms allow-modals"
            // Some HTML files won't set `<html style="height:100%">`
            // and would collapse to content height inside our flex.
            // 100% works because the parent is `flex-1 overflow-auto`.
            className="h-full w-full border-0 bg-white"
            title="HTML preview"
          />
        ) : (
          <CodeBlock code={html} lang="html" />
        )}
      </div>
    </div>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: "render" | "source";
  onChange: (m: "render" | "source") => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-gray-800 bg-gray-900/60 p-0.5 text-[11px] text-gray-400">
      <button
        type="button"
        onClick={() => onChange("render")}
        className={`flex items-center gap-1 rounded px-2 py-0.5 transition-colors ${
          mode === "render"
            ? "bg-gray-800 text-gray-100"
            : "hover:bg-gray-800/60 hover:text-gray-200"
        }`}
        title="Live preview"
      >
        <Eye size={12} />
        <span>Render</span>
      </button>
      <button
        type="button"
        onClick={() => onChange("source")}
        className={`flex items-center gap-1 rounded px-2 py-0.5 transition-colors ${
          mode === "source"
            ? "bg-gray-800 text-gray-100"
            : "hover:bg-gray-800/60 hover:text-gray-200"
        }`}
        title="View source"
      >
        <Code size={12} />
        <span>Source</span>
      </button>
    </div>
  );
}
