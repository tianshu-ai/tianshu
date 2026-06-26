// ImagePreview — <img> wrapper used by DocumentViewer's image
// branch. For most raster formats this is a thin wrapper, but
// SVG also gets a "View source" toggle so power users can inspect
// the markup without leaving the modal.
//
// Why SVG is special: SVG IS source code. Devs frequently want
// to grab a path or tweak fill — having a one-click toggle to
// the highlighted XML in the same modal saves a Download +
// open-in-editor trip.
//
// Non-SVG images (png / jpg / gif / webp / ...) never get the
// toggle; the source view would just be `data:` bytes, useless.

import { useState } from "react";
import { Code, Eye } from "lucide-react";
import { CodeBlock } from "./CodeBlock.js";

export interface ImagePreviewProps {
  /** URL the <img> renders against. Required for all image
   *  types because images stream from /raw, never inlined. */
  src: string;
  /** Filename, used as alt text + to decide whether this is an
   *  SVG (which gets the toggle). */
  filename?: string;
  /** Optional raw SVG source. When provided AND the file is SVG,
   *  a View source toggle appears in a sub-header; the source
   *  view falls through to CodeBlock with lang="xml". */
  svgSource?: string;
  /** Optional className. */
  className?: string;
}

const SVG_EXT = ".svg";

export function ImagePreview({
  src,
  filename,
  svgSource,
  className = "",
}: ImagePreviewProps) {
  const isSvg = !!filename && filename.toLowerCase().endsWith(SVG_EXT);
  const [mode, setMode] = useState<"render" | "source">("render");

  // Non-SVG path: just an <img>. No header chrome needed.
  if (!isSvg || !svgSource) {
    return (
      <div
        className={`flex min-h-0 flex-1 items-center justify-center bg-bg-base ${className}`}
      >
        <img
          src={src}
          alt={filename ?? "image"}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }

  // SVG path: sub-header with Render / Source toggle.
  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className}`}>
      <div className="flex items-center justify-end gap-1 border-b border-border-subtle bg-gray-950/50 px-3 py-1.5">
        <ModeToggle mode={mode} onChange={setMode} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "render" ? (
          <div className="flex h-full items-center justify-center bg-bg-base">
            <img
              src={src}
              alt={filename ?? "image"}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : (
          <CodeBlock code={svgSource} lang="xml" />
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
    <div className="inline-flex rounded-md border border-border-subtle bg-gray-900/60 p-0.5 text-[11px] text-fg-muted">
      <button
        type="button"
        onClick={() => onChange("render")}
        className={`flex items-center gap-1 rounded px-2 py-0.5 transition-colors ${
          mode === "render"
            ? "bg-bg-raised text-fg-default"
            : "hover:bg-gray-800/60 hover:text-fg-default"
        }`}
        title="Render"
      >
        <Eye size={12} />
        <span>Render</span>
      </button>
      <button
        type="button"
        onClick={() => onChange("source")}
        className={`flex items-center gap-1 rounded px-2 py-0.5 transition-colors ${
          mode === "source"
            ? "bg-bg-raised text-fg-default"
            : "hover:bg-gray-800/60 hover:text-fg-default"
        }`}
        title="View source"
      >
        <Code size={12} />
        <span>Source</span>
      </button>
    </div>
  );
}
