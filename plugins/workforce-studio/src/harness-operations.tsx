// Harness² Operations — Organise + Analyse cards, moved from wiki plugin.
// These call /api/experience/* routes (server-level, not plugin-scoped).

import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import { Lightbulb, RefreshCw } from "lucide-react";
import { usePluginT } from "@tianshu-ai/plugin-sdk/client";

// ── types ───────────────────────────────────────────────────────

interface HarvestProgress { step: string; current: number; total: number; label?: string }
interface HarvestStatus {
  eventFiles: number;
  totalEvents: number;
  insightFiles: number;
  categories: string[];
  progress?: HarvestProgress;
  activeOid?: string | null;
}

// ── shared hook ─────────────────────────────────────────────────

function useHarvestStatus() {
  const [status, setStatus] = useState<HarvestStatus | null>(null);
  const progress = status?.progress;
  const isRunning = progress && progress.step !== "idle";

  const fetchStatus = useCallback(() => {
    fetch("/api/p/workforce-studio/harness/status", { credentials: "include" })
      .then(r => r.ok ? r.json().catch(() => null) : null)
      .then((d: HarvestStatus | null) => { if (d) setStatus(d); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, isRunning ? 2000 : 10000);
    return () => clearInterval(id);
  }, [fetchStatus, isRunning]);

  return { status, fetchStatus, progress, isRunning };
}

// ── Organise Card ───────────────────────────────────────────────

export function OrganiseCard(): ReactElement {
  const t = usePluginT("workforce-studio");
  const { status, fetchStatus, progress, isRunning } = useHarvestStatus();
  const [organising, setOrganising] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const isOrganising = isRunning && progress?.step === "organise";
  const pct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  const runOrganise = async () => {
    setOrganising(true);
    setMsg(null);
    try {
      const res = await fetch("/api/p/workforce-studio/harness/organise", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fresh }),
      });
      const body = await res.json() as { ok?: boolean; sessionsProcessed?: number; eventsFound?: number; skipped?: boolean; reason?: string };
      if (body.skipped) {
        setMsg(body.reason || t("harness.organise.nothing"));
      } else {
        setMsg(`${body.eventsFound ?? 0} ${t("harness.organise.events")} from ${body.sessionsProcessed ?? 0} ${t("harness.organise.sessions")}`);
      }
      fetchStatus();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setOrganising(false);
    }
  };

  return (
    <div className="rounded-xl bg-bg-raised/50 p-3.5 space-y-2.5">
      <div className="flex items-center gap-2">
        <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-amber-500/10">
          <Lightbulb size={14} className="text-amber-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-fg-default">{t("harness.organise.title")}</div>
        </div>
        {isOrganising ? (
          <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-amber-500/10 text-amber-400">
            <RefreshCw size={10} className="animate-spin" />
            {t("harness.organise.running")}
          </span>
        ) : (
          <button
            onClick={runOrganise}
            disabled={organising || isOrganising}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 transition-colors disabled:opacity-40"
          >
            <Lightbulb size={10} />
            {t("harness.organise.btn")}
          </button>
        )}
      </div>

      <div className="flex items-center gap-3">
        <span className="text-xs text-fg-muted flex-1">
          {t("harness.organise.desc")}
        </span>
        <label className="flex items-center gap-1.5 text-xs text-fg-fainter cursor-pointer select-none shrink-0">
          <input
            type="checkbox"
            checked={fresh}
            onChange={(e) => setFresh(e.target.checked)}
            disabled={organising || isOrganising}
            className="accent-amber-500 w-3 h-3"
          />
          {t("harness.organise.fresh")}
        </label>
      </div>

      {isOrganising && progress && progress.total > 0 && (
        <>
          <div className="h-1.5 rounded-full bg-bg-default overflow-hidden">
            <div className="h-full rounded-full transition-all duration-700 bg-amber-400" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <span className="font-medium">{progress.current}/{progress.total}</span>
            {progress.label && <span className="text-fg-fainter truncate">{progress.label}</span>}
          </div>
        </>
      )}

      {!isOrganising && status && status.eventFiles > 0 && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-amber-400 font-medium">{status.eventFiles}</span>
          <span className="text-fg-muted">sessions</span>
          <span className="text-fg-fainter">·</span>
          <span className="text-amber-400 font-medium">{status.totalEvents}</span>
          <span className="text-fg-muted">events</span>
        </div>
      )}

      {msg && <div className="text-xs text-fg-muted">{msg}</div>}
    </div>
  );
}

// ── Analyse Card ────────────────────────────────────────────────

export function AnalyseCard(): ReactElement {
  const t = usePluginT("workforce-studio");
  const { status, fetchStatus, progress, isRunning } = useHarvestStatus();
  const [analysing, setAnalysing] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<Array<{ oid: string; message: string; timestamp: number }>>([]);
  const [rollingBack, setRollingBack] = useState(false);
  const isAnalysing = isRunning && progress?.step === "analyse";
  const pct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  const fetchHistory = useCallback(() => {
    fetch("/api/p/workforce-studio/harness/history", { credentials: "include" })
      .then(r => r.ok ? r.json().catch(() => null) : null)
      .then((d: { history?: Array<{ oid: string; message: string; timestamp: number }> } | null) => {
        if (d?.history) setHistory(d.history);
      })
      .catch(() => {});
  }, []);

  const runAnalyse = async () => {
    setAnalysing(true);
    setMsg(null);
    try {
      const res = await fetch("/api/p/workforce-studio/harness/analyse", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fresh }),
      });
      const body = await res.json() as { ok?: boolean; totalEvents?: number; rulesGenerated?: number; skipped?: boolean; reason?: string };
      if (body.skipped) {
        setMsg(body.reason || "Nothing to analyse");
      } else {
        setMsg(`${body.rulesGenerated ?? 0} rules from ${body.totalEvents ?? 0} events`);
      }
      fetchStatus();
      if (showHistory) fetchHistory();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalysing(false);
    }
  };

  const doRollback = async (oid: string) => {
    setRollingBack(true);
    try {
      const res = await fetch("/api/p/workforce-studio/harness/rollback", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oid }),
      });
      const body = await res.json() as { ok?: boolean; message?: string };
      setMsg(body.message || (body.ok ? "Restored" : "Restore failed"));
      fetchStatus();
      fetchHistory();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setRollingBack(false);
    }
  };

  return (
    <div className="rounded-xl bg-bg-raised/50 p-3.5 space-y-2.5">
      <div className="flex items-center gap-2">
        <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-green-500/10">
          <Lightbulb size={14} className="text-green-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-fg-default">{t("harness.analyse.title")}</div>
        </div>
        {isAnalysing ? (
          <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-green-500/10 text-green-400">
            <RefreshCw size={10} className="animate-spin" />
            {t("harness.analyse.running")}
          </span>
        ) : (
          <button
            onClick={runAnalyse}
            disabled={analysing || isAnalysing || (status?.eventFiles ?? 0) === 0}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-green-400 bg-green-500/10 hover:bg-green-500/20 transition-colors disabled:opacity-40"
          >
            <Lightbulb size={10} />
            {t("harness.analyse.btn")}
          </button>
        )}
      </div>

      <div className="flex items-center gap-3">
        <span className="text-xs text-fg-muted flex-1">
          {t("harness.analyse.desc")}
        </span>
        <label className="flex items-center gap-1.5 text-xs text-fg-fainter cursor-pointer select-none shrink-0">
          <input
            type="checkbox"
            checked={fresh}
            onChange={(e) => setFresh(e.target.checked)}
            disabled={analysing || isAnalysing}
            className="accent-green-500 w-3 h-3"
          />
          {t("harness.analyse.fresh")}
        </label>
      </div>

      {isAnalysing && progress && progress.total > 0 && (
        <>
          <div className="h-1.5 rounded-full bg-bg-default overflow-hidden">
            <div className="h-full rounded-full transition-all duration-700 bg-green-500" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <span className="font-medium">{progress.current}/{progress.total}</span>
            {progress.label && <span className="text-fg-fainter truncate">{progress.label}</span>}
          </div>
        </>
      )}

      {!isAnalysing && status && status.insightFiles > 0 && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-green-400 font-medium">{status.insightFiles}</span>
          <span className="text-fg-muted">{t("harness.analyse.insights")}</span>
          <span className="text-fg-fainter">·</span>
          <span className="text-fg-muted">{status.categories?.join(", ") || ""}</span>
        </div>
      )}

      {!isAnalysing && (status?.eventFiles ?? 0) === 0 && !msg && (
        <div className="text-xs text-fg-fainter">{t("harness.analyse.organiseFirst")}</div>
      )}

      {/* History toggle */}
      {!isAnalysing && (status?.insightFiles ?? 0) > 0 && (
        <button
          onClick={() => { setShowHistory(!showHistory); if (!showHistory) fetchHistory(); }}
          className="text-xs text-fg-fainter hover:text-fg-muted transition-colors"
        >
          {showHistory ? t("harness.analyse.hideHistory") : t("harness.analyse.history")}
        </button>
      )}

      {showHistory && history.length > 0 && (
        <div className="max-h-32 overflow-y-auto rounded-md bg-bg-default/60 p-2 space-y-1">
          {history.map((h) => {
            const isCurrent = status?.activeOid ? h.oid === status.activeOid : h.oid === history[0]?.oid;
            return (
              <div key={h.oid} className="flex items-center gap-2 text-xs">
                <span className="text-fg-fainter font-mono shrink-0">{h.oid.slice(0, 7)}</span>
                <span className="text-fg-muted truncate flex-1">{h.message}</span>
                <span className="text-fg-fainter shrink-0">{new Date(h.timestamp).toLocaleDateString()}</span>
                {isCurrent ? (
                  <span className="shrink-0 text-xs text-green-500 font-medium">{t("harness.analyse.current")}</span>
                ) : (
                  <button
                    onClick={() => doRollback(h.oid)}
                    disabled={rollingBack}
                    className="shrink-0 text-xs text-green-400 hover:underline disabled:opacity-40"
                  >
                    {t("harness.analyse.restore")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {msg && <div className="text-xs text-fg-muted">{msg}</div>}
    </div>
  );
}

// ── Event/Insight File Browser ──────────────────────────────────

interface ExpEvent { file: string; sessionId: string | null; createdAt: string | null; eventCount: number; sizeBytes: number }
interface ExpInsight { file: string; type: string; createdAt: string | null; sizeBytes: number; preview: string }

const EXP_API = "/api/p/workforce-studio/harness";

export function EventInsightBrowser(): ReactElement {
  const t = usePluginT("workforce-studio");
  const [events, setEvents] = useState<ExpEvent[]>([]);
  const [insights, setInsights] = useState<ExpInsight[]>([]);
  const [selectedContent, setSelectedContent] = useState<{ title: string; content: string } | null>(null);
  const [view, setView] = useState<"events" | "insights">("events");

  const refreshFiles = useCallback(async () => {
    try {
      const [e, i] = await Promise.all([
        fetch(`${EXP_API}/events`, { credentials: "include" }).then(r => r.json()),
        fetch(`${EXP_API}/insights`, { credentials: "include" }).then(r => r.json()),
      ]);
      if (e.ok) setEvents(e.events);
      if (i.ok) setInsights(i.insights);
    } catch { /* */ }
  }, []);

  useEffect(() => { refreshFiles(); }, [refreshFiles]);

  const openFile = async (type: "events" | "insights", file: string) => {
    try {
      const r = await fetch(`${EXP_API}/${type}/${encodeURIComponent(file)}`, { credentials: "include" });
      const data = await r.json();
      if (data.ok) setSelectedContent({ title: file, content: data.content });
    } catch { /* */ }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {(["events", "insights"] as const).map(v => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={"rounded-md px-3 py-1 text-xs font-medium transition-colors " +
              (view === v ? "bg-fg-default text-bg-surface" : "bg-bg-raised text-fg-muted hover:text-fg-default")}
          >
            {v === "events" ? t("harness.browser.events", { n: events.length }) : t("harness.browser.insights", { n: insights.length })}
          </button>
        ))}
        <button onClick={() => void refreshFiles()} className="ml-auto rounded-md px-2 py-1 text-xs text-fg-faint hover:text-fg-muted">
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="max-h-64 overflow-y-auto rounded-lg border border-border-subtle divide-y divide-border-subtle">
        {view === "events" && events.map(e => (
          <button
            key={e.file}
            onClick={() => openFile("events", e.file)}
            className="block w-full text-left px-3 py-2 text-xs hover:bg-bg-raised/50 transition-colors"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-fg-default">{e.file.replace(/\.md$/, "")}</span>
              <span className="text-fg-faint">{e.eventCount} events</span>
            </div>
            <div className="text-[10px] text-fg-faint">
              {e.createdAt ? new Date(e.createdAt).toLocaleString() : ""}
              {" · "}{Math.round(e.sizeBytes / 1024)} KB
            </div>
          </button>
        ))}
        {view === "events" && events.length === 0 && (
          <div className="text-center py-6 text-xs text-fg-faint">{t("harness.browser.noEvents")}</div>
        )}
        {view === "insights" && insights.map(i => (
          <button
            key={i.file}
            onClick={() => openFile("insights", i.file)}
            className="block w-full text-left px-3 py-2 text-xs hover:bg-bg-raised/50 transition-colors"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-fg-default">{i.file.replace(/\.md$/, "")}</span>
              <span className={"rounded px-1 py-0.5 text-[10px] " + (i.type === "changelog" ? "bg-blue-500/10 text-blue-400" : "bg-green-500/10 text-green-400")}>{i.type}</span>
            </div>
            <div className="text-[10px] text-fg-faint">
              {i.createdAt ? new Date(i.createdAt).toLocaleString() : ""}
              {" · "}{Math.round(i.sizeBytes / 1024)} KB
            </div>
          </button>
        ))}
        {view === "insights" && insights.length === 0 && (
          <div className="text-center py-6 text-xs text-fg-faint">{t("harness.browser.noInsights")}</div>
        )}
      </div>

      {/* File content modal — simple overlay since we don't have useUiPrimitives here */}
      {selectedContent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setSelectedContent(null)}>
          <div className="w-full max-w-3xl max-h-[80vh] rounded-xl bg-bg-surface border border-border-subtle shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
              <h3 className="text-sm font-semibold text-fg-default">{selectedContent.title}</h3>
              <button onClick={() => setSelectedContent(null)} className="text-fg-faint hover:text-fg-default text-lg">×</button>
            </div>
            <div className="p-4 overflow-y-auto max-h-[70vh]">
              <pre className="text-xs text-fg-muted whitespace-pre-wrap font-mono leading-relaxed">{selectedContent.content}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
