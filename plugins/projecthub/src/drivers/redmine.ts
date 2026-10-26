/**
 * Redmine driver for ProjectHub.
 *
 * Docs: https://www.redmine.org/projects/redmine/wiki/Rest_api
 */
import type {
  TrackerDriver, DriverConfig, PHProject, PHIssue, PHIssueDetail,
  PHUser, PHJournal, ListIssuesOpts, CreateIssueOpts, UpdateIssueOpts,
} from "../types.js";

// ── HTTP helper ─────────────────────────────────────────────

async function api(cfg: DriverConfig, path: string, init: RequestInit = {}): Promise<any> {
  const url = cfg.baseUrl.replace(/\/+$/, "") + path;
  const headers: Record<string, string> = {
    "X-Redmine-API-Key": cfg.apiKey,
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> ?? {}),
  };
  const resp = await fetch(url, { ...init, headers });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Redmine ${resp.status}: ${text.slice(0, 500)}`);
  }
  const ct = resp.headers.get("content-type") ?? "";
  if (ct.includes("json")) return resp.json();
  return resp.text();
}

// ── Mappers ─────────────────────────────────────────────────

function mapIssue(r: any, baseUrl: string): PHIssue {
  return {
    id: r.id,
    webUrl: `${baseUrl.replace(/\/+$/, "")}/issues/${r.id}`,
    project: { id: r.project?.id, name: r.project?.name },
    tracker: r.tracker?.name,
    status: r.status?.name,
    priority: r.priority?.name,
    author: r.author?.name ?? "",
    assignee: r.assigned_to?.name,
    subject: r.subject,
    description: r.description ?? "",
    startDate: r.start_date,
    dueDate: r.due_date,
    doneRatio: r.done_ratio,
    createdAt: r.created_on,
    updatedAt: r.updated_on,
  };
}

function mapJournal(j: any): PHJournal {
  return { id: j.id, user: j.user?.name ?? "", notes: j.notes ?? "", createdAt: j.created_on };
}

// ── Driver ──────────────────────────────────────────────────

export class RedmineDriver implements TrackerDriver {
  readonly type = "redmine";
  constructor(private cfg: DriverConfig) {}

  async listProjects(opts?: { limit?: number }) {
    const params = new URLSearchParams();
    params.set("limit", String(opts?.limit ?? 100));
    const res = await api(this.cfg, `/projects.json?${params}`);
    return {
      projects: (res.projects ?? []).map((p: any): PHProject => ({
        id: p.id,
        identifier: p.identifier,
        name: p.name,
        description: p.description ?? "",
      })),
      total: res.total_count ?? 0,
    };
  }

  async listIssues(opts?: ListIssuesOpts) {
    const params = new URLSearchParams();
    const proj = opts?.projectId ?? this.cfg.defaultProject;
    if (proj) params.set("project_id", proj);
    if (opts?.status) params.set("status_id", opts.status);
    if (opts?.assignee) params.set("assigned_to_id", opts.assignee);
    if (opts?.trackerId) params.set("tracker_id", opts.trackerId);
    params.set("limit", String(opts?.limit ?? 25));
    if (opts?.offset) params.set("offset", String(opts.offset));
    if (opts?.sort) params.set("sort", opts.sort);
    const res = await api(this.cfg, `/issues.json?${params}`);
    return {
      issues: (res.issues ?? []).map((i: any) => mapIssue(i, this.cfg.baseUrl)),
      total: res.total_count ?? 0,
    };
  }

  async getIssue(id: string | number, includes?: string[]): Promise<PHIssueDetail> {
    const params = new URLSearchParams();
    if (includes?.length) params.set("include", includes.join(","));
    const qs = params.toString();
    const res = await api(this.cfg, `/issues/${id}.json${qs ? "?" + qs : ""}`);
    const r = res.issue;
    return {
      ...mapIssue(r, this.cfg.baseUrl),
      journals: (r.journals ?? []).map(mapJournal),
      children: (r.children ?? []).map((c: any) => ({
        id: c.id, subject: c.subject, status: c.tracker?.name ?? "",
      })),
    };
  }

  async createIssue(opts: CreateIssueOpts): Promise<PHIssue> {
    const body: Record<string, unknown> = {
      project_id: opts.projectId || this.cfg.defaultProject || "",
      subject: opts.subject,
    };
    if (opts.description) body.description = opts.description;
    if (opts.trackerId) body.tracker_id = Number(opts.trackerId);
    if (opts.priorityId) body.priority_id = Number(opts.priorityId);
    if (opts.assigneeId) body.assigned_to_id = Number(opts.assigneeId);
    if (opts.parentId) body.parent_issue_id = Number(opts.parentId);
    if (opts.startDate) body.start_date = opts.startDate;
    if (opts.dueDate) body.due_date = opts.dueDate;
    if (opts.estimatedHours) body.estimated_hours = opts.estimatedHours;
    const res = await api(this.cfg, "/issues.json", {
      method: "POST",
      body: JSON.stringify({ issue: body }),
    });
    return mapIssue(res.issue, this.cfg.baseUrl);
  }

  async updateIssue(id: string | number, opts: UpdateIssueOpts): Promise<void> {
    const body: Record<string, unknown> = {};
    if (opts.subject !== undefined) body.subject = opts.subject;
    if (opts.description !== undefined) body.description = opts.description;
    if (opts.statusId !== undefined) body.status_id = Number(opts.statusId);
    if (opts.priorityId !== undefined) body.priority_id = Number(opts.priorityId);
    if (opts.assigneeId !== undefined) body.assigned_to_id = Number(opts.assigneeId);
    if (opts.doneRatio !== undefined) body.done_ratio = opts.doneRatio;
    if (opts.dueDate !== undefined) body.due_date = opts.dueDate;
    if (opts.notes !== undefined) body.notes = opts.notes;
    await api(this.cfg, `/issues/${id}.json`, {
      method: "PUT",
      body: JSON.stringify({ issue: body }),
    });
  }

  async listUsers(opts?: { limit?: number }): Promise<PHUser[]> {
    const params = new URLSearchParams();
    params.set("limit", String(opts?.limit ?? 100));
    const res = await api(this.cfg, `/users.json?${params}`);
    return (res.users ?? []).map((u: any): PHUser => ({
      id: u.id, name: `${u.firstname} ${u.lastname}`.trim(), login: u.login, email: u.mail,
    }));
  }
}
