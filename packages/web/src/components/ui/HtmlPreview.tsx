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
import { useT } from "../../hooks/useT";

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
  const tHtml = useT();
  const [mode, setMode] = useState<"render" | "source">(initialMode);

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className}`}>
      <div className="flex items-center justify-end gap-1 border-b border-border-subtle bg-bg-base/50 px-3 py-1.5">
        <ModeToggle mode={mode} onChange={setMode} />
      </div>
      {mode === "render" ? (
        // Iframe gets the full body without an overflow wrapper.
        // An outer overflow-auto would NOT propagate height to
        // its child (it becomes a scroll container instead), so
        // the iframe would collapse to content height. With a
        // plain flex-1 parent the iframe inherits the bounded
        // height from Modal and the iframe itself scrolls its
        // content via the browser's native PDF/page scroll.
        <iframe
          // Each remount on `html` change creates a fresh isolated
          // browsing context; the previous page's JS dies.
          key={html.slice(0, 64) + html.length}
          srcDoc={html}
          // No `allow-same-origin` on purpose; iframe runs as a
          // null origin so it can't reach tianshu cookies.
          sandbox="allow-scripts allow-popups allow-forms allow-modals"
          className="min-h-0 w-full flex-1 border-0 bg-white"
          title={tHtml("preview.html.iframeTitle")}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <CodeBlock code={html} lang="html" />
        </div>
      )}
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
  const t = useT();
  return (
    <div className="inline-flex rounded-md border border-border-subtle bg-bg-elevated/60 p-0.5 text-[11px] text-fg-muted">
      <button
        type="button"
        onClick={() => onChange("render")}
        className={`flex items-center gap-1 rounded px-2 py-0.5 transition-colors ${
          mode === "render"
            ? "bg-bg-hover text-fg-default"
            : "hover:bg-bg-hover/60 hover:text-fg-default"
        }`}
        title={t("preview.tooltip.livePreview")}
      >
        <Eye size={12} />
        <span>{t("preview.mode.render")}</span>
      </button>
      <button
        type="button"
        onClick={() => onChange("source")}
        className={`flex items-center gap-1 rounded px-2 py-0.5 transition-colors ${
          mode === "source"
            ? "bg-bg-hover text-fg-default"
            : "hover:bg-bg-hover/60 hover:text-fg-default"
        }`}
        title={t("preview.tooltip.viewSource")}
      >
        <Code size={12} />
        <span>{t("preview.mode.source")}</span>
      </button>
    </div>
  );
}
