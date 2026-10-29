// ProjectHub plugin — side panel.
// Browse projects → issues. Design mirrors workboard ListView.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FolderKanban, ChevronDown, Loader2,
  CheckCircle2, AlertTriangle, ArrowLeft,
  ExternalLink, User, Clock,
} from "lucide-react";
import type { PanelProps, PluginClientExports } from "@tianshu-ai/plugin-sdk/client";

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
const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "*", label: "All" },
] as const;

// ── Panel ──
function ProjectHubPanel(_props: PanelProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [issuesTotal, setIssuesTotal] = useState(0);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("open");
  const [filterOpen, setFilterOpen] = useState(false);
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

  // ── Issue list view ──
  if (selectedProject) {
    const currentLabel = STATUS_OPTIONS.find((o) => o.value === statusFilter)?.label ?? statusFilter;
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
          <span className="font-medium text-fg-default truncate">{selectedProject.name}</span>
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
                {STATUS_OPTIONS.map((opt) => {
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

        {/* Issue list */}
        <div className="flex-1 overflow-y-auto px-2 py-1">
          {issuesLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={16} className="animate-spin text-fg-faint" />
            </div>
          ) : issues.length === 0 ? (
            <div className="text-xs italic text-fg-faint text-center py-8">
              No issues match the current filter.
            </div>
          ) : (
            issues.map((issue) => (
              <IssueRow key={issue.id} issue={issue} />
            ))
          )}
        </div>
      </div>
    );
  }

  // ── Project list view ──
  return (
    <div className="flex flex-col h-full text-sm">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle">
        <FolderKanban size={14} className="text-accent" />
        <span className="font-medium text-fg-default">Projects</span>
        <span className="ml-auto text-[10px] text-fg-fainter">{projects.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={16} className="animate-spin text-fg-faint" />
          </div>
        ) : error ? (
          error.toLowerCase().includes("not configured") ? (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <FolderKanban size={28} className="text-fg-fainter" />
              <div className="text-sm text-fg-muted">Connect a project tracker</div>
              <div className="text-xs text-fg-faint leading-relaxed max-w-[220px]">
                Open <span className="font-medium text-fg-muted">Settings → ProjectHub</span> to configure your Redmine, Jira, or other project management tool.
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-4 text-rose-400 text-xs">
              <AlertTriangle size={14} />
              <span>{error}</span>
            </div>
          )
        ) : projects.length === 0 ? (
          <div className="text-xs italic text-fg-faint text-center py-8">
            No projects found. Check plugin configuration.
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

// ── Plugin exports ──
const exports: PluginClientExports = {
  components: {
    ProjectHubPanel,
  },
};

export default exports;
