// Data Sources plugin — side panel.
// Query editor + results table for Neo4j/MySQL data sources.

import { useCallback, useEffect, useState, useRef } from "react";
import { Database, Play, Clock, ChevronDown, Table2, Loader2 } from "lucide-react";
import type { PanelProps, PluginClientExports } from "@tianshu-ai/plugin-sdk/client";
import { usePluginT } from "@tianshu-ai/plugin-sdk/client";

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
      <div className="flex-1 overflow-auto">
        {result?.error && (
          <div className="px-3 py-2 text-[12px] text-danger">{result.error}</div>
        )}
        {result && !result.error && result.rows.length === 0 && (
          <div className="px-3 py-2 text-fg-faint">No results.</div>
        )}
        {result && !result.error && result.rows.length > 0 && (
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-border-subtle bg-bg-raised/30">
                {result.columns.map((col) => (
                  <th key={col} className="px-2 py-1.5 text-left font-medium text-fg-muted">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i} className="border-b border-border-subtle/50 hover:bg-bg-hover/30">
                  {result.columns.map((col) => (
                    <td key={col} className="max-w-[200px] truncate px-2 py-1 text-fg-default">
                      {formatCell(row[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

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
