import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

interface DocxPreviewProps {
  src: string;
  className?: string;
}

export function DocxPreview({ src, className = "" }: DocxPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    el.innerHTML = "";
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const [{ renderAsync }, res] = await Promise.all([
          import("docx-preview"),
          fetch(src, { credentials: "include" }),
        ]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        await renderAsync(blob, el, undefined, {
          className: "docx-preview-body",
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [src]);

  return (
    <div className={`relative min-h-0 flex-1 overflow-auto ${className}`}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg-base/80 z-10">
          <Loader2 size={20} className="animate-spin text-fg-faint" />
        </div>
      )}
      {error && (
        <div className="p-6 text-center text-sm text-danger">{error}</div>
      )}
      <div ref={containerRef} className="docx-preview-container" />
      <style>{`
        .docx-preview-container .docx-wrapper {
          background: white;
          padding: 16px;
        }
        .docx-preview-container .docx-wrapper > section.docx {
          box-shadow: 0 1px 3px rgba(0,0,0,0.12);
          margin-bottom: 16px;
          padding: 40px 60px;
        }
      `}</style>
    </div>
  );
}
