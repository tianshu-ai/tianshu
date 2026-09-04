// Data Sources plugin — side panel.
// Query editor + results table for Neo4j/MySQL data sources.

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { Database, Play, Clock, Table2, Loader2, ArrowUp, ArrowDown, Filter, X } from "lucide-react";
import type { PanelProps, PluginClientExports } from "@tianshu-ai/plugin-sdk/client";
import { subscribeToWsEvent } from "@tianshu-ai/plugin-sdk/client";

const API_BASE = "/api/p/datasource";

interface Source {
  name: string;
  type: string;
  description: string;
}

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs?: number;
  error?: string;
}

function DataSourcePanel(_props: PanelProps) {
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<Array<{ source: string; query: string; at: number }>>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [schema, setSchema] = useState<string | null>(null);
  const [showSchema, setShowSchema] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Listen for agent-pushed queries via ds_panel_fill WS event
  useEffect(() => {
    return subscribeToWsEvent<{
      type: string;
      event?: string;
      payload?: { source?: string; query?: string; autoRun?: boolean };
    }>("plugin_event", (raw) => {
      if (raw.event !== "datasource:ds_panel_fill") return;
      const ev = raw.payload ?? {};
      if (ev.source) setSelected(ev.source);
      if (ev.query) setQuery(ev.query);
      // Auto-run: directly fire the query
      if (ev.autoRun && ev.source && ev.query) {
        const src = ev.source;
        const q = ev.query;
        setRunning(true);
        setResult(null);
        const start = Date.now();
        fetch(`${API_BASE}/query`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: src, query: q }),
        })
          .then((r) => r.json())
          .then((d: { error?: string; columns?: string[]; rows?: Record<string, unknown>[]; rowCount?: number }) => {
            const durationMs = Date.now() - start;
            if (d.error) {
              setResult({ columns: [], rows: [], rowCount: 0, error: d.error, durationMs });
            } else {
              setResult({ columns: d.columns ?? [], rows: d.rows ?? [], rowCount: d.rowCount ?? 0, durationMs });
            }
          })
          .catch((err) => setResult({ columns: [], rows: [], rowCount: 0, error: String(err), durationMs: Date.now() - start }))
          .finally(() => setRunning(false));
      }
    });
  }, []);

  // Load sources
  useEffect(() => {
    fetch(`${API_BASE}/connections`, { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((d: { connections?: Source[] } | null) => {
        const list = d?.connections ?? [];
        setSources(list);
        if (list.length > 0 && !selected) setSelected(list[0]!.name);
      })
      .catch(() => {});
  }, []);

  // Load schema when source changes
  useEffect(() => {
    if (!selected) return;
    setSchema(null);
    fetch(`${API_BASE}/schema/${encodeURIComponent(selected)}`, { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((d: { text?: string } | null) => setSchema(d?.text ?? null))
      .catch(() => {});
  }, [selected]);

  const runQuery = useCallback(async () => {
    if (!selected || !query.trim() || running) return;
    setRunning(true);
    setResult(null);
    const start = Date.now();
    try {
      const res = await fetch(`${API_BASE}/query`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: selected, query: query.trim() }),
      });
      const data = (await res.json()) as { error?: string; columns?: string[]; rows?: Record<string, unknown>[]; rowCount?: number };
      const durationMs = Date.now() - start;
      if (data.error) {
        setResult({ columns: [], rows: [], rowCount: 0, error: data.error, durationMs });
      } else {
        setResult({ columns: data.columns ?? [], rows: data.rows ?? [], rowCount: data.rowCount ?? 0, durationMs });
      }
      setHistory((prev) => [{ source: selected, query: query.trim(), at: Date.now() }, ...prev.slice(0, 19)]);
    } catch (err) {
      setResult({ columns: [], rows: [], rowCount: 0, error: String(err), durationMs: Date.now() - start });
    } finally {
      setRunning(false);
    }
  }, [selected, query, running]);

  const selectedSource = sources.find((s) => s.name === selected);
  const placeholder = selectedSource?.type === "neo4j"
    ? "MATCH (n) RETURN n LIMIT 10"
    : "SELECT * FROM table_name LIMIT 10";

  return (
    <div className="flex h-full flex-col text-[12px]">
      {/* Header: source selector */}
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <Database size={14} className="text-fg-faint" />
        <select
          className="flex-1 rounded border border-border-default bg-bg-elevated px-2 py-1 text-[12px] text-fg-default"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {sources.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name} ({s.type})
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setShowSchema((v) => !v)}
          className={`rounded px-2 py-1 text-[11px] ${showSchema ? "bg-brand-600 text-white" : "text-fg-muted hover:bg-bg-raised"}`}
          title="Schema"
        >
          <Table2 size={12} />
        </button>
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          className={`rounded px-2 py-1 text-[11px] ${showHistory ? "bg-brand-600 text-white" : "text-fg-muted hover:bg-bg-raised"}`}
          title="History"
        >
          <Clock size={12} />
        </button>
      </div>

      {/* Schema panel */}
      {showSchema && schema && (
        <div className="max-h-[200px] overflow-auto border-b border-border-subtle bg-bg-raised/30 px-3 py-2 text-[11px] text-fg-muted whitespace-pre-wrap">
          {schema}
        </div>
      )}

      {/* History panel */}
      {showHistory && history.length > 0 && (
        <div className="max-h-[150px] overflow-auto border-b border-border-subtle bg-bg-raised/30">
          {history.map((h, i) => (
            <button
              key={i}
              type="button"
              className="w-full truncate px-3 py-1 text-left text-[11px] text-fg-muted hover:bg-bg-hover"
              onClick={() => { setQuery(h.query); setSelected(h.source); setShowHistory(false); }}
            >
              <span className="text-fg-faint">[{h.source}]</span> {h.query}
            </button>
          ))}
        </div>
      )}

      {/* Query editor */}
      <div className="flex flex-col border-b border-border-subtle">
        <textarea
          ref={textareaRef}
          className="min-h-[80px] resize-y bg-transparent px-3 py-2 font-mono text-[12px] text-fg-default placeholder:text-fg-fainter focus:outline-none"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              runQuery();
            }
          }}
        />
        <div className="flex items-center justify-between px-3 py-1.5">
          <span className="text-[10px] text-fg-fainter">⌘+Enter to run</span>
          <button
            type="button"
            onClick={runQuery}
            disabled={running || !query.trim()}
            className="inline-flex items-center gap-1 rounded bg-brand-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-brand-500 disabled:opacity-40"
          >
            {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            Run
          </button>
        </div>
      </div>

      {/* Results */}
      {result && !result.error && result.rows.length > 0 ? (
        <ResultTable result={result} />
      ) : (
        <div className="flex-1 overflow-auto">
          {result?.error && (
            <div className="px-3 py-2 text-[12px] text-danger">{result.error}</div>
          )}
          {result && !result.error && result.rows.length === 0 && (
            <div className="px-3 py-2 text-fg-faint">No results.</div>
          )}
        </div>
      )}

      {/* Status bar */}
      {result && (
        <div className="flex items-center justify-between border-t border-border-subtle px-3 py-1 text-[10px] text-fg-faint">
          <span>{result.rowCount} row(s)</span>
          {result.durationMs !== undefined && <span>{result.durationMs}ms</span>}
        </div>
      )}
    </div>
  );
}

// ─── Enhanced Result Table ───────────────────────────────────

type SortDir = "asc" | "desc" | null;

function ResultTable({ result }: { result: QueryResult }) {
  const { columns, rows } = result;
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [filterOpen, setFilterOpen] = useState<string | null>(null);
  const dragRef = useRef<{ col: string; startX: number; startW: number } | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  // Default column width
  const getW = (col: string) => colWidths[col] ?? 150;

  // Drag resize
  const onMouseDown = useCallback((col: string, e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { col, startX: e.clientX, startW: getW(col) };
    const onMove = (me: MouseEvent) => {
      if (!dragRef.current) return;
      const diff = me.clientX - dragRef.current.startX;
      const newW = Math.max(50, dragRef.current.startW + diff);
      setColWidths((prev) => ({ ...prev, [dragRef.current!.col]: newW }));
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [colWidths]);

  // Sort toggle
  const toggleSort = useCallback((col: string) => {
    if (sortCol === col) {
      setSortDir((d) => d === "asc" ? "desc" : d === "desc" ? null : "asc");
      if (sortDir === "desc") setSortCol(null);
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  }, [sortCol, sortDir]);

  // Filter + sort rows
  const processedRows = useMemo(() => {
    let filtered = rows;
    // Apply filters
    for (const [col, val] of Object.entries(filters)) {
      if (!val) continue;
      const lower = val.toLowerCase();
      filtered = filtered.filter((r) => formatCell(r[col]).toLowerCase().includes(lower));
    }
    // Apply sort
    if (sortCol && sortDir) {
      const dir = sortDir === "asc" ? 1 : -1;
      filtered = [...filtered].sort((a, b) => {
        const av = a[sortCol];
        const bv = b[sortCol];
        if (av === bv) return 0;
        if (av === null || av === undefined) return dir;
        if (bv === null || bv === undefined) return -dir;
        if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
        return String(av).localeCompare(String(bv)) * dir;
      });
    }
    return filtered;
  }, [rows, filters, sortCol, sortDir]);

  const activeFilters = Object.values(filters).filter(Boolean).length;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Filter count bar */}
      {activeFilters > 0 && (
        <div className="flex items-center gap-2 border-b border-border-subtle bg-bg-raised/30 px-3 py-1 text-[10px] text-fg-muted">
          <Filter size={10} />
          <span>{activeFilters} filter(s) active · {processedRows.length} / {rows.length} rows</span>
          <button
            type="button"
            onClick={() => setFilters({})}
            className="ml-auto text-fg-faint hover:text-fg-default"
          >
            <X size={10} /> Clear
          </button>
        </div>
      )}

      <div ref={tableRef} className="flex-1 overflow-auto">
        <table className="text-[11px]" style={{ minWidth: "100%", borderCollapse: "collapse" }}>
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-border-subtle bg-bg-raised">
              {columns.map((col) => (
                <th
                  key={col}
                  className="relative select-none border-r border-border-subtle/30 px-2 py-1.5 text-left font-medium text-fg-muted"
                  style={{ width: getW(col), minWidth: 50, maxWidth: getW(col) }}
                >
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="flex-1 truncate text-left hover:text-fg-default"
                      onClick={() => toggleSort(col)}
                    >
                      {col}
                    </button>
                    {sortCol === col && sortDir === "asc" && <ArrowUp size={10} className="text-brand-500" />}
                    {sortCol === col && sortDir === "desc" && <ArrowDown size={10} className="text-brand-500" />}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setFilterOpen(filterOpen === col ? null : col); }}
                      className={`rounded p-0.5 ${filters[col] ? "text-brand-500" : "text-fg-fainter hover:text-fg-muted"}`}
                    >
                      <Filter size={9} />
                    </button>
                  </div>
                  {/* Filter input dropdown */}
                  {filterOpen === col && (
                    <div className="absolute left-0 top-full z-20 min-w-[160px] rounded border border-border-default bg-bg-surface p-1 shadow-lg">
                      <input
                        className="w-full rounded border border-border-default bg-bg-default px-2 py-1 text-[11px] text-fg-default outline-none placeholder:text-fg-fainter"
                        placeholder={`Filter ${col}...`}
                        value={filters[col] ?? ""}
                        onChange={(e) => setFilters((p) => ({ ...p, [col]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") setFilterOpen(null); }}
                        autoFocus
                      />
                      {filters[col] && (
                        <button
                          type="button"
                          className="mt-1 w-full rounded px-2 py-0.5 text-[10px] text-fg-muted hover:bg-bg-hover"
                          onClick={() => { setFilters((p) => { const n = { ...p }; delete n[col]; return n; }); setFilterOpen(null); }}
                        >
                          Clear filter
                        </button>
                      )}
                    </div>
                  )}
                  {/* Resize handle */}
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-brand-500/30"
                    onMouseDown={(e) => onMouseDown(col, e)}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {processedRows.map((row, i) => (
              <tr key={i} className="border-b border-border-subtle/30 hover:bg-bg-hover/30">
                {columns.map((col) => (
                  <td
                    key={col}
                    className="truncate border-r border-border-subtle/15 px-2 py-1 text-fg-default"
                    style={{ maxWidth: getW(col) }}
                    title={formatCell(row[col])}
                  >
                    {formatCell(row[col])}
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

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const exports: PluginClientExports = {
  components: {
    DataSourcePanel,
  },
};

export default exports;
