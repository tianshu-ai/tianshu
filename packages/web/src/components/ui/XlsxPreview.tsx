import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

interface XlsxPreviewProps {
  src: string;
  className?: string;
}

interface SheetData {
  name: string;
  html: string;
}

export function XlsxPreview({ src, className = "" }: XlsxPreviewProps) {
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const [XLSX, res] = await Promise.all([
          import("xlsx"),
          fetch(src, { credentials: "include" }),
        ]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const result: SheetData[] = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name]!;
          const html = XLSX.utils.sheet_to_html(ws, { id: `sheet-${name}` });
          return { name, html };
        });
        setSheets(result);
        setActiveSheet(0);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [src]);

  if (loading) {
    return (
      <div className={`flex h-32 items-center justify-center ${className}`}>
        <Loader2 size={20} className="animate-spin text-fg-faint" />
      </div>
    );
  }
  if (error) {
    return <div className={`p-6 text-center text-sm text-danger ${className}`}>{error}</div>;
  }

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className}`}>
      {/* Sheet tabs */}
      {sheets.length > 1 && (
        <div className="flex shrink-0 gap-0 border-b border-border-subtle bg-bg-raised overflow-x-auto">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              onClick={() => setActiveSheet(i)}
              className={`px-3 py-1.5 text-[11px] whitespace-nowrap transition-colors ${
                i === activeSheet
                  ? "text-fg-default bg-bg-surface border-b-2 border-link font-medium"
                  : "text-fg-muted hover:text-fg-default hover:bg-bg-hover"
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {/* Sheet content */}
      <div className="flex-1 overflow-auto">
        {sheets[activeSheet] && (
          <div
            className="xlsx-preview-table"
            dangerouslySetInnerHTML={{ __html: sheets[activeSheet].html }}
          />
        )}
      </div>
      <style>{`
        .xlsx-preview-table table {
          border-collapse: collapse;
          font-size: 12px;
          font-family: -apple-system, BlinkMacSystemFont, sans-serif;
          color: var(--color-fg-default, #e0e0e0);
        }
        .xlsx-preview-table td, .xlsx-preview-table th {
          border: 1px solid var(--color-border-subtle, #333);
          padding: 4px 8px;
          white-space: nowrap;
          max-width: 300px;
          overflow: hidden;
          text-overflow: ellipsis;
          color: var(--color-fg-default, #e0e0e0);
        }
        .xlsx-preview-table th {
          background: var(--color-bg-raised, #1a1a2e);
          font-weight: 600;
          color: var(--color-fg-default, #e0e0e0);
        }
        .xlsx-preview-table tr:nth-child(even) td {
          background: var(--color-bg-surface, rgba(255,255,255,0.02));
        }
      `}</style>
    </div>
  );
}
