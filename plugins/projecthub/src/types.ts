/**
 * ProjectHub — unified project tracker abstraction.
 *
 * Every external system (Redmine, Jira, Linear, Leantime, …)
 * implements the TrackerDriver interface. Tools call through
 * the driver without knowing which backend is behind it.
 */

// ── Common entities ─────────────────────────────────────────

export interface PHProject {
  id: string | number;
  identifier: string;
  name: string;
  description: string;
}

export interface PHUser {
  id: string | number;
  name: string;
  login?: string;
  email?: string;
}

export interface PHIssue {
  id: string | number;
  webUrl: string;         // direct link to the issue in the tracker UI
  project: { id: string | number; name: string };
  tracker?: string;       // "Bug", "Feature", "Task", …
  status: string;
  priority: string;
  author: string;
  assignee?: string;
  subject: string;
  description: string;
  startDate?: string;
  dueDate?: string;
  doneRatio?: number;     // 0-100
  createdAt: string;
  updatedAt: string;
}

export interface PHIssueDetail extends PHIssue {
  journals?: PHJournal[];
  children?: Array<{ id: string | number; subject: string; status: string }>;
}

export interface PHJournal {
  id: string | number;
  user: string;
  notes: string;
  createdAt: string;
}

// ── Driver config ───────────────────────────────────────────

export interface DriverConfig {
  /** Driver type: "redmine" | "jira" | "leantime" | … */
  driver: string;
  /** Base URL of the tracker instance */
  baseUrl: string;
  /** API key or token */
  apiKey: string;
  /** Default project identifier */
  defaultProject?: string;
  /** Extra driver-specific options */
  extra?: Record<string, unknown>;
}

// ── Driver interface ────────────────────────────────────────

export interface ListIssuesOpts {
  projectId?: string;
  status?: string;        // "open", "closed", "*", or system-specific id
  assignee?: string;      // "me" or user id
  trackerId?: string;
  limit?: number;
  offset?: number;
  sort?: string;
}

export interface CreateIssueOpts {
  projectId: string;
  subject: string;
  description?: string;
  trackerId?: string;
  priorityId?: string;
  assigneeId?: string;
  parentId?: string;
  startDate?: string;
  dueDate?: string;
  estimatedHours?: number;
}

export interface UpdateIssueOpts {
  subject?: string;
  description?: string;
  statusId?: string;
  priorityId?: string;
  assigneeId?: string;
  doneRatio?: number;
  dueDate?: string;
  notes?: string;         // comment / journal
}

export interface TrackerDriver {
  readonly type: string;

  listProjects(opts?: { limit?: number }): Promise<{ projects: PHProject[]; total: number }>;
  listIssues(opts?: ListIssuesOpts): Promise<{ issues: PHIssue[]; total: number }>;
  getIssue(id: string | number, includes?: string[]): Promise<PHIssueDetail>;
  createIssue(opts: CreateIssueOpts): Promise<PHIssue>;
  updateIssue(id: string | number, opts: UpdateIssueOpts): Promise<void>;
  listUsers(opts?: { limit?: number }): Promise<PHUser[]>;
}
