// ProjectHub plugin — side panel.
// Browse projects → issues. Design mirrors workboard ListView.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FolderKanban, ChevronDown, Loader2,
  CheckCircle2, AlertTriangle, ArrowLeft,
  ExternalLink, User, Clock, Key, RefreshCw,
  List, CalendarDays, ChevronLeft, ChevronRight,
} from "lucide-react";
import type { PanelProps, PluginClientExports } from "@tianshu-ai/plugin-sdk/client";
import { subscribeToWsEvent } from "@tianshu-ai/plugin-sdk/client";
import { t, useLocaleRefresh } from "./i18n.js";

const API = "/api/p/projecthub";

interface Project {
  id: string | number;
  identifier: string;
  name: string;
  description: string;
}

interface Issue {
  id: string | number;
  webUrl: string;
  project: { id: string | number; name: string };
  tracker?: string;
  status: string;
  priority?: string;
  subject: string;
  assignee?: string;
  updatedAt?: string;
  dueDate?: string;
  startDate?: string;
  doneRatio?: number;
}

// ── Status icon (mirrors workboard) ──
function IssueStatusIcon({ status }: { status: string }) {
  const l = status.toLowerCase();
  if (l === "closed" || l === "resolved" || l === "rejected")
    return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />;
  if (l === "in progress" || l === "in_progress" || l === "进行中")
    return (
      <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
        <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
      </span>
    );
  if (l === "feedback" || l === "反馈")
    return <AlertTriangle className="w-3.5 h-3.5 text-purple-400 shrink-0" />;
  // new / open / default
  return (
    <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
      <span className="w-2 h-2 rounded-full border border-fg-faint" />
    </span>
  );
}

// ── Priority → left border color ──
function priorityBorder(p?: string): string {
  if (!p) return "pl-3";
  const l = p.toLowerCase();
  if (l === "urgent" || l === "immediate" || l === "紧急") return "border-l-2 border-l-danger pl-2.5";
  if (l === "high" || l === "高") return "border-l-2 border-l-warning pl-2.5";
  if (l === "low" || l === "低") return "border-l-2 border-l-accent pl-2.5";
  return "pl-3";
}

// ── Status chip color (theme-aware via CSS variables) ──
function statusChip(s: string): string {
  const l = s.toLowerCase();
  if (l === "closed" || l === "resolved" || l === "已解决" || l === "已关闭" || l === "rejected")
    return "bg-success/20 text-success";
  if (l === "in progress" || l === "in_progress" || l === "进行中")
    return "bg-warning/20 text-warning";
  if (l === "feedback" || l === "反馈")
    return "bg-accent/20 text-accent";
  if (l === "new" || l === "新建" || l === "open")
    return "bg-link/15 text-link";
  return "bg-bg-raised text-fg-muted";
}

function isDone(s: string): boolean {
  const l = s.toLowerCase();
  return l === "closed" || l === "resolved" || l === "已解决" || l === "已关闭" || l === "rejected";
}

// ── Time ago helper ──
function timeAgo(dateStr?: string): string {
  if (!dateStr) return "";
  const sec = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

// ── Status filter options ──
function getStatusOptions() {
  return [
    { value: "open", label: t("filter.open") },
    { value: "closed", label: t("filter.closed") },
    { value: "*", label: t("filter.all") },
  ];
}

// ── Panel ──
// ── User connection setup (inline in panel) ──
function ConnectionSetup({ onConnected }: { onConnected: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);


  const save = async () => {
    if (!apiKey) return;
    setSaving(true); setErr(null);
    try {
      const res = await fetch(`${API}/connection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ apiKey }),
      });
      const data = await res.json();
      if (data.ok) { onConnected(); }
      else { setErr(data.error || "保存失败"); }
    } catch (e: any) { setErr(e.message); }
    setSaving(false);
  };

  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8">
      <FolderKanban size={28} className="text-fg-fainter" />
      <div className="text-sm text-fg-muted font-medium">{t("notConfigured.title")}</div>
      <div className="text-xs text-fg-faint text-center leading-relaxed max-w-[240px]">
        输入你的项目追踪器 API Key 来连接。服务器地址由管理员配置。
      </div>
      <div className="w-full max-w-[260px] space-y-2 mt-1">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="API Key"
          autoComplete="off"
          data-1p-ignore
          onKeyDown={(e) => e.key === "Enter" && save()}
          className="w-full rounded-lg border border-border-default bg-bg-base px-3 py-1.5 text-xs text-fg-default placeholder:text-fg-faint focus:border-accent focus:outline-none"
        />
        <button
          onClick={save}
          disabled={saving || !apiKey}
          className="w-full rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50"
        >
          {saving ? "连接中..." : "保存并连接"}
        </button>
        {err && <div className="text-xs text-rose-400">{err}</div>}
      </div>
    </div>
  );
}

function ProjectHubPanel(_props: PanelProps) {
  useLocaleRefresh();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);

  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [issuesTotal, setIssuesTotal] = useState(0);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("open");
  const [viewMode, setViewMode] = useState<"list" | "calendar">("list");
  const [filterOpen, setFilterOpen] = useState(false);
  const [calMonth, setCalMonth] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [calSelected, setCalSelected] = useState(() => new Date());
  const filterRef = useRef<HTMLDivElement | null>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!filterOpen) return;
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node))
        setFilterOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [filterOpen]);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/projects`, { credentials: "include" });
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      setProjects(data.projects ?? []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  const loadIssues = useCallback(async (projectId: string, status: string) => {
    setIssuesLoading(true);
    try {
      const params = new URLSearchParams({ projectId, status, limit: "50" });
      const res = await fetch(`${API}/issues?${params}`, { credentials: "include" });
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      setIssues(data.issues ?? []);
      setIssuesTotal(data.total ?? 0);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIssuesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedProject) {
      loadIssues(String(selectedProject.identifier || selectedProject.id), statusFilter);
    }
  }, [selectedProject, statusFilter, loadIssues]);

  // Auto-refresh when issues/projects change (WS broadcast from tools)
  useEffect(() => {
    const unsub = subscribeToWsEvent("projecthub:changed", () => {
      if (selectedProject) {
        loadIssues(String(selectedProject.identifier || selectedProject.id), statusFilter);
      } else {
        loadProjects();
      }
    });
    return unsub;
  }, [selectedProject, statusFilter, loadIssues, loadProjects]);

  // ── Issue list view ──
  if (selectedProject) {
    const statusOptions = getStatusOptions();
    const currentLabel = statusOptions.find((o) => o.value === statusFilter)?.label ?? statusFilter;
    return (
      <div className="flex flex-col h-full text-sm">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle">
          <button
            onClick={() => { setSelectedProject(null); setIssues([]); }}
            className="p-1 rounded hover:bg-bg-raised transition-colors"
          >
            <ArrowLeft size={14} className="text-fg-muted" />
          </button>
          <FolderKanban size={14} className="text-accent shrink-0" />
          <span className="font-medium text-fg-default truncate flex-1">{selectedProject.name}</span>
          <div className="flex items-center gap-0.5 rounded-md bg-bg-raised p-0.5">
            <button
              onClick={() => setViewMode("list")}
              className={`p-1 rounded transition-colors ${viewMode === "list" ? "bg-bg-surface text-accent shadow-sm" : "text-fg-faint hover:text-fg-muted"}`}
              title="List"
            >
              <List size={13} />
            </button>
            <button
              onClick={() => setViewMode("calendar")}
              className={`p-1 rounded transition-colors ${viewMode === "calendar" ? "bg-bg-surface text-accent shadow-sm" : "text-fg-faint hover:text-fg-muted"}`}
              title="Calendar"
            >
              <CalendarDays size={13} />
            </button>
          </div>
          <button
            onClick={() => loadIssues(String(selectedProject.identifier || selectedProject.id), statusFilter)}
            className="p-1 rounded hover:bg-bg-raised transition-colors"
            title="Refresh"
          >
            <RefreshCw size={13} className={`text-fg-muted ${issuesLoading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Filter bar (workboard style) */}
        <div className="px-3 py-2 border-b border-border-subtle flex items-center gap-2">
          <div className="relative" ref={filterRef}>
            <button
              type="button"
              onClick={() => setFilterOpen((v) => !v)}
              className="flex items-center gap-1.5 rounded-md bg-bg-raised px-2.5 py-1.5 text-xs text-fg-muted hover:text-fg-default transition-colors"
            >
              <span className="font-medium">{currentLabel}</span>
              <span className="text-fg-fainter">{issuesTotal}</span>
              <ChevronDown className={`w-3 h-3 transition-transform ${filterOpen ? "rotate-180" : ""}`} />
            </button>
            {filterOpen && (
              <div className="absolute z-20 mt-1 rounded-lg border border-border-subtle bg-bg-surface shadow-lg py-1 min-w-[140px]">
                {statusOptions.map((opt) => {
                  const active = statusFilter === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => { setStatusFilter(opt.value); setFilterOpen(false); }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-bg-raised transition-colors"
                    >
                      <span className={`w-3.5 h-3.5 flex items-center justify-center rounded border ${
                        active ? "border-accent bg-accent text-white" : "border-fg-faint"
                      }`}>
                        {active && <CheckCircle2 className="w-2.5 h-2.5" />}
                      </span>
                      <span className={active ? "text-fg-default font-medium" : "text-fg-muted"}>
                        {opt.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Issue list or calendar */}
        {viewMode === "calendar" ? (
          <IssueCalendar
            issues={issues}
            loading={issuesLoading}
            month={calMonth}
            setMonth={setCalMonth}
            selected={calSelected}
            setSelected={setCalSelected}
          />
        ) : (
          <div className="flex-1 overflow-y-auto px-2 py-1">
            {issuesLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 size={16} className="animate-spin text-fg-faint" />
              </div>
            ) : issues.length === 0 ? (
              <div className="text-xs italic text-fg-faint text-center py-8">
                {t("noIssues")}
              </div>
            ) : (
              issues.map((issue) => (
                <IssueRow key={issue.id} issue={issue} />
              ))
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Project list view ──
  return (
    <div className="flex flex-col h-full text-sm">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle">
        <FolderKanban size={14} className="text-accent" />
        <span className="font-medium text-fg-default">{t("projects")}</span>
        <span className="ml-auto text-[10px] text-fg-fainter">{projects.length}</span>
        <button
          onClick={() => loadProjects()}
          className="p-1 rounded hover:bg-bg-raised transition-colors"
          title="Refresh"
        >
          <RefreshCw size={13} className={`text-fg-muted ${loading ? "animate-spin" : ""}`} />
        </button>
        <button
          onClick={() => setShowSetup(true)}
          className="p-0.5 text-fg-faint hover:text-fg-muted"
          title="连接设置"
        >
          <Key size={13} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={16} className="animate-spin text-fg-faint" />
          </div>
        ) : error ? (
          error.toLowerCase().includes("not configured") || showSetup ? (
            <ConnectionSetup onConnected={() => { setShowSetup(false); loadProjects(); }} />
          ) : (
            <div className="flex items-center gap-2 px-3 py-4 text-rose-400 text-xs">
              <AlertTriangle size={14} />
              <span>{error}</span>
            </div>
          )
        ) : projects.length === 0 ? (
          <div className="text-xs italic text-fg-faint text-center py-8">
            {t("noProjects")}
          </div>
        ) : (
          projects.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedProject(p)}
              className="group rounded-lg py-2.5 px-3 mx-1 mb-0.5 w-[calc(100%-0.5rem)] text-left cursor-pointer transition-colors hover:bg-bg-raised flex items-start gap-2"
            >
              <FolderKanban size={14} className="text-fg-faint shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-fg-default leading-snug truncate">
                  {p.name}
                </div>
                {p.description && (
                  <div className="text-[11px] text-fg-faint leading-snug mt-0.5 line-clamp-2">
                    {p.description}
                  </div>
                )}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ── Issue row (mirrors workboard ListRow) ──
function IssueRow({ issue }: { issue: Issue }) {
  return (
    <div className="group border-b border-border-subtle/40 last:border-b-0">
      <div
        className={`rounded-lg py-1.5 pr-3 mx-1 mb-px transition-colors hover:bg-bg-raised ${priorityBorder(issue.priority)}`}
      >
        {/* Line 1: status icon + title + external link */}
        <div className="flex items-center gap-1.5">
          <IssueStatusIcon status={issue.status} />
          <span className={`flex-1 min-w-0 text-[13px] font-medium leading-snug truncate ${
            isDone(issue.status) ? "text-fg-faint line-through decoration-fg-fainter" : "text-fg-default"
          }`}>
            {issue.subject}
          </span>
          {issue.webUrl && (
            <a
              href={issue.webUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity text-fg-fainter hover:text-fg-muted"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink size={12} />
            </a>
          )}
        </div>

        {/* Line 2: metadata */}
        <div className="flex items-center gap-1.5 mt-0.5 ml-5 text-[11px] leading-none">
          <span className="font-mono text-fg-fainter">#{String(issue.id)}</span>
          <span className={`px-1.5 py-0.5 rounded font-medium ${statusChip(issue.status)}`}>{issue.status}</span>
          {issue.assignee && (
            <span className="flex items-center gap-0.5 text-fg-faint">
              <User size={10} />
              {issue.assignee}
            </span>
          )}
          {issue.updatedAt && (
            <span className="flex items-center gap-0.5 ml-auto text-fg-fainter">
              <Clock size={10} />
              {timeAgo(issue.updatedAt)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Calendar helpers ──
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function sameDayYMD(d: Date, y: number, m: number, day: number) {
  return d.getFullYear() === y && d.getMonth() === m && d.getDate() === day;
}
function dayKey(d: Date) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

// ── Color palette for multi-day event bars ──
// Use inline style colors for theme-agnostic rendering (classical/light/dark all work)
const BAR_COLORS = [
  { bg: "rgba(59,130,246,0.25)",  text: "#2563eb", border: "#3b82f6" },  // blue
  { bg: "rgba(16,185,129,0.25)",  text: "#059669", border: "#10b981" },  // emerald
  { bg: "rgba(245,158,11,0.25)",  text: "#d97706", border: "#f59e0b" },  // amber
  { bg: "rgba(139,92,246,0.25)",  text: "#7c3aed", border: "#8b5cf6" },  // purple
  { bg: "rgba(244,63,94,0.25)",   text: "#e11d48", border: "#f43f5e" },  // rose
  { bg: "rgba(6,182,212,0.25)",   text: "#0891b2", border: "#06b6d4" },  // cyan
  { bg: "rgba(249,115,22,0.25)",  text: "#ea580c", border: "#f97316" },  // orange
];

const DONE_COLOR = { bg: "rgba(156,163,175,0.15)", text: "#9ca3af", border: "#9ca3af" };

function issueColor(issue: Issue, idx: number) {
  const l = issue.status.toLowerCase();
  if (l === "closed" || l === "resolved" || l === "已解决" || l === "已关闭" || l === "rejected")
    return DONE_COLOR;
  return BAR_COLORS[idx % BAR_COLORS.length];
}

interface CellDate {
  date: Date;
  day: number;
  inMonth: boolean; // belongs to current month
}

/** Build 6-row × 7-col grid with prev/next month padding (Outlook style) */
function buildMonthGrid(y: number, m: number): CellDate[] {
  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const daysInPrev = new Date(y, m, 0).getDate();
  const cells: CellDate[] = [];
  // prev month padding
  for (let i = firstDow - 1; i >= 0; i--) {
    const d = daysInPrev - i;
    cells.push({ date: new Date(y, m - 1, d), day: d, inMonth: false });
  }
  // current month
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(y, m, d), day: d, inMonth: true });
  }
  // next month padding — fill to 6 rows (42 cells) or 5 rows if fits
  const targetRows = cells.length > 35 ? 6 : Math.max(5, Math.ceil(cells.length / 7));
  let nextDay = 1;
  while (cells.length < targetRows * 7) {
    cells.push({ date: new Date(y, m + 1, nextDay), day: nextDay, inMonth: false });
    nextDay++;
  }
  return cells;
}

/** Position data for a multi-day event bar in a single week row */
interface BarSegment {
  issue: Issue;
  colorIdx: number;
  startCol: number; // 0-6 column in this week row
  span: number;     // how many columns it spans
  row: number;      // stacking row (0, 1, 2...)
  continues: boolean; // bar continues from previous week
  continuesAfter: boolean; // bar continues into next week
}

// Parse "YYYY-MM-DD" as local date (not UTC)
function parseLocalDate(s: string): Date {
  const [yy, mm, dd] = s.split(/[-T]/).map(Number);
  return new Date(yy, (mm || 1) - 1, dd || 1);
}

/** Get effective start/end dates for an issue */
function issueRange(iss: Issue): { start: Date; end: Date } | null {
  const s = iss.startDate ? parseLocalDate(iss.startDate) : null;
  const e = iss.dueDate ? parseLocalDate(iss.dueDate) : null;
  if (s && e) return { start: s, end: e };
  if (s) return { start: s, end: s };
  if (e) return { start: e, end: e };
  if (iss.updatedAt) { const d = new Date(iss.updatedAt); return { start: d, end: d }; }
  return null;
}

/** Compute bar segments for one week row */
function computeBarSegments(
  issues: Issue[],
  weekCells: CellDate[],
  maxBars: number,
  colorMap: Map<string | number, number>,
): { bars: BarSegment[]; overflowByCol: number[] } {
  const weekStart = weekCells[0].date;
  const weekEnd = weekCells[6].date;
  const bars: BarSegment[] = [];
  const overflowByCol = new Array(7).fill(0);
  // Track which rows are occupied per column
  const occupied: boolean[][] = []; // [row][col]

  // Sort issues: longer spans first, then by start date
  const candidates = issues
    .map((iss) => ({ iss, range: issueRange(iss) }))
    .filter((c) => {
      if (!c.range) return false;
      return c.range.start <= weekEnd && c.range.end >= weekStart;
    })
    .sort((a, b) => {
      const aLen = a.range!.end.getTime() - a.range!.start.getTime();
      const bLen = b.range!.end.getTime() - b.range!.start.getTime();
      if (bLen !== aLen) return bLen - aLen; // longer first
      return a.range!.start.getTime() - b.range!.start.getTime();
    });

  for (const { iss, range } of candidates) {
    if (!range) continue;
    const clampedStart = range.start < weekStart ? weekStart : range.start;
    const clampedEnd = range.end > weekEnd ? weekEnd : range.end;
    const startCol = Math.round((clampedStart.getTime() - weekStart.getTime()) / 86400000);
    const endCol = Math.round((clampedEnd.getTime() - weekStart.getTime()) / 86400000);
    const span = endCol - startCol + 1;

    // Find first available row
    let barRow = -1;
    for (let r = 0; r < maxBars; r++) {
      if (!occupied[r]) occupied[r] = new Array(7).fill(false);
      let fits = true;
      for (let c = startCol; c <= endCol; c++) {
        if (occupied[r][c]) { fits = false; break; }
      }
      if (fits) { barRow = r; break; }
    }

    if (barRow === -1) {
      // overflow
      for (let c = startCol; c <= endCol; c++) overflowByCol[c]++;
      continue;
    }

    // Mark occupied
    for (let c = startCol; c <= endCol; c++) occupied[barRow][c] = true;

    bars.push({
      issue: iss,
      colorIdx: colorMap.get(iss.id) ?? 0,
      startCol,
      span,
      row: barRow,
      continues: range.start < weekStart,
      continuesAfter: range.end > weekEnd,
    });
  }
  return { bars, overflowByCol };
}

// ── Issue Calendar View ──
function IssueCalendar({
  issues, loading, month, setMonth, selected, setSelected,
}: {
  issues: Issue[];
  loading: boolean;
  month: Date;
  setMonth: (d: Date) => void;
  selected: Date;
  setSelected: (d: Date) => void;
}) {
  const [calView, setCalView] = useState<"year" | "month">("month");
  const [popoverDay, setPopoverDay] = useState<Date | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const y = month.getFullYear();
  const m = month.getMonth();
  const today = new Date();

  // Close popover on outside click
  useEffect(() => {
    if (!popoverDay) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node))
        setPopoverDay(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [popoverDay]);

  const issuesForDate = useCallback(
    (date: Date): Issue[] => {
      const dy = date.getFullYear(), dm = date.getMonth(), dd = date.getDate();
      return issues.filter((iss) => {
        const range = issueRange(iss);
        if (!range) return false;
        const { start, end } = range;
        const afterStart = dy > start.getFullYear() || (dy === start.getFullYear() && (dm > start.getMonth() || (dm === start.getMonth() && dd >= start.getDate())));
        const beforeEnd = dy < end.getFullYear() || (dy === end.getFullYear() && (dm < end.getMonth() || (dm === end.getMonth() && dd <= end.getDate())));
        return afterStart && beforeEnd;
      });
    },
    [issues],
  );

  const issuesForMonth = useCallback(
    (yr: number, mo: number): number => {
      return issues.filter((iss) => {
        const range = issueRange(iss);
        if (!range) return false;
        const { start, end } = range;
        const moStart = new Date(yr, mo, 1);
        const moEnd = new Date(yr, mo + 1, 0);
        return start <= moEnd && end >= moStart;
      }).length;
    },
    [issues],
  );

  // Stable color assignment per issue
  const colorMap = useMemo(() => {
    const map = new Map<string | number, number>();
    issues.forEach((iss, i) => map.set(iss.id, i));
    return map;
  }, [issues]);

  // ── View switcher tabs ──
  const ViewTabs = () => (
    <div className="flex items-center gap-0.5 rounded-md bg-bg-raised p-0.5 text-[10px]">
      {(["year", "month"] as const).map((v) => (
        <button
          key={v}
          onClick={() => setCalView(v)}
          className={`px-2 py-0.5 rounded transition-colors capitalize ${
            calView === v ? "bg-bg-surface text-accent shadow-sm font-medium" : "text-fg-faint hover:text-fg-muted"
          }`}
        >
          {v === "year" ? "年" : "月"}
        </button>
      ))}
    </div>
  );

  // ── Year View: 12 month mini cards ──
  if (calView === "year") {
    return (
      <div className="flex flex-col flex-1 overflow-hidden">
        <div className="mx-3 mt-2 px-3 pt-2 pb-2 bg-bg-elevated rounded-lg shrink-0">
          <div className="flex justify-center mb-2"><ViewTabs /></div>
          <div className="flex items-center justify-between mb-2">
            <button onClick={() => setMonth(new Date(y - 1, m, 1))} className="p-1 rounded hover:bg-bg-hover text-fg-faint"><ChevronLeft size={14} /></button>
            <span className="text-xs font-medium text-fg-muted">{y}</span>
            <button onClick={() => setMonth(new Date(y + 1, m, 1))} className="p-1 rounded hover:bg-bg-hover text-fg-faint"><ChevronRight size={14} /></button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: 12 }, (_, mo) => {
              const isCurrent = today.getFullYear() === y && today.getMonth() === mo;
              const isSel = m === mo;
              const count = issuesForMonth(y, mo);
              return (
                <button
                  key={mo}
                  onClick={() => { setMonth(new Date(y, mo, 1)); setCalView("month"); }}
                  className={`rounded-md px-2 py-2 text-xs text-left transition-colors relative ${
                    isSel ? "bg-accent/15 text-accent font-medium" : isCurrent ? "ring-1 ring-accent/40 text-fg-default" : "text-fg-muted hover:bg-bg-hover"
                  }`}
                >
                  {new Date(y, mo, 1).toLocaleString(undefined, { month: "short" })}
                  {count > 0 && (
                    <span className="absolute top-1 right-1.5 text-[9px] font-medium text-accent">{count}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // ── Month View (Outlook style): full-height grid with multi-day bars ──
  const cells = buildMonthGrid(y, m);
  const numRows = cells.length / 7;
  const MAX_BARS = 2; // max event bars per day cell

  // Precompute week rows and their bar segments
  const weekRows = useMemo(() => {
    const rows: { cells: CellDate[]; bars: BarSegment[]; overflowByCol: number[] }[] = [];
    for (let r = 0; r < numRows; r++) {
      const weekCells = cells.slice(r * 7, r * 7 + 7);
      const { bars, overflowByCol } = computeBarSegments(issues, weekCells, MAX_BARS, colorMap);
      rows.push({ cells: weekCells, bars, overflowByCol });
    }
    return rows;
  }, [cells, numRows, issues, colorMap]);

  // Popover issues
  const popoverIssues = useMemo(
    () => popoverDay ? issuesForDate(popoverDay) : [],
    [popoverDay, issuesForDate],
  );

  // Height of the bar area in each cell: date number area + bars * barH
  const BAR_H = 22; // height of each event bar
  const DATE_AREA = 28; // space for the date number
  const barAreaHeight = MAX_BARS * BAR_H;

  return (
    <div className="flex flex-col flex-1 overflow-hidden relative">
      {/* Calendar header */}
      <div className="px-3 pt-2 pb-1 shrink-0">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-1">
            <button onClick={() => setMonth(new Date(y, m - 1, 1))} className="p-1 rounded hover:bg-bg-raised text-fg-faint hover:text-fg-default transition-colors"><ChevronLeft size={14} /></button>
            <button onClick={() => setMonth(new Date(y, m + 1, 1))} className="p-1 rounded hover:bg-bg-raised text-fg-faint hover:text-fg-default transition-colors"><ChevronRight size={14} /></button>
            <button
              onClick={() => setCalView("year")}
              className="text-sm font-semibold text-fg-default hover:text-accent transition-colors ml-1"
            >
              {new Date(y, m, 1).toLocaleString(undefined, { month: "long", year: "numeric" })}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { const n = new Date(); setMonth(new Date(n.getFullYear(), n.getMonth(), 1)); setSelected(n); }}
              className="text-[10px] px-2 py-0.5 rounded-md border border-border-subtle text-fg-muted hover:text-fg-default hover:bg-bg-raised transition-colors"
            >
              {t("filter.today") || "Today"}
            </button>
            <ViewTabs />
          </div>
        </div>
      </div>

      {/* Day headers — single letter, Outlook style */}
      <div className="grid grid-cols-7 px-3 shrink-0">
        {DAY_LETTERS.map((d, i) => (
          <div key={i} className={`text-center text-xs font-medium py-1.5 ${
            i === 0 || i === 6 ? "text-fg-fainter" : "text-fg-muted"
          }`}>{d}</div>
        ))}
      </div>

      {/* Grid — stretches to fill available height */}
      <div className="flex-1 grid px-3 pb-2 overflow-hidden" style={{ gridTemplateRows: `repeat(${numRows}, 1fr)` }}>
        {weekRows.map((week, rowIdx) => (
          <div key={rowIdx} className="grid grid-cols-7 border-t border-border-subtle/40 relative" style={{ minHeight: 0 }}>
            {/* Day cells */}
            {week.cells.map((cell, colIdx) => {
              const isSel = sameDay(selected, cell.date);
              const isToday_ = sameDayYMD(today, cell.date.getFullYear(), cell.date.getMonth(), cell.date.getDate());
              const isWeekend = colIdx === 0 || colIdx === 6;
              const overflow = week.overflowByCol[colIdx];
              const isPopoverTarget = popoverDay && sameDay(popoverDay, cell.date);
              return (
                <button
                  key={colIdx}
                  onClick={() => {
                    setSelected(cell.date);
                    if (!cell.inMonth) setMonth(new Date(cell.date.getFullYear(), cell.date.getMonth(), 1));
                    // toggle popover
                    const dayIssues = issuesForDate(cell.date);
                    if (dayIssues.length > 0) {
                      setPopoverDay(isPopoverTarget ? null : cell.date);
                    } else {
                      setPopoverDay(null);
                    }
                  }}
                  className={`relative w-full text-left transition-colors flex flex-col overflow-hidden ${
                    !cell.inMonth ? "bg-bg-base/50" : isWeekend ? "bg-bg-base/30" : ""
                  } ${
                    isSel && !isPopoverTarget ? "bg-accent/5" : "hover:bg-bg-raised/60"
                  }`}
                  style={{ minHeight: 0 }}
                >
                  {/* Date number — Outlook style */}
                  <div className="flex justify-end px-1.5 pt-1">
                    {isToday_ ? (
                      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-accent text-fg-on-accent text-[13px] font-semibold">
                        {cell.day}
                      </span>
                    ) : isSel ? (
                      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full ring-1.5 ring-accent text-accent text-[13px] font-semibold">
                        {cell.day}
                      </span>
                    ) : (
                      <span className={`text-[13px] px-0.5 py-0.5 ${
                        cell.inMonth ? (isWeekend ? "text-fg-faint" : "text-fg-default") : "text-fg-fainter"
                      }`}>
                        {cell.day}
                      </span>
                    )}
                  </div>
                  {/* Spacer for bars (bars are positioned absolutely in the row) */}
                  <div style={{ height: barAreaHeight }} />
                  {/* Overflow indicator */}
                  {overflow > 0 && (
                    <span className="text-[11px] text-fg-faint px-1.5 leading-none">+{overflow}</span>
                  )}
                </button>
              );
            })}

            {/* Multi-day event bars — absolutely positioned over the week row */}
            {week.bars.map((bar, barIdx) => {
              const col = issueColor(bar.issue, bar.colorIdx);
              const topOffset = DATE_AREA + bar.row * BAR_H;
              return (
                <div
                  key={`${bar.issue.id}-${barIdx}`}
                  className={`absolute h-[20px] flex items-center overflow-hidden text-[11px] font-medium leading-none
                    ${bar.continues ? "" : "rounded-l-[3px] ml-0.5"}
                    ${bar.continuesAfter ? "" : "rounded-r-[3px] mr-0.5"}
                    hover:brightness-110 cursor-default transition-[filter]
                  `}
                  style={{
                    top: topOffset,
                    left: `calc(${(bar.startCol / 7) * 100}% + ${bar.continues ? 0 : 1}px)`,
                    width: `calc(${(bar.span / 7) * 100}% - ${(bar.continues ? 0 : 1) + (bar.continuesAfter ? 0 : 1)}px)`,
                    zIndex: 5,
                    background: col.bg,
                    color: col.text,
                    borderLeftWidth: 3,
                    borderLeftColor: col.border,
                    borderLeftStyle: "solid",
                  }}
                  title={`${bar.issue.subject}${bar.issue.assignee ? ` · ${bar.issue.assignee}` : ""}${bar.issue.status ? ` [${bar.issue.status}]` : ""}`}
                >
                  {!bar.continues ? (
                    <span className="truncate px-1">
                      {bar.issue.subject}
                      {bar.issue.assignee && (
                        <span className="opacity-60 ml-1">· {bar.issue.assignee}</span>
                      )}
                    </span>
                  ) : (
                    <span className="truncate px-1 opacity-70">
                      ⋯ {bar.issue.subject}
                      {bar.issue.assignee && (
                        <span className="opacity-60 ml-1">· {bar.issue.assignee}</span>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Popover — issue list for clicked day (Outlook style) */}
      {popoverDay && popoverIssues.length > 0 && (
        <div
          ref={popoverRef}
          className="absolute z-30 left-4 right-4 bg-bg-surface border border-border-subtle rounded-lg shadow-xl overflow-hidden"
          style={{ bottom: 8, maxHeight: "45%" }}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle bg-bg-elevated">
            <span className="text-xs font-medium text-fg-default">
              {popoverDay.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
            </span>
            <span className="text-[10px] text-fg-fainter">
              {popoverIssues.length} issue{popoverIssues.length > 1 ? "s" : ""}
            </span>
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: "calc(100% - 36px)" }}>
            {popoverIssues.map((issue) => <IssueRow key={issue.id} issue={issue} />)}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Plugin exports ──
const exports: PluginClientExports = {
  components: {
    ProjectHubPanel,
  },
};

export default exports;
