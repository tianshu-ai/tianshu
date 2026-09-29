// Doctor plugin — right-side panel.
//
// Fetches /api/p/doctor/check and renders a grouped diagnostic
// report with pass/warn/fail status icons per check line.

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  MessageSquareWarning,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useChatNav } from "@tianshu-ai/plugin-sdk/client";
import type { PanelProps, PluginClientExports } from "@tianshu-ai/plugin-sdk/client";

const API_BASE = "/api/p/doctor";

// ── Types (mirrors server's CheckGroup / DoctorReport) ─────────

type Severity = "ok" | "warning" | "blocker";

interface CheckLine {
  severity: Severity;
  text: string;
  detail?: string;
}

interface CheckGroup {
  title: string;
  lines: CheckLine[];
}

interface DoctorReport {
  groups: CheckGroup[];
  ok: number;
  warning: number;
  blocker: number;
}

// ── Severity helpers ───────────────────────────────────────────

function SeverityIcon({ severity, size = 12 }: { severity: Severity; size?: number }) {
  switch (severity) {
    case "ok":
      return <CheckCircle2 size={size} className="text-emerald-400 flex-shrink-0" />;
    case "warning":
      return <AlertTriangle size={size} className="text-amber-400 flex-shrink-0" />;
    case "blocker":
      return <XCircle size={size} className="text-rose-400 flex-shrink-0" />;
  }
}

function groupSeverity(group: CheckGroup): Severity {
  let worst: Severity = "ok";
  for (const l of group.lines) {
    if (l.severity === "blocker") return "blocker";
    if (l.severity === "warning") worst = "warning";
  }
  return worst;
}

function severityCount(lines: CheckLine[], s: Severity): number {
  return lines.filter((l) => l.severity === s).length;
}

// ── Line item with hover-to-pin ───────────────────────────────

function LineItem({
  line,
  groupTitle,
  onPin,
}: {
  line: CheckLine;
  groupTitle: string;
  onPin: (line: CheckLine, group: string) => void;
}) {
  const actionable = line.severity !== "ok";

  const row = (
    <div
      className={[
        "flex items-start gap-2 px-3 py-1 rounded-md transition-colors",
        actionable
          ? "cursor-pointer hover:bg-white/[0.06]"
          : "",
      ].join(" ")}
      onClick={actionable ? () => onPin(line, groupTitle) : undefined}
      role={actionable ? "button" : undefined}
      tabIndex={actionable ? 0 : undefined}
      onKeyDown={actionable ? (e) => { if (e.key === "Enter" || e.key === " ") onPin(line, groupTitle); } : undefined}

    >
      {/* Icon: severity icon morphs into chat icon on hover.
         mt-[3px] aligns the 12px icon with the first text line. */}
      <span className="flex-shrink-0 relative mt-[3px]">
        {actionable ? (
          <>
            <span className="block group-icon">
              <SeverityIcon severity={line.severity} />
            </span>
            <span className="hidden group-icon-hover">
              <MessageSquareWarning
                size={12}
                className={line.severity === "blocker" ? "text-rose-400" : "text-amber-400"}
              />
            </span>
          </>
        ) : (
          <SeverityIcon severity={line.severity} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <span className="text-[11px] text-fg-default">{line.text}</span>
        {line.detail && (
          <div className="text-[10px] text-fg-faint truncate" title={actionable ? undefined : line.detail}>
            {line.detail}
          </div>
        )}
      </div>
      {actionable && (
        <span className="hidden group-hover-hint flex-shrink-0 text-[9px] text-fg-faint/60 self-center whitespace-nowrap">
          click to fix →
        </span>
      )}
    </div>
  );

  // Wrap actionable lines in a group so we can swap icons + show hint on hover via CSS
  if (!actionable) return row;
  return <div className="dr-line-actionable">{row}</div>;
}

// CSS-only hover swap: avoids React state thrash on rapid mouse movement.
const lineHoverStyles = (
  <style>{`
    .dr-line-actionable:hover .group-icon { display: none !important; }
    .dr-line-actionable:hover .group-icon-hover { display: block !important; }
    .dr-line-actionable:hover .group-hover-hint { display: block !important; }
  `}</style>
);

// ── Group component ────────────────────────────────────────────

function GroupSection({ group, onPin }: { group: CheckGroup; onPin: (line: CheckLine, group: string) => void }) {
  const [open, setOpen] = useState(true);
  const worst = groupSeverity(group);
  const total = group.lines.length;
  const okCount = severityCount(group.lines, "ok");

  return (
    <div className="border-b border-border-subtle/50 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-bg-hover/30"
      >
        {open ? (
          <ChevronDown size={12} className="text-fg-faint flex-shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-fg-faint flex-shrink-0" />
        )}
        <SeverityIcon severity={worst} size={14} />
        <span className="flex-1 text-[12px] font-medium text-fg-default">
          {group.title}
        </span>
        <span className="text-[10px] text-fg-faint">
          {okCount}/{total}
        </span>
      </button>

      {open && (
        <div className="pb-1.5 pl-5">
          {group.lines.map((line, i) => (
            <LineItem key={i} line={line} groupTitle={group.title} onPin={onPin} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────

function DoctorPanel(_props: PanelProps) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chatNav = useChatNav();

  const handlePin = useCallback((line: CheckLine, groupTitle: string) => {
    const emoji = line.severity === "blocker" ? "🔴" : "⚠️";
    const msg = [
      `${emoji} Doctor found an issue in **${groupTitle}**:`,
      `> ${line.text}`,
      line.detail ? `> ${line.detail}` : "",
      "",
      "Please diagnose and fix this.",
    ].filter(Boolean).join("\n");
    chatNav.sendPrompt?.(msg);
  }, [chatNav]);

  const runCheck = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/check`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as DoctorReport;
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-run on mount
  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  return (
    <div className="flex h-full flex-col text-[12px]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm">🩺</span>
          <span className="text-[12px] font-medium text-fg-default">System Doctor</span>
        </div>
        <button
          type="button"
          onClick={runCheck}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-fg-muted hover:bg-bg-raised hover:text-fg-default disabled:opacity-40"
          title="Re-check"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          {loading ? "Checking…" : "Re-check"}
        </button>
      </div>

      {/* Loading state */}
      {loading && !report && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-fg-faint">
          <Loader2 size={20} className="animate-spin" />
          <span className="text-[11px]">Running diagnostics…</span>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="mx-3 mt-2 rounded border border-rose-700/50 bg-rose-950/30 px-3 py-2 text-[11px] text-rose-300">
          {error}
        </div>
      )}

      {/* Results */}
      {report && (
        <>
          {lineHoverStyles}
          <div className="flex-1 overflow-y-auto">
            {report.groups.map((group, i) => (
              <GroupSection key={i} group={group} onPin={handlePin} />
            ))}
          </div>

          {/* Summary bar */}
          <div className="flex items-center justify-between border-t border-border-subtle px-3 py-2 text-[10px]">
            <div className="flex items-center gap-3">
              {report.ok > 0 && (
                <span className="flex items-center gap-1 text-emerald-400">
                  <CheckCircle2 size={10} /> {report.ok}
                </span>
              )}
              {report.warning > 0 && (
                <span className="flex items-center gap-1 text-amber-400">
                  <AlertTriangle size={10} /> {report.warning}
                </span>
              )}
              {report.blocker > 0 && (
                <span className="flex items-center gap-1 text-rose-400">
                  <XCircle size={10} /> {report.blocker}
                </span>
              )}
            </div>
            <span className="text-fg-faint">
              {report.blocker > 0
                ? "Setup incomplete"
                : report.warning > 0
                  ? "Usable, with caveats"
                  : "Healthy ✓"}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ── Plugin exports ─────────────────────────────────────────────

const exports: PluginClientExports = {
  components: {
    DoctorPanel,
  },
};

export default exports;
