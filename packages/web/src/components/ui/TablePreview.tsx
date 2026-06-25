// TablePreview — render CSV / TSV as a real HTML table.
//
// Parser: papaparse, lazy-imported on first use (papaparse is
// ~30KB and only matters when the user actually opens a table
// file). We pass the raw text content; papaparse handles
// quoting, escaped delimiters, and CRLF/LF differences.
//
// Display: first row treated as header (papaparse `header: true`
// returns an array of dicts). Body rows render as <td>; long
// cells wrap normally, very long cells get truncate-with-tooltip
// applied via CSS. Hard cap at 1000 data rows so a huge log
// doesn't blow up the DOM; users hit the cap get an inline
// notice with the row count and a hint to download.
//
// Edge cases:
//   - Inconsistent column counts (some rows shorter than the
//     header) — papaparse fills missing fields with empty
//     strings; we render an empty <td> for those.
//   - No header row (parse error or single-column file with
//     header=false fallback) — we fall back to numbered column
//     names so the table still renders.
//   - Empty / whitespace-only file — show "No rows."

import { useEffect, useMemo, useState } from "react";

const MAX_ROWS = 1000;

export interface TablePreviewProps {
  /** Raw text contents of the file. */
  content: string;
  /** Column delimiter. `","` for CSV, `"\t"` for TSV. Other
   *  delimiters work too (e.g. `";"`); papaparse auto-detects
   *  when set to "". */
  delimiter?: string;
  /** Optional className passed through to the wrapper. */
  className?: string;
}

interface ParseResult {
  headers: string[];
  rows: string[][];
  totalRows: number;
  error?: string;
}

export function TablePreview({
  content,
  delimiter = ",",
  className = "",
}: TablePreviewProps) {
  const [parsed, setParsed] = useState<ParseResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const Papa = (await import("papaparse")).default;
        // Parse synchronously off the main thread is fine for
        // typical CSV sizes (read endpoint caps at ~256KB).
        const result = Papa.parse<string[]>(content, {
          delimiter,
          skipEmptyLines: true,
          // header: false because we want to control the header
          // row ourselves — papaparse's header mode drops the
          // raw indices and we want to surface "Row 1 is header"
          // explicitly in the UI.
        });
        if (cancelled) return;
        const allRows = result.data as string[][];
        if (allRows.length === 0) {
          setParsed({ headers: [], rows: [], totalRows: 0 });
          return;
        }
        const headers = allRows[0];
        const dataRows = allRows.slice(1, 1 + MAX_ROWS);
        setParsed({
          headers,
          rows: dataRows,
          totalRows: allRows.length - 1,
          error: result.errors[0]?.message,
        });
      } catch (err) {
        if (!cancelled) {
          setParsed({
            headers: [],
            rows: [],
            totalRows: 0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [content, delimiter]);

  // Pad short rows out to the header width so the columns line up.
  const paddedRows = useMemo(() => {
    if (!parsed) return [];
    const width = parsed.headers.length;
    return parsed.rows.map((r) => {
      if (r.length >= width) return r;
      const out = r.slice();
      while (out.length < width) out.push("");
      return out;
    });
  }, [parsed]);

  if (!parsed) {
    return (
      <div className={`p-4 text-sm text-gray-500 ${className}`}>
        Parsing table…
      </div>
    );
  }

  if (parsed.error && parsed.rows.length === 0) {
    return (
      <div className={`p-4 text-sm text-rose-300 ${className}`}>
        Failed to parse table: {parsed.error}
      </div>
    );
  }

  if (parsed.headers.length === 0 && parsed.rows.length === 0) {
    return (
      <div className={`p-4 text-sm text-gray-500 ${className}`}>No rows.</div>
    );
  }

  const truncated = parsed.totalRows > MAX_ROWS;

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className}`}>
      {truncated && (
        <div className="mx-3 mt-3 rounded border border-amber-900/40 bg-amber-950/30 px-2 py-1 text-[11px] text-amber-200">
          Showing first {MAX_ROWS.toLocaleString()} of{" "}
          {parsed.totalRows.toLocaleString()} data rows. Download the file to
          inspect the rest.
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <table className="border-collapse text-[12px]">
          <thead>
            <tr className="bg-gray-900 text-gray-300">
              {parsed.headers.map((h, i) => (
                <th
                  key={i}
                  className="sticky top-0 z-10 border-b border-gray-700 bg-gray-900 px-2 py-1.5 text-left font-medium"
                >
                  {h || `Col ${i + 1}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paddedRows.map((row, ri) => (
              <tr key={ri} className="border-b border-gray-900 hover:bg-gray-900/40">
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className="max-w-[28rem] truncate border-r border-gray-900 px-2 py-1 text-gray-300"
                    title={cell}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
