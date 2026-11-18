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
function sameDay(d: Date, y: number, m: number, day: number) {
  return d.getFullYear() === y && d.getMonth() === m && d.getDate() === day;
}

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
  const y = month.getFullYear();
  const m = month.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const firstDow = new Date(y, m, 1).getDay();

  const cells: (number | null)[] = useMemo(() => {
    const out: (number | null)[] = [];
    for (let i = 0; i < firstDow; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(d);
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [firstDow, daysInMonth]);

  const issuesForDate = useCallback(
    (date: Date): Issue[] => {
      const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
      const dayEnd = dayStart + 86400000; // +1 day
      return issues.filter((iss) => {
        const start = iss.startDate ? new Date(iss.startDate).getTime() : null;
        const due = iss.dueDate ? new Date(iss.dueDate).getTime() + 86400000 : null; // inclusive
        // Has date range: show on all days within range
        if (start != null && due != null) return dayStart >= start && dayStart < due;
        if (start != null) return dayStart >= start; // open-ended: from start onwards
        if (due != null) return dayStart < due; // only due date: show on due day
        // No dates: fallback to updatedAt
        if (iss.updatedAt) {
          const u = new Date(iss.updatedAt);
          return sameDay(u, date.getFullYear(), date.getMonth(), date.getDate());
        }
        return false;
      });
    },
    [issues],
  );

  const today = new Date();
  const selectedIssues = useMemo(() => issuesForDate(selected), [issuesForDate, selected]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Month header */}
      <div className="mx-3 mt-2 px-3 pt-3 pb-2 bg-bg-elevated rounded-lg shrink-0">
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => setMonth(new Date(y, m - 1, 1))}
            className="p-1 rounded hover:bg-bg-hover text-fg-faint hover:text-fg-default"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            onClick={() => {
              const n = new Date();
              setSelected(n);
              setMonth(new Date(n.getFullYear(), n.getMonth(), 1));
            }}
            className="text-xs font-medium text-fg-muted hover:text-accent transition-colors"
          >
            {new Date(y, m, 1).toLocaleString(undefined, { month: "long", year: "numeric" })}
          </button>
          <button
            onClick={() => setMonth(new Date(y, m + 1, 1))}
            className="p-1 rounded hover:bg-bg-hover text-fg-faint hover:text-fg-default"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        <div className="grid grid-cols-7 mb-0.5">
          {SHORT_DAYS.map((d) => (
            <div key={d} className="text-center text-[10px] text-fg-fainter py-0.5">{d}</div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-0.5">
          {cells.map((day, i) => {
            if (day === null) return <div key={`e-${i}`} className="aspect-square" style={{ maxHeight: 40 }} />;
            const isSel = sameDay(selected, y, m, day);
            const isToday = sameDay(today, y, m, day);
            const date = new Date(y, m, day);
            const dayTs = date.getTime();
            const dayIssues = issuesForDate(date);
            // Count issues that span through this day (have start+due range)
            const spanning = dayIssues.filter(iss => iss.startDate && iss.dueDate).length;
            const pointOnly = dayIssues.length - spanning;
            return (
              <button
                key={day}
                onClick={() => setSelected(new Date(y, m, day))}
                style={{ maxHeight: 40 }}
                className={`aspect-square w-full text-xs relative transition-colors flex items-center justify-center ${
                  isSel
                    ? "bg-accent text-fg-on-accent font-semibold rounded-md"
                    : isToday
                      ? "text-accent font-semibold ring-1 ring-inset ring-accent/50 hover:bg-bg-hover rounded-md"
                      : "text-fg-muted hover:bg-bg-hover rounded-md"
                }`}
              >
                {day}
                {/* Spanning bar: shows range issues as a colored bar at bottom */}
                {spanning > 0 && (
                  <span className={`absolute bottom-0 left-0 right-0 h-1 ${
                    isSel ? "bg-fg-on-accent/60" : "bg-accent/40"
                  }`} />
                )}
                {/* Dot: shows point issues (no range) */}
                {pointOnly > 0 && spanning === 0 && (
                  <span className={`absolute bottom-0.5 left-1/2 -translate-x-1/2 flex items-center gap-0.5 ${
                    isSel ? "text-fg-on-accent" : ""
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${isSel ? "bg-fg-on-accent" : "bg-accent"}`} />
                  </span>
                )}
                {/* Count badge */}
                {dayIssues.length > 1 && (
                  <span className={`absolute top-0 right-0.5 text-[8px] leading-none font-bold ${isSel ? "text-fg-on-accent" : "text-accent"}`}>
                    {dayIssues.length}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected day agenda */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        <div className="px-2 py-1 text-[10px] text-fg-fainter">
          {selected.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          {selectedIssues.length > 0 && ` · ${selectedIssues.length} issue${selectedIssues.length > 1 ? "s" : ""}`}
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 size={14} className="animate-spin text-fg-faint" />
          </div>
        ) : selectedIssues.length === 0 ? (
          <div className="text-xs italic text-fg-faint text-center py-6">No issues on this day</div>
        ) : (
          selectedIssues.map((issue) => <IssueRow key={issue.id} issue={issue} />)
        )}
      </div>
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
