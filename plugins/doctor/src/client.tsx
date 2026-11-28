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
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useChatNav } from "@tianshu-ai/plugin-sdk/client";
import type { PanelProps, PluginClientExports } from "@tianshu-ai/plugin-sdk/client";
import { t, tText, tTitle, useLocaleRefresh } from "./i18n.js";

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

/** Mirrors the server's TenantAuditSummary. */
/** Mirrors the server's OversizedResult. One rule only: a read_file
 *  result past the character cap. */
interface SuspiciousResult {
  messageId: string;
  sessionId: string;
  sessionTitle?: string;
  sessionStatus?: string;
  turnNumber: number;
  createdAt: number;
  turnsBack: number;
  chars: number;
  bytesReturned?: number;
  fileSize?: number;
  filePath?: string;
}

interface TenantAuditSummary {
  tenantId: string;
  stalled: number;
  recovered: number;
  continued: number;
  /** Suspicious tool results in recent turns of live sessions. This
   *  is the proactive signal — the row will be replayed into the next
   *  turn's context whether or not the last turn survived it. */
  recentSuspicious: number;
  recentScanned?: { sessions: number; results: number; turns: number };
  recent?: SuspiciousResult[];
  error?: string;
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
      {/* Icon + hint label */}
      <span className="flex-shrink-0 flex items-center gap-1 mt-[3px]">
        {actionable ? (
          <>
            <span className="block group-icon">
              <SeverityIcon severity={line.severity} />
            </span>
            <span className="hidden group-icon-hover flex items-center gap-1">
              <MessageSquareWarning
                size={12}
                className={line.severity === "blocker" ? "text-rose-400" : "text-amber-400"}
              />
              <span className="text-xs text-fg-faint/80 whitespace-nowrap">{t("panel.fix")}</span>
            </span>
          </>
        ) : (
          <SeverityIcon severity={line.severity} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <span className="text-xs text-fg-default">{tText(line.text)}</span>
        {line.detail && (
          <div className="text-xs text-fg-faint truncate" title={actionable ? undefined : line.detail}>
            {line.detail}
          </div>
        )}
      </div>
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
        <span className="flex-1 text-xs font-medium text-fg-default">
          {tTitle(group.title)}
        </span>
        <span className="text-xs text-fg-faint">
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

// ── Tool-result audit section ─────────────────────────────────
//
// Per-tenant counts only. The full finding list lives behind the
// `audit_tool_results` agent tool; the panel's job is to show which
// tenant needs attention and hand the operator a ready-made prompt.

function AuditRow({
  summary,
  onPin,
}: {
  summary: TenantAuditSummary;
  onPin: (msg: string) => void;
}) {
  const recent = summary.recentSuspicious ?? 0;
  const stalled = summary.stalled;
  const bad = recent > 0 || stalled > 0;
  const severe = recent > 0;

  const icon = summary.error ? (
    <XCircle size={12} className="text-rose-400 flex-shrink-0" />
  ) : severe ? (
    <ShieldAlert size={12} className="text-rose-400 flex-shrink-0" />
  ) : stalled > 0 ? (
    <AlertTriangle size={12} className="text-amber-400 flex-shrink-0" />
  ) : (
    <CheckCircle2 size={12} className="text-emerald-400 flex-shrink-0" />
  );

  const buildPin = () => {
    const lines: string[] = [
      severe
        ? `🔴 ${t("audit.pinHeader")} **${summary.tenantId}**`
        : `⚠️ ${t("audit.pinHeader")} **${summary.tenantId}**`,
      "",
    ];
    if (recent > 0) {
      lines.push(t("audit.pinRecent", { recent }));
      if (summary.recentScanned) {
        lines.push(
          t("audit.pinScanned", {
            sessions: summary.recentScanned.sessions,
            results: summary.recentScanned.results,
            turns: summary.recentScanned.turns,
          }),
        );
      }
      const top = (summary.recent ?? [])[0];
      if (top) {
        lines.push(
          t("audit.pinTop", {
            chars: top.chars.toLocaleString(),
            file: top.filePath ?? "read_file",
          }),
        );
      }
      lines.push("");
    }
    if (stalled > 0) {
      lines.push(t("audit.pinStalled", { stalled }));
    }
    lines.push("");
    lines.push(t("audit.pinAction"));
    if (summary.recovered + summary.continued > 0) {
      lines.push("");
      lines.push(
        t("audit.pinOthers", {
          recovered: summary.recovered,
          continued: summary.continued,
        }),
      );
    }
    return lines.join("\n");
  };

  const clickable = bad && !summary.error;
  const fire = () => onPin(buildPin());

  return (
    <div
      className={[
        "flex items-start gap-2 px-3 py-1 rounded-md transition-colors",
        clickable ? "cursor-pointer hover:bg-white/[0.06]" : "",
      ].join(" ")}
      onClick={clickable ? fire : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") fire();
            }
          : undefined
      }
    >
      <span className="mt-[3px]">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-fg-default font-medium">
            {summary.tenantId}
          </span>
          {severe && (
            <span className="text-xs text-rose-400">
              {recent} {t("audit.suspicious")}
            </span>
          )}
          {!severe && stalled > 0 && (
            <span className="text-xs text-amber-400">
              {stalled} {t("audit.stalled")}
            </span>
          )}
          {!bad && !summary.error && (
            <span className="text-xs text-fg-faint">{t("audit.clean")}</span>
          )}
        </div>

        {summary.error ? (
          <div className="text-xs text-fg-faint truncate" title={summary.error}>
            {summary.error}
          </div>
        ) : (
          <>
            {severe && summary.recentScanned && (
              <div className="text-xs text-fg-faint">
                {t("audit.scannedLine", {
                  sessions: summary.recentScanned.sessions,
                  results: summary.recentScanned.results,
                })}
              </div>
            )}
            {severe && (summary.recent ?? []).slice(0, 2).map((r) => (
              <div
                key={r.messageId}
                className="text-xs text-fg-faint truncate"
                title={`turn ${r.turnNumber}${r.filePath ? " · " + r.filePath : ""}`}
              >
                {r.chars.toLocaleString()}c · {r.filePath ?? "read_file"}
              </div>
            ))}
            {!severe && summary.recovered + summary.continued > 0 && (
              <div className="text-xs text-fg-faint">
                {t("audit.others", {
                  recovered: summary.recovered,
                  continued: summary.continued,
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AuditSection({
  summaries,
  loading,
  error,
  onPin,
}: {
  summaries: TenantAuditSummary[];
  loading: boolean;
  error: string | null;
  onPin: (msg: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const totalStalled = summaries.reduce((n, s) => n + s.stalled, 0);
  const worst: Severity = totalStalled > 0 ? "blocker" : "ok";

  return (
    <div className="border-b border-border-subtle/50">
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
        {loading ? (
          <Loader2 size={14} className="animate-spin text-fg-faint flex-shrink-0" />
        ) : (
          <SeverityIcon severity={worst} size={14} />
        )}
        <span className="flex-1 text-xs font-medium text-fg-default">
          {t("audit.title")}
        </span>
        <span className="text-xs text-fg-faint">
          {summaries.length > 0
            ? totalStalled > 0
              ? `${totalStalled} ${t("audit.stalled")}`
              : t("audit.clean")
            : ""}
        </span>
      </button>

      {open && (
        <div className="pb-1.5 pl-2">
          {error && (
            <div className="mx-2 my-1 rounded border border-rose-700/50 bg-rose-950/30 px-2 py-1 text-xs text-rose-300">
              {error}
            </div>
          )}
          {!error && summaries.length === 0 && !loading && (
            <div className="px-3 py-1 text-xs text-fg-faint">
              {t("audit.none")}
            </div>
          )}
          {summaries.map((s) => (
            <AuditRow key={s.tenantId} summary={s} onPin={onPin} />
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
  const [audit, setAudit] = useState<TenantAuditSummary[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const chatNav = useChatNav();
  // Re-render when locale changes (language switch in UI)
  useLocaleRefresh();

  const handlePin = useCallback((line: CheckLine, groupTitle: string) => {
    const emoji = line.severity === "blocker" ? "🔴" : "⚠️";
    const msg = [
      `${emoji} ${t("pin.header")} **${tTitle(groupTitle)}**:`,
      `> ${tText(line.text)}`,
      line.detail ? `> ${line.detail}` : "",
      "",
      t("pin.footer"),
    ].filter(Boolean).join("\n");
    chatNav.sendPrompt?.(msg);
  }, [chatNav]);

  // Tool-result audit runs on its own track: it scans every tenant
  // database, which is slower than the doctor checks themselves, so a
  // failure or delay here must not block the rest of the panel.
  const runAudit = useCallback(async () => {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const res = await fetch(`${API_BASE}/audit?tenant=all`, {
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(body.message ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { tenants: TenantAuditSummary[] };
      setAudit(data.tenants ?? []);
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuditLoading(false);
    }
  }, []);

  const runCheck = useCallback(async () => {
    setLoading(true);
    setError(null);
    void runAudit();
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
  }, [runAudit]);

  // Auto-run on mount
  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  return (
    <div className="flex h-full flex-col text-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm">🩺</span>
          <span className="text-xs font-medium text-fg-default">{t("panel.title")}</span>
        </div>
        <button
          type="button"
          onClick={runCheck}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-fg-muted hover:bg-bg-raised hover:text-fg-default disabled:opacity-40"
          title={t("panel.recheckTitle")}
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          {loading ? t("panel.checking") : t("panel.recheck")}
        </button>
      </div>

      {/* Loading state */}
      {loading && !report && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-fg-faint">
          <Loader2 size={20} className="animate-spin" />
          <span className="text-xs">{t("panel.running")}</span>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="mx-3 mt-2 rounded border border-rose-700/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      )}

      {/* Results */}
      {report && (
        <>
          {lineHoverStyles}
          <div className="flex-1 overflow-y-auto">
            <AuditSection
              summaries={audit}
              loading={auditLoading}
              error={auditError}
              onPin={(msg) => chatNav.sendPrompt?.(msg)}
            />
            {report.groups.map((group, i) => (
              <GroupSection key={i} group={group} onPin={handlePin} />
            ))}
          </div>

          {/* Summary bar */}
          <div className="flex items-center justify-between border-t border-border-subtle px-3 py-2 text-xs">
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
                ? t("panel.incomplete")
                : report.warning > 0
                  ? t("panel.usable")
                  : t("panel.healthy")}
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
