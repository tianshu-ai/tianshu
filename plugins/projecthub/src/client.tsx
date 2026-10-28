// ProjectHub plugin — side panel.
// Shows projects and their issues from the configured tracker.

import { useCallback, useEffect, useState } from "react";
import {
  FolderKanban, ChevronRight, ChevronDown, Loader2,
  CircleDot, AlertCircle, CheckCircle2, ArrowLeft,
  ExternalLink,
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
}

// ── Status badge colors ──
function statusColor(s: string): string {
  const l = s.toLowerCase();
  if (l === "closed" || l === "resolved" || l === "rejected") return "text-emerald-400";
  if (l === "in progress" || l === "in_progress") return "text-blue-400";
  if (l === "new" || l === "open") return "text-yellow-400";
  return "text-fg-muted";
}

function StatusIcon({ status }: { status: string }) {
  const l = status.toLowerCase();
  if (l === "closed" || l === "resolved") return <CheckCircle2 size={12} className="text-emerald-400" />;
  if (l === "in progress" || l === "in_progress") return <Loader2 size={12} className="text-blue-400 animate-spin" />;
  return <CircleDot size={12} className={statusColor(status)} />;
}

function priorityBadge(p?: string): string {
  if (!p) return "";
  const l = p.toLowerCase();
  if (l === "urgent" || l === "immediate") return "bg-rose-900/60 text-rose-300";
  if (l === "high") return "bg-orange-900/60 text-orange-300";
  if (l === "low") return "bg-gray-700/60 text-gray-400";
  return "bg-gray-700/40 text-gray-400";
}

// ── Panel component ──
function ProjectHubPanel(_props: PanelProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Drill-down state
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [issuesTotal, setIssuesTotal] = useState(0);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("open");

  // Load projects
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

  // Load issues for selected project
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

  // When project or filter changes
  useEffect(() => {
    if (selectedProject) {
      loadIssues(String(selectedProject.identifier || selectedProject.id), statusFilter);
    }
  }, [selectedProject, statusFilter, loadIssues]);

  // ── Issue list view ──
  if (selectedProject) {
    return (
      <div className="flex flex-col h-full text-sm">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle">
          <button
            onClick={() => { setSelectedProject(null); setIssues([]); }}
            className="p-1 rounded hover:bg-bg-hover transition-colors"
          >
            <ArrowLeft size={14} />
          </button>
          <FolderKanban size={14} className="text-accent" />
          <span className="font-medium truncate">{selectedProject.name}</span>
          <span className="ml-auto text-[10px] text-fg-fainter">{issuesTotal} issues</span>
        </div>

        {/* Status filter */}
        <div className="flex gap-1 px-3 py-1.5 border-b border-border-subtle">
          {["open", "closed", "*"].map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                statusFilter === s
                  ? "bg-accent/20 text-accent font-medium"
                  : "text-fg-muted hover:bg-bg-hover"
              }`}
            >
              {s === "*" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        {/* Issue list */}
        <div className="flex-1 overflow-y-auto">
          {issuesLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={16} className="animate-spin text-fg-faint" />
            </div>
          ) : issues.length === 0 ? (
            <div className="py-8 text-center text-fg-faint text-xs">No issues found</div>
          ) : (
            issues.map((issue) => (
              <div
                key={issue.id}
                className="flex items-start gap-2 px-3 py-2 border-b border-border-subtle/50 hover:bg-bg-hover transition-colors group"
              >
                <StatusIcon status={issue.status} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-fg-fainter font-mono">#{String(issue.id)}</span>
                    {issue.tracker && (
                      <span className="text-[9px] px-1 rounded bg-bg-elevated text-fg-muted">{issue.tracker}</span>
                    )}
                    {issue.priority && priorityBadge(issue.priority) && (
                      <span className={`text-[9px] px-1 rounded ${priorityBadge(issue.priority)}`}>
                        {issue.priority}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-fg-default truncate mt-0.5">{issue.subject}</div>
                  <div className="flex items-center gap-2 mt-0.5 text-[10px] text-fg-fainter">
                    <span className={statusColor(issue.status)}>{issue.status}</span>
                    {issue.assignee && <span>→ {issue.assignee}</span>}
                    {issue.updatedAt && (
                      <span className="ml-auto">
                        {new Date(issue.updatedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
                {issue.webUrl && (
                  <a
                    href={issue.webUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ExternalLink size={11} className="text-fg-fainter" />
                  </a>
                )}
              </div>
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
        <span className="font-medium">Projects</span>
        <span className="ml-auto text-[10px] text-fg-fainter">{projects.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={16} className="animate-spin text-fg-faint" />
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 px-3 py-4 text-rose-400 text-xs">
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        ) : projects.length === 0 ? (
          <div className="py-8 text-center text-fg-faint text-xs">
            No projects found. Check plugin configuration.
          </div>
        ) : (
          projects.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedProject(p)}
              className="flex items-center gap-2 w-full px-3 py-2.5 text-left border-b border-border-subtle/50 hover:bg-bg-hover transition-colors group"
            >
              <FolderKanban size={13} className="text-fg-faint shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-fg-default truncate">{p.name}</div>
                {p.description && (
                  <div className="text-[10px] text-fg-fainter truncate mt-0.5">{p.description}</div>
                )}
              </div>
              <ChevronRight size={12} className="text-fg-fainter opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
            </button>
          ))
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
