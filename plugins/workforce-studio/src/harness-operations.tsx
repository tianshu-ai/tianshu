// Harness² Operations — Organise + Analyse cards, moved from wiki plugin.
// These call /api/experience/* routes (server-level, not plugin-scoped).

import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import { Lightbulb, RefreshCw } from "lucide-react";

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
    fetch("/api/experience/status", { credentials: "include" })
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
      const res = await fetch("/api/experience/organise", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fresh }),
      });
      const body = await res.json() as { ok?: boolean; sessionsProcessed?: number; eventsFound?: number; skipped?: boolean; reason?: string };
      if (body.skipped) {
        setMsg(body.reason || "Nothing to organise");
      } else {
        setMsg(`${body.eventsFound ?? 0} events from ${body.sessionsProcessed ?? 0} sessions`);
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
          <div className="text-xs font-medium text-fg-default">① Organise Events</div>
        </div>
        {isOrganising ? (
          <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-amber-500/10 text-amber-400">
            <RefreshCw size={10} className="animate-spin" />
            Organising…
          </span>
        ) : (
          <button
            onClick={runOrganise}
            disabled={organising || isOrganising}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 transition-colors disabled:opacity-40"
          >
            <Lightbulb size={10} />
            Organise
          </button>
        )}
      </div>

      <div className="flex items-center gap-3">
        <span className="text-xs text-fg-muted flex-1">
          Segment session history into events with turn details and task info.
        </span>
        <label className="flex items-center gap-1.5 text-xs text-fg-fainter cursor-pointer select-none shrink-0">
          <input
            type="checkbox"
            checked={fresh}
            onChange={(e) => setFresh(e.target.checked)}
            disabled={organising || isOrganising}
            className="accent-amber-500 w-3 h-3"
          />
          From scratch
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
    fetch("/api/experience/history", { credentials: "include" })
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
      const res = await fetch("/api/experience/analyse", {
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
      const res = await fetch("/api/experience/rollback", {
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
          <div className="text-xs font-medium text-fg-default">② Analyse Insights</div>
        </div>
        {isAnalysing ? (
          <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-green-500/10 text-green-400">
            <RefreshCw size={10} className="animate-spin" />
            Analysing…
          </span>
        ) : (
          <button
            onClick={runAnalyse}
            disabled={analysing || isAnalysing || (status?.eventFiles ?? 0) === 0}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-green-400 bg-green-500/10 hover:bg-green-500/20 transition-colors disabled:opacity-40"
          >
            <Lightbulb size={10} />
            Analyse
          </button>
        )}
      </div>

      <div className="flex items-center gap-3">
        <span className="text-xs text-fg-muted flex-1">
          Review all 8 harness components and apply improvements from events.
        </span>
        <label className="flex items-center gap-1.5 text-xs text-fg-fainter cursor-pointer select-none shrink-0">
          <input
            type="checkbox"
            checked={fresh}
            onChange={(e) => setFresh(e.target.checked)}
            disabled={analysing || isAnalysing}
            className="accent-green-500 w-3 h-3"
          />
          From scratch
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
          <span className="text-fg-muted">insights</span>
          <span className="text-fg-fainter">·</span>
          <span className="text-fg-muted">{status.categories?.join(", ") || ""}</span>
        </div>
      )}

      {!isAnalysing && (status?.eventFiles ?? 0) === 0 && !msg && (
        <div className="text-xs text-fg-fainter">Organise first</div>
      )}

      {/* History toggle */}
      {!isAnalysing && (status?.insightFiles ?? 0) > 0 && (
        <button
          onClick={() => { setShowHistory(!showHistory); if (!showHistory) fetchHistory(); }}
          className="text-xs text-fg-fainter hover:text-fg-muted transition-colors"
        >
          {showHistory ? "Hide history" : "Version history"}
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
                  <span className="shrink-0 text-xs text-green-500 font-medium">Current</span>
                ) : (
                  <button
                    onClick={() => doRollback(h.oid)}
                    disabled={rollingBack}
                    className="shrink-0 text-xs text-green-400 hover:underline disabled:opacity-40"
                  >
                    Restore
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
