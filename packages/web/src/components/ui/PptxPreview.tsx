import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

interface PptxPreviewProps {
  src: string;
  className?: string;
}

export function PptxPreview({ src, className = "" }: PptxPreviewProps) {
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
        const [{ init }, res] = await Promise.all([
          import("pptx-preview") as Promise<{ init: (el: HTMLElement, opts: { width: number; height: number }) => { preview: (data: ArrayBuffer) => Promise<void> } }>,
          fetch(src, { credentials: "include" }),
        ]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const previewer = init(el, {
          width: Math.min(el.clientWidth - 32, 960),
          height: 540,
        });
        await previewer.preview(buf);
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
      <div ref={containerRef} className="pptx-preview-container p-4" />
      <style>{`
        .pptx-preview-container {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 16px;
        }
        .pptx-preview-container .slide-wrapper {
          box-shadow: 0 2px 8px rgba(0,0,0,0.15);
          border-radius: 4px;
          overflow: hidden;
        }
      `}</style>
    </div>
  );
}
