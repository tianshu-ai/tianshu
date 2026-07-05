// Workboard plugin - client side.
//
// Right-column kanban panel inside the chat shell. 3 horizontal
// columns (todo / in-progress / done), sized for the narrow right
// rail. Add tasks inline (Todo column), drag across columns,
// dependency chips show 1f512 / 1f517 state.
//
// `WorkboardAdminPage` is kept in this file but NOT contributed via
// the manifest - it lived as a /admin/workboard/main page in earlier
// drafts; Yu asked to drop the admin surface for v0.2 because the
// right-rail panel covers everything the human needs. We keep the
// component so re-exposing it later is a one-line manifest change
// instead of re-deriving the full editor.
//
// Layout follows the closed-source Tianshu TaskBoard:
//   - 3 columns side-by-side, vertical scroll inside each column;
//   - project chips at the top (horizontal scroller), Inbox sticks
//     last so the user's named projects come first;
//   - per-column `+` button opens an inline title input; Enter submits;
//   - cards are draggable across columns (HTML5 dnd, optimistic move).
//
// Both surfaces hit /api/p/workboard/*.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Hammer,
  Kanban,
  Link2,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  ScrollText,
  Trash2,
  User,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import {
  useOpenFile,
  useUiPrimitives,
  type AdminPageProps,
  type PanelProps,
  type PluginClientExports,
  type SidebarSectionProps,
} from "@tianshu-ai/plugin-sdk/client";
import WorkerAgentsPage from "./worker-agents-page.js";

const API_BASE = "/api/p/workboard";

type TaskStatus = "ready" | "in_progress" | "done";


interface Task {
  id: string;
  title: string;
  description: string | null;
  project: string;
  workerRole: string | null;
  workerAgentId?: string | null;
  status: TaskStatus;
  priority: number;
  resultSummary: string | null;
  resultFiles: string[];
  sessionId: string | null;
  /** Task ids that must reach status='done' first. */
  dependsOn: string[];
  /** Free-form labels. The pool reserves three:
   *   - `awaiting-intervention` (008+) — set on any worker run
   *     failure / watchdog timeout. The pool skips it; main
   *     agent or operator must call task_continue /
   *     task_retry_fresh / task_extend_timeout / task_abort to
   *     resolve it.
   *   - `stalled` — legacy alias kept for pre-008 rows.
   *   - `draft` — user opt-in "don't pick up yet".
   *  Any of these keeps the row in `ready` but invisible to
   *  the worker pool. The UI paints a warning chip when one is
   *  present so the operator can see why a task is stuck. */
  labels?: string[];
  /** Last failure reason, set when the pool re-queued the task
   *  after a failed run. Cleared on success. */
  failureReason?: string | null;
  /** How many failed runs accumulated against this task. Reset
   *  to 0 on success. */
  attempts?: number;
  /** 008+: free-text reason populated when the pool stamps
   *  `awaiting-intervention`. Cleared on the next fresh
   *  claim. */
  interventionReason?: string | null;
  /** 008+: ms timestamp the row entered awaiting-intervention. */
  interventionAt?: number | null;
  /** Sandbox VM name in microsandbox's per-task pool. The pool
   *  names every per-task VM `tianshu-task-<tenantId>-<taskId>`,
   *  so this string identifies the exact microVM the worker
   *  acquired (running while in_progress, stopped after release,
   *  removed after task_delete). Surfaced in the detail dialog
   *  for tracing. */
  sandboxName?: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

/** Per-task derived state computed in the client. */
interface TaskMeta {
  /** Resolved upstream tasks (subset of board state, deleted ids omitted). */
  deps: Task[];
  /** Upstream tasks not yet done. */
  pendingDeps: Task[];
  /** True when the task is in `todo` and at least one upstream isn't done. */
  blocked: boolean;
}

interface ProjectSummary {
  project: string;
  ready: number;
  inProgress: number;
  done: number;
  total: number;
}

interface WorkerSnapshot {
  workers: { agentId: string; name: string; kind: string; busy: boolean }[];
  running: string[];
}

/**
 * Worker-session transcript entry, mirrored from
 * `plugins/workboard/src/db/session-history.ts` (server-side). We
 * redeclare here instead of importing because the client bundle
 * shouldn't pull SQL helpers; the wire shape is small enough that
 * keeping it in lockstep is cheap.
 */
interface HistoryToolCall {
  callId: string;
  toolName: string;
  argsJson: string;
}
interface HistoryToolResult {
  callId: string;
  toolName: string;
  ok?: boolean;
  text: string;
}
interface HistoryEntry {
  id: string;
  createdAt: number;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  toolCalls?: HistoryToolCall[];
  toolResult?: HistoryToolResult;
}

const PROJECT_INBOX_KEY = "***";

interface ColumnSpec {
  status: TaskStatus;
  label: string;
  color: string;
  dot: string;
}

const BOARD_COLUMNS: ColumnSpec[] = [
  { status: "ready",       label: "Ready",        color: "border-indigo-500/40 bg-indigo-500/5",    dot: "bg-indigo-400" },
  { status: "in_progress", label: "In progress", color: "border-amber-500/40 bg-amber-500/5",      dot: "bg-amber-400 animate-pulse" },
  { status: "done",        label: "Done",        color: "border-emerald-500/40 bg-emerald-500/5",  dot: "bg-emerald-400" },
];

// `stalled` is no longer a column - it's a label that paints a
// warning chip on the ready card. See LABELED_BADGES below.

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return (await r.json()) as T;
}

async function sendJson<T>(
  url: string,
  body: unknown,
  method: "POST" | "PATCH" | "DELETE" = "POST",
): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "include",
  };
  if (method !== "DELETE") {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body ?? {});
  }
  const r = await fetch(url, init);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const err = (await r.json()) as { error?: string };
      if (err.error) msg += ` (${err.error})`;
    } catch {
      /* swallow */
    }
    throw new Error(msg);
  }
  if (r.status === 204) return undefined as unknown as T;
  return (await r.json()) as T;
}

function fmtRelative(ms: number | null): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function projectChipsFromSummary(
  projects: ProjectSummary[],
  visibleStatuses: TaskStatus[],
): { key: string; label: string; count: number }[] {
  const sumFor = (p: ProjectSummary): number => {
    let n = 0;
    if (visibleStatuses.includes("ready")) n += p.ready;
    if (visibleStatuses.includes("in_progress")) n += p.inProgress;
    if (visibleStatuses.includes("done")) n += p.done;

    return n;
  };
  const filtered = projects
    .map((p) => ({ key: p.project, label: p.project, count: sumFor(p) }))
    .filter((p) => p.count > 0);
  // Real projects first, alphabetical. Inbox sticks at the end.
  const real = filtered
    .filter((p) => p.key !== PROJECT_INBOX_KEY)
    .sort((a, b) => a.label.localeCompare(b.label));
  const inbox = filtered.filter((p) => p.key === PROJECT_INBOX_KEY);
  return [...real, ...inbox.map((p) => ({ ...p, label: "Inbox" }))];
}

// ─── Shared board controller (state + handlers) ──────────────────

interface BoardController {
  tasks: Task[] | null;
  projects: ProjectSummary[];
  worker: WorkerSnapshot | null;
  /** Slug → worker display name, for the assignee chip on each
   *  card. Refreshed alongside tasks (every 3s); cheap because
   *  the agent set typically has ≤5 entries. */
  agentNames: Map<string, string>;
  error: string | null;
  busyId: string | null;
  reload(): Promise<void>;
  moveTask(id: string, status: TaskStatus): Promise<void>;
  addTaskInColumn(input: AddTaskInput, status: TaskStatus): Promise<void>;
  patchTask(id: string, patch: Record<string, unknown>): Promise<void>;
  deleteTask(id: string): Promise<void>;
  bindDrag(): {
    onDragStart(e: DragEvent, taskId: string): void;
    onDragEnd(): void;
    onDrop(e: DragEvent, targetStatus: TaskStatus): void;
  };
}

function useBoardController(opts: {
  includeArchived: boolean;
  withWorker: boolean;
}): BoardController {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [worker, setWorker] = useState<WorkerSnapshot | null>(null);
  const [agentNames, setAgentNames] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const dragTaskId = useRef<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (opts.includeArchived) params.set("include_aborted", "1");
      const url =
        params.toString().length === 0
          ? `${API_BASE}/tasks`
          : `${API_BASE}/tasks?${params.toString()}`;
      const requests: Promise<unknown>[] = [
        getJson<{ tasks: Task[] }>(url),
        getJson<{ projects: ProjectSummary[] }>(`${API_BASE}/projects`),
        getJson<{
          agents: Array<{ id: string; name: string }>;
        }>(`${API_BASE}/agents`),
      ];
      if (opts.withWorker) {
        requests.push(getJson<WorkerSnapshot>(`${API_BASE}/workers/status`));
      }
      const results = await Promise.all(requests);
      const nextTasks = (results[0] as { tasks: Task[] }).tasks;
      // Preserve object identity for unchanged tasks across the 3s
      // poll. Each poll returns fresh JSON (new object refs), which
      // would defeat BoardCard's memo (task is a prop) and re-render
      // every card. Reuse the previous task object when its content
      // is byte-identical, so memo'd cards that didn't change skip
      // re-render entirely — a mostly-idle board becomes a near-noop.
      setTasks((prev) => {
        if (!prev) return nextTasks;
        const prevById = new Map(prev.map((t) => [t.id, t]));
        let changed = prev.length !== nextTasks.length;
        const merged = nextTasks.map((t) => {
          const old = prevById.get(t.id);
          if (old && JSON.stringify(old) === JSON.stringify(t)) return old;
          changed = true;
          return t;
        });
        return changed ? merged : prev;
      });
      setProjects((results[1] as { projects: ProjectSummary[] }).projects);
      const agentList = (results[2] as {
        agents: Array<{ id: string; name: string }>;
      }).agents;
      // Only replace the map when it actually changed — the 3s poll
      // returns the same agents almost every time, and a fresh Map
      // reference each poll would break BoardCard's memo (agentNames
      // is a card prop) and force a full re-render.
      setAgentNames((prev) => {
        if (
          prev.size === agentList.length &&
          agentList.every((a) => prev.get(a.id) === a.name)
        ) {
          return prev;
        }
        return new Map(agentList.map((a) => [a.id, a.name]));
      });
      if (opts.withWorker) {
        setWorker(results[3] as WorkerSnapshot);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [opts.includeArchived, opts.withWorker]);

  useEffect(() => {
    void reload();
    const id = window.setInterval(() => void reload(), 3000);
    return () => window.clearInterval(id);
  }, [reload]);

  const moveTask = useCallback(
    async (id: string, status: TaskStatus) => {
      // Optimistic update so the card lands in the new column without
      // the 3s polling lag.
      setTasks((prev) =>
        prev ? prev.map((t) => (t.id === id ? { ...t, status } : t)) : prev,
      );
      setBusyId(id);
      try {
        await sendJson(`${API_BASE}/tasks/${id}`, { status }, "PATCH");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
        await reload();
      }
    },
    [reload],
  );

  const addTaskInColumn = useCallback(
    async (input: AddTaskInput, status: TaskStatus) => {
      try {
        const project =
          input.project && input.project !== PROJECT_INBOX_KEY
            ? input.project
            : undefined;
        // POST /tasks is now a batch endpoint. For single-card adds
        // (the kanban + button) we wrap into a 1-element batch and
        // surface the per-row error if it failed.
        const resp = await sendJson<{
          results: { ok: boolean; task?: Task; error?: string }[];
        }>(`${API_BASE}/tasks`, {
          tasks: [
            {
              title: input.title,
              status,
              project,
              priority: input.priority || 0,
              workerRole: input.workerRole || null,
              description: input.description || null,
            },
          ],
        });
        const row = resp?.results?.[0];
        if (row && !row.ok) {
          throw new Error(row.error ?? "create_failed");
        }
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [reload],
  );

  const patchTask = useCallback(
    async (id: string, patch: Record<string, unknown>) => {
      setBusyId(id);
      try {
        await sendJson(`${API_BASE}/tasks/${id}`, patch, "PATCH");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
        await reload();
      }
    },
    [reload],
  );

  const deleteTask = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        // DELETE is now a batch endpoint at POST /tasks/delete.
        // Wrap the single-id case into a 1-element ids array so the
        // existing modal "Delete" button keeps working unchanged.
        const resp = await sendJson<{
          results: { ok: boolean; id?: string; error?: string }[];
        }>(`${API_BASE}/tasks/delete`, { ids: [id] });
        const row = resp?.results?.[0];
        if (row && !row.ok) {
          throw new Error(row.error ?? "delete_failed");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
        await reload();
      }
    },
    [reload],
  );

  const bindDrag = useCallback(() => {
    return {
      onDragStart: (e: DragEvent, taskId: string) => {
        dragTaskId.current = taskId;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", taskId);
      },
      onDragEnd: () => {
        dragTaskId.current = null;
      },
      onDrop: (e: DragEvent, targetStatus: TaskStatus) => {
        const taskId =
          dragTaskId.current || e.dataTransfer.getData("text/plain");
        if (!taskId) return;
        const task = (tasks ?? []).find((t) => t.id === taskId);
        if (!task || task.status === targetStatus) return;
        void moveTask(taskId, targetStatus);
      },
    };
  }, [tasks, moveTask]);

  return {
    tasks,
    projects,
    worker,
    agentNames,
    error,
    busyId,
    reload,
    moveTask,
    addTaskInColumn,
    patchTask,
    deleteTask,
    bindDrag,
  };
}

// ─── Right panel: compact kanban ─────────────────────────────────

function WorkboardPanel(_props: PanelProps) {
  const ctrl = useBoardController({ includeArchived: false, withWorker: false });
  const [projectFilter, setProjectFilter] = useState<string>("");

  const visibleTasks = useMemo(() => {
    if (!ctrl.tasks) return null;
    return projectFilter
      ? ctrl.tasks.filter(
          (t) => (t.project || PROJECT_INBOX_KEY) === projectFilter,
        )
      : ctrl.tasks;
  }, [ctrl.tasks, projectFilter]);

  const chips = useMemo(
    () =>
      projectChipsFromSummary(ctrl.projects, ["ready", "in_progress", "done"]),
    [ctrl.projects],
  );

  const drag = ctrl.bindDrag();

  return (
    <div className="flex flex-col h-full bg-bg-base text-fg-default">
      <header className="flex items-center justify-between px-3 py-2 border-b border-border-subtle flex-shrink-0">
        <h2 className="flex items-center gap-1.5 font-semibold text-sm">
          <Kanban className="w-4 h-4" /> Tasks
        </h2>
        <button
          type="button"
          onClick={() => void ctrl.reload()}
          className="text-[10px] uppercase tracking-wide text-fg-muted hover:text-fg-default"
        >
          Refresh
        </button>
      </header>

      {chips.length > 1 && (
        <ProjectChips
          chips={chips}
          active={projectFilter}
          onPick={setProjectFilter}
        />
      )}

      {ctrl.error && (
        <div className="px-3 py-1.5 text-[10px] bg-red-900/40 border-b border-red-800 text-red-100 flex-shrink-0">
          {ctrl.error}
        </div>
      )}

      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        {ctrl.tasks === null ? (
          <div className="flex items-center justify-center text-fg-faint py-8 h-full">
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
        ) : (
          <div className="flex gap-1.5 p-2 h-full items-stretch">
            {BOARD_COLUMNS.map((col) => (
              <KanbanColumn
                key={col.status}
                column={col}
                tasks={(visibleTasks ?? [])
                  .filter((t) => t.status === col.status)
                  .sort((a, b) =>
                    col.status === "done"
                      ? b.createdAt - a.createdAt
                      : a.createdAt - b.createdAt,
                  )}
                busyId={ctrl.busyId}
                compact
                onAddTask={(input) =>
                  void ctrl.addTaskInColumn(
                    { ...input, project: input.project ?? projectFilter },
                    col.status,
                  )
                }
                projects={ctrl.projects}
                workerRoles={KNOWN_WORKER_ROLES}
                agentNames={ctrl.agentNames}
                allTasks={ctrl.tasks ?? []}
                onPatchTask={ctrl.patchTask}
                onDragStart={drag.onDragStart}
                onDragEnd={drag.onDragEnd}
                onDrop={drag.onDrop}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Admin page: full board ──────────────────────────────────────

function WorkboardAdminPage(_props: AdminPageProps) {
  const ctrl = useBoardController({ includeArchived: false, withWorker: true });
  const [projectFilter, setProjectFilter] = useState<string>("");
  const [selected, setSelected] = useState<Task | null>(null);

  // Re-sync the modal's task with the latest reload (or close it if the
  // task was deleted out from under us).
  useEffect(() => {
    if (!selected || !ctrl.tasks) return;
    const fresh = ctrl.tasks.find((t) => t.id === selected.id);
    if (!fresh) {
      setSelected(null);
    } else if (fresh !== selected) {
      setSelected(fresh);
    }
  }, [ctrl.tasks, selected]);

  const visibleStatuses: TaskStatus[] = ["ready", "in_progress", "done"];

  const visibleTasks = useMemo(() => {
    if (!ctrl.tasks) return null;
    const inProject = projectFilter
      ? ctrl.tasks.filter(
          (t) => (t.project || PROJECT_INBOX_KEY) === projectFilter,
        )
      : ctrl.tasks;
    return inProject.filter((t) => visibleStatuses.includes(t.status));
  }, [ctrl.tasks, projectFilter, visibleStatuses]);

  const chips = useMemo(
    () => projectChipsFromSummary(ctrl.projects, visibleStatuses),
    [ctrl.projects, visibleStatuses],
  );

  const renderColumns = BOARD_COLUMNS;

  const drag = ctrl.bindDrag();

  return (
    <div className="flex flex-col h-full bg-bg-base text-fg-default">
      <header className="px-6 py-4 border-b border-border-subtle flex-shrink-0">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Kanban className="w-5 h-5" /> Workboard
        </h1>
        <p className="text-xs text-fg-faint mt-1 max-w-3xl">
          Drag cards across columns. Click <Plus className="inline w-3 h-3 align-text-bottom" />{" "}
          on a column to add a task in place. Workers in the pool claim
          ready tasks and report back with a result summary.
          <span className="text-fg-fainter">
            {" "}
            v0.2 ships an echo worker (30s sleep + reflect title) so the loop is
            visible end-to-end; real worker roles land in follow-up PRs.
          </span>
        </p>
      </header>

      {ctrl.error && (
        <div className="mx-6 mt-3 px-3 py-2 rounded bg-red-900/40 border border-red-800 text-xs text-red-100 flex-shrink-0">
          {ctrl.error}
        </div>
      )}

      {chips.length > 0 && (
        <ProjectChips
          chips={chips}
          active={projectFilter}
          onPick={setProjectFilter}
          showAll
        />
      )}

      <WorkerStatusRow
        snapshot={ctrl.worker}
        onNudge={() => void sendJson(`${API_BASE}/workers/restart`, {})}
      />

      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        {ctrl.tasks === null ? (
          <div className="flex items-center text-fg-faint py-12 justify-center h-full">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : (
          <div
            className="flex gap-3 p-4 h-full items-stretch"
            style={{ minWidth: `${renderColumns.length * 240}px` }}
          >
            {renderColumns.map((col) => (
              <KanbanColumn
                key={col.status}
                column={col}
                tasks={(visibleTasks ?? [])
                  .filter((t) => t.status === col.status)
                  .sort((a, b) =>
                    col.status === "done"
                      ? b.createdAt - a.createdAt
                      : a.createdAt - b.createdAt,
                  )}
                busyId={ctrl.busyId}
                onAddTask={(input) =>
                  void ctrl.addTaskInColumn(
                    { ...input, project: input.project ?? projectFilter },
                    col.status,
                  )
                }
                projects={ctrl.projects}
                workerRoles={KNOWN_WORKER_ROLES}
                agentNames={ctrl.agentNames}
                allTasks={ctrl.tasks ?? []}
                onPatchTask={ctrl.patchTask}
                onDragStart={drag.onDragStart}
                onDragEnd={drag.onDragEnd}
                onDrop={drag.onDrop}
              />
            ))}
          </div>
        )}
      </div>

      {selected && (
        <TaskModal
          task={selected}
          allTasks={ctrl.tasks ?? []}
          busy={ctrl.busyId === selected.id}
          onClose={() => setSelected(null)}
          onPatch={(patch) => ctrl.patchTask(selected.id, patch)}
          onDelete={() => ctrl.deleteTask(selected.id)}
        />
      )}
    </div>
  );
}

// ─── Kanban column ───────────────────────────────────────────────

function KanbanColumn({
  column,
  tasks,
  allTasks,
  busyId,
  compact,
  onAddTask,
  onPatchTask,
  projects,
  workerRoles,
  agentNames,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  column: ColumnSpec;
  tasks: Task[];
  /** Complete board (all owner-scoped tasks) so the card can resolve
   *  its own dependencies and the AddTaskRow can offer a picker. */
  allTasks: Task[];
  busyId: string | null;
  compact?: boolean;
  onAddTask: (input: AddTaskInput) => void;
  /** Card-initiated patches - e.g. the "Retry" button on a
   *  stalled-label chip clears the label so the pool re-claims. */
  onPatchTask: (id: string, patch: Record<string, unknown>) => Promise<void>;
  projects: ProjectSummary[];
  workerRoles: string[];
  /** Slug → worker display name for the assignee chip. */
  agentNames: Map<string, string>;
  onDragStart: (e: DragEvent, taskId: string) => void;
  onDragEnd: () => void;
  onDrop: (e: DragEvent, targetStatus: TaskStatus) => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  // Build the id→task index ONCE per render, not once per card.
  // computeMeta used to `new Map(allTasks.map(...))` on every call,
  // and it's called per card → O(n²) per column each 3s poll. Hoist
  // to O(n).
  const taskById = useMemo(
    () => new Map(allTasks.map((t) => [t.id, t] as const)),
    [allTasks],
  );

  return (
    <div
      className={`flex flex-col flex-1 min-w-[160px] rounded-lg border transition-colors ${
        isDragOver
          ? "border-blue-500/60 bg-bg-elevated/80"
          : column.color
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        onDrop(e, column.status);
      }}
    >
      <header className="px-2 py-1.5 border-b border-border-subtle/60 flex items-center gap-1.5 sticky top-0">
        <span className={`w-2 h-2 rounded-full ${column.dot}`} />
        <span className={`${compact ? "text-[11px]" : "text-xs"} font-medium`}>
          {column.label}
        </span>
        <span
          className={`ml-auto ${compact ? "text-[10px]" : "text-[11px]"} text-fg-faint`}
        >
          {tasks.length}
        </span>
        {column.status === "ready" && (
          <button
            type="button"
            title="Add task"
            onClick={() => setShowAdd(true)}
            className="p-0.5 text-fg-fainter hover:text-fg-default rounded"
          >
            <Plus className="w-3 h-3" />
          </button>
        )}
      </header>

      <ul className="flex-1 overflow-y-auto p-1.5 space-y-1.5 min-h-[40px]">
        {tasks.map((t) => (
          <BoardCard
            key={t.id}
            task={t}
            meta={computeMeta(t, taskById)}
            busy={busyId === t.id}
            compact={compact}
            agentNames={agentNames}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onPatch={onPatchTask}
          />
        ))}

        {showAdd && (
          <AddTaskRow
            projects={projects}
            workerRoles={workerRoles}
            allTasks={allTasks}
            onSubmit={(input) => {
              onAddTask(input);
              setShowAdd(false);
            }}
            onCancel={() => setShowAdd(false)}
          />
        )}

        {!showAdd && tasks.length === 0 && (
          <li
            className={`text-center text-[10px] text-fg-fainter py-3 ${
              column.status === "ready"
                ? "cursor-pointer hover:text-fg-muted"
                : ""
            }`}
            onClick={
              column.status === "ready" ? () => setShowAdd(true) : undefined
            }
          >
            {column.status === "ready"
              ? "empty - click to add"
              : "empty"}
          </li>
        )}
      </ul>
    </div>
  );
}

function computeMeta(task: Task, byId: Map<string, Task>): TaskMeta {
  const deps: Task[] = [];
  const pendingDeps: Task[] = [];
  for (const id of task.dependsOn ?? []) {
    const dep = byId.get(id);
    if (!dep) continue;
    deps.push(dep);
    if (dep.status !== "done") pendingDeps.push(dep);
  }
  // A deleted prerequisite counts as unsatisfied so the card stays
  // visibly blocked until the user re-points or removes it.
  const missingDepCount = (task.dependsOn?.length ?? 0) - deps.length;
  const blocked =
    task.status === "ready" &&
    (pendingDeps.length > 0 || missingDepCount > 0);
  return { deps, pendingDeps, blocked };
}

// Memoized: the 3s board poll re-renders the whole board; without
// memo every card re-renders even when its own task didn't change.
// Props are stable (agentNames map + callbacks are useMemo/useCallback
// upstream), so memo skips unchanged cards.
const BoardCard = memo(function BoardCard({
  task,
  meta,
  busy,
  compact,
  agentNames,
  onDragStart,
  onDragEnd,
  onPatch,
}: {
  task: Task;
  meta: TaskMeta;
  busy: boolean;
  compact?: boolean;
  /** Slug → worker display name. The card pulls the assignee
   *  label from this map; missing entries fall back to the slug. */
  agentNames: Map<string, string>;
  onDragStart: (e: DragEvent, taskId: string) => void;
  onDragEnd: () => void;
  onPatch: (id: string, patch: Record<string, unknown>) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMore =
    Boolean(task.description?.trim()) ||
    Boolean(task.resultSummary?.trim()) ||
    meta.deps.length > 0 ||
    // Anything with a session_id has a worker transcript worth
    // showing — even an in-progress task with no description.
    Boolean(task.sessionId) ||
    task.status === "in_progress";
  return (
    <li
      draggable
      onDragStart={(e) => {
        // Visual feedback: dim the card while dragging.
        (e.currentTarget as HTMLElement).style.opacity = "0.4";
        onDragStart(e, task.id);
      }}
      onDragEnd={(e) => {
        (e.currentTarget as HTMLElement).style.opacity = "1";
        onDragEnd();
      }}
      onClick={(e) => {
        // Don't fight click-vs-drag heuristics: only flip on real
        // mouse clicks, not when dragstart bubbled up. The browser
        // suppresses click after a drag, so this is mostly belt &
        // braces - but we do swallow the event so the column-level
        // drop handler doesn't see it.
        e.stopPropagation();
        if (hasMore) setExpanded((v) => !v);
      }}
      className={`rounded border bg-bg-elevated/60 hover:border-border-default ${
        meta.blocked
          ? "border-indigo-500/40"
          : "border-border-subtle"
      } ${hasMore ? "cursor-pointer" : "cursor-grab"} ${busy ? "opacity-60" : ""}`}
    >
      <div className="px-2 py-1.5 flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 flex-wrap">
            <span
              className={`${compact ? "text-[11.5px]" : "text-xs"} font-medium text-fg-default break-words`}
            >
              {task.title}
            </span>
            {task.priority > 0 && (
              <span className="text-[9px] px-1 rounded bg-amber-900/50 text-amber-100">
                p{task.priority}
              </span>
            )}
            {task.workerAgentId && (
              <span
                className="text-[9px] px-1 rounded bg-indigo-900/50 text-indigo-100"
                title={`Assigned to ${task.workerAgentId} (slug)`}
              >
                @{agentNames.get(task.workerAgentId) ?? task.workerAgentId}
              </span>
            )}
            {!task.workerAgentId && task.workerRole && (
              // Legacy rows: pre-PR-C tasks still carry workerRole
              // (kind id) without a workerAgentId. Show it so old
              // records aren't blank.
              <span
                className="text-[9px] px-1 rounded bg-bg-raised text-fg-muted"
                title="Legacy: dispatched by kind, not pinned to a slug"
              >
                {task.workerRole}
              </span>
            )}
            {task.project && task.project !== PROJECT_INBOX_KEY && (
              <span className="text-[9px] px-1 rounded bg-bg-raised text-fg-muted">
                #{task.project}
              </span>
            )}
            {(task.dependsOn?.length ?? 0) > 0 && (
              <span
                className={`inline-flex items-center gap-0.5 text-[9px] px-1 rounded border ${
                  meta.blocked
                    ? "text-indigo-200 bg-indigo-500/15 border-indigo-500/40"
                    : "text-fg-muted bg-bg-hover/30 border-border-default"
                }`}
                title={
                  meta.blocked
                    ? `Waiting on: ${meta.pendingDeps.map((d) => d.title).join(", ")}`
                    : `${meta.deps.length} dependenc${meta.deps.length === 1 ? "y" : "ies"} satisfied`
                }
              >
                {meta.blocked ? (
                  <Lock className="w-2.5 h-2.5" />
                ) : (
                  <Link2 className="w-2.5 h-2.5" />
                )}
                {meta.blocked
                  ? `${meta.pendingDeps.length}/${task.dependsOn.length}`
                  : task.dependsOn.length}
              </span>
            )}
          </div>
          {(task.labels ?? []).includes("awaiting-intervention") && (
            <div
              className="mt-1 flex items-start gap-1 rounded border border-rose-500/50 bg-rose-500/10 px-1.5 py-1 text-[10px] text-danger"
              title={task.interventionReason ?? task.failureReason ?? ""}
              onClick={(e) => e.stopPropagation()}
            >
              <AlertTriangle className="w-3 h-3 mt-px shrink-0" />
              <span className="min-w-0 flex-1 break-words line-clamp-3">
                <span className="font-medium">awaiting intervention</span>
                {task.interventionAt
                  ? ` (${formatRelative(task.interventionAt)})`
                  : ""}
                {(task.interventionReason ?? task.failureReason)
                  ? `: ${task.interventionReason ?? task.failureReason}`
                  : ""}
              </span>
              {/* Quick-retry button. Clears the intervention
                  labels + reason; pool's drain pass picks the
                  task up again on the next nudge (route handler
                  emits one on label-clear). For semantic revival
                  ("continue prior session" vs. "start fresh")
                  the orchestrator agent should use
                  task_continue / task_retry_fresh / task_abort
                  instead. */}
              <button
                type="button"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void onPatch(task.id, {
                    labels: (task.labels ?? []).filter(
                      (l) =>
                        l !== "awaiting-intervention" && l !== "stalled",
                    ),
                    attempts: 0,
                    failureReason: null,
                    interventionReason: null,
                    interventionAt: null,
                  });
                }}
                className="shrink-0 rounded bg-rose-600 px-1.5 py-px text-[9.5px] font-medium text-white hover:bg-rose-500 disabled:opacity-50"
              >
                Retry
              </button>
            </div>
          )}
          {(task.labels ?? []).includes("stalled") && (
            <div
              className="mt-1 flex items-start gap-1 rounded border border-orange-500/40 bg-orange-500/5 px-1.5 py-1 text-[10px] text-orange-200"
              title={task.failureReason ?? ""}
              onClick={(e) => e.stopPropagation()}
            >
              <AlertTriangle className="w-3 h-3 mt-px shrink-0" />
              <span className="min-w-0 flex-1 break-words line-clamp-3">
                stalled
                {(task.attempts ?? 0) > 0 ? ` after ${task.attempts} attempts` : ""}
                {task.failureReason ? `: ${task.failureReason}` : ""}
              </span>
              {/* Clear the `stalled` label → the pool re-claims the
                  task on its next nudge (the route handler emits one
                  on label-clear). attempts is also reset to 0 so the
                  retry counter starts clean. */}
              <button
                type="button"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void onPatch(task.id, {
                    labels: (task.labels ?? []).filter(
                      (l) => l !== "stalled",
                    ),
                    attempts: 0,
                    failureReason: null,
                  });
                }}
                className="shrink-0 rounded bg-orange-600 px-1.5 py-px text-[9.5px] font-medium text-white hover:bg-orange-500 disabled:opacity-50"
              >
                Retry
              </button>
            </div>
          )}
          {(task.labels ?? []).includes("draft") && (
            <div
              className="mt-1 flex items-center gap-1.5"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="inline-block rounded border border-yellow-500/40 bg-yellow-500/5 px-1.5 py-px text-[10px] text-yellow-200">
                draft - pool will skip
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void onPatch(task.id, {
                    labels: (task.labels ?? []).filter(
                      (l) => l !== "draft",
                    ),
                  });
                }}
                className="rounded border border-yellow-500/40 px-1 py-px text-[9.5px] font-medium text-yellow-100 hover:bg-yellow-500/15 disabled:opacity-50"
              >
                Publish
              </button>
            </div>
          )}
          {task.description && !expanded && (
            <div className="text-[10.5px] text-fg-muted mt-0.5 line-clamp-2 whitespace-pre-line">
              {task.description}
            </div>
          )}
          {task.resultSummary && !expanded && (
            <div
              className={`${compact ? "text-[10px]" : "text-[10.5px]"} text-success/90 mt-0.5 italic line-clamp-2 whitespace-pre-line`}
            >
              → {task.resultSummary}
            </div>
          )}
          <div className="text-[9.5px] text-fg-faint mt-0.5 flex items-center gap-1">
            <Clock className="w-2.5 h-2.5" />
            {fmtRelative(task.endedAt ?? task.startedAt ?? task.createdAt)}
          </div>
        </div>
        {hasMore && (
          <ChevronDown
            className={`w-3 h-3 mt-0.5 text-fg-faint shrink-0 transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
          />
        )}
        {busy && <Loader2 className="w-3 h-3 animate-spin text-fg-muted" />}
      </div>
      {expanded && (
        <div
          className="px-2 pb-2 pt-0 border-t border-border-subtle/60 space-y-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          {task.description && (
            <Section label="Description">
              <div className="text-[10.5px] text-fg-muted whitespace-pre-line break-words max-h-48 overflow-y-auto">
                {task.description}
              </div>
            </Section>
          )}
          {task.resultSummary && (
            <Section label="Result">
              <div className="text-[10.5px] text-success italic whitespace-pre-line break-words max-h-48 overflow-y-auto">
                → {task.resultSummary}
              </div>
            </Section>
          )}
          {task.resultFiles.length > 0 && (
            <Section label={`Files (${task.resultFiles.length})`}>
              <ul className="space-y-0.5">
                {task.resultFiles.map((p) => (
                  <li key={p}>
                    <DeliveryFile path={p} />
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {meta.deps.length > 0 && (
            <Section label="Depends on">
              <ul className="space-y-0.5">
                {meta.deps.map((d) => (
                  <li
                    key={d.id}
                    className="text-[10px] flex items-center gap-1"
                  >
                    {d.status === "done" ? (
                      <CheckCircle2 className="w-2.5 h-2.5 text-success shrink-0" />
                    ) : (
                      <Lock className="w-2.5 h-2.5 text-indigo-400 shrink-0" />
                    )}
                    <span
                      className={`truncate ${
                        d.status === "done"
                          ? "text-fg-muted line-through"
                          : "text-indigo-200"
                      }`}
                    >
                      {d.title}
                    </span>
                    <span className="ml-auto text-[9px] text-fg-fainter shrink-0">
                      {d.status.replace("_", " ")}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <div className="grid grid-cols-2 gap-x-3 gap-y-0 text-[9.5px] text-fg-faint pt-1">
            <div>
              Created 
              <span className="text-fg-muted">
                {new Date(task.createdAt).toLocaleString()}
              </span>
            </div>
            {task.startedAt && (
              <div>
                Started 
                <span className="text-fg-muted">
                  {new Date(task.startedAt).toLocaleString()}
                </span>
              </div>
            )}
            {task.endedAt && (
              <div>
                Ended 
                <span className="text-fg-muted">
                  {new Date(task.endedAt).toLocaleString()}
                </span>
              </div>
            )}
          </div>
          <ExecutionSection task={task} />
        </div>
      )}
    </li>
  );
});

/**
 * Trigger row that opens the worker transcript in a full dialog.
 *
 * The card body is too narrow for a chat-style transcript, so we
 * render a thin button on the expanded card and pop a modal when
 * clicked. The modal owns the polling loop — closed cards do no
 * background work.
 */
function ExecutionSection({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  const showButton = task.status === "in_progress" || Boolean(task.sessionId);
  if (!showButton) return null;
  return (
    <>
      <div className="pt-1">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
          className="inline-flex items-center gap-1.5 rounded border border-border-default px-1.5 py-0.5 text-[10px] text-fg-muted hover:border-border-strong hover:bg-bg-raised"
        >
          <ScrollText className="w-3 h-3" />
          View transcript
          {task.status === "in_progress" && (
            <span className="flex items-center gap-1 text-warning">
              <span className="w-1 h-1 rounded-full bg-amber-400 animate-pulse" />
              live
            </span>
          )}
        </button>
      </div>
      {open && (
        <ExecutionDialog task={task} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/**
 * Modal that renders the worker session transcript.
 *
 * Visual model lifted from packages/web's MessageBubble:
 *   - role=user      → right-aligned brand-tinted card
 *   - role=assistant → left-aligned dark card; tool calls render
 *                      as collapsible chips below
 *   - role=tool      → not shown directly — the result is folded
 *                      back into its calling assistant turn
 *
 * While `task.status === "in_progress"` the dialog polls every 3s
 * so the user can watch the LLM type. Stops on close or terminal
 * status. Auto-scrolls to the bottom on new entries unless the
 * user has scrolled away (so reading old messages doesn't yank).
 */
function ExecutionDialog({
  task,
  onClose,
}: {
  task: Task;
  onClose: () => void;
}) {
  const { Modal } = useUiPrimitives();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const fetchHistory = useCallback(async () => {
    if (!task.id) return;
    setLoading(true);
    try {
      const data = await getJson<{
        sessionId: string | null;
        entries: HistoryEntry[];
      }>(`${API_BASE}/tasks/${task.id}/history`);
      setEntries(data.entries ?? []);
      setSessionId(data.sessionId ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [task.id]);

  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory]);

  // Tail while the task is running.
  useEffect(() => {
    if (task.status !== "in_progress") return;
    const t = setInterval(() => void fetchHistory(), 3000);
    return () => clearInterval(t);
  }, [task.status, fetchHistory]);

  // Auto-scroll to bottom on new entries when user is at bottom.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < 80;
  };

  const merged = useMemo(
    () => mergeAssistantToolResults(entries ?? []),
    [entries],
  );

  // The card itself is `<li draggable>`, so anything we render
  // INSIDE it inherits the drag intent — selecting text would
  // grab the whole card. Portal the dialog to document.body so
  // it sits next to the kanban column, not under it.
  // The card itself is `<li draggable>`, so anything we render
  // INSIDE it inherits the drag intent — selecting text would
  // grab the whole card. Modal portals to document.body so it
  // sits next to the kanban column, not under it.
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={task.title}
      size="lg"
      className="bg-bg-base"
    >
      <div
        className="flex min-h-0 flex-1 flex-col"
        // Belt + braces: even portalled, if a dragstart somehow
        // bubbles up from inside the dialog we suppress it so text
        // selection wins.
        onDragStart={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-border-subtle px-4 py-2 text-[10px] text-fg-faint">
          <ScrollText className="h-3.5 w-3.5 text-fg-faint" />
          <span>worker transcript</span>
          {sessionId && (
            <span className="font-mono text-fg-fainter">· {sessionId}</span>
          )}
          {task.status === "in_progress" && (
            <span className="flex items-center gap-1 text-warning">
              ·
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
              tailing
            </span>
          )}
          <div className="ml-auto">
            <button
              type="button"
              onClick={() => void fetchHistory()}
              disabled={loading}
              className="rounded p-1 text-fg-muted hover:bg-bg-raised hover:text-fg-default disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              />
            </button>
          </div>
        </header>

        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 space-y-3 overflow-y-auto p-4"
        >
          {error && (
            <div className="rounded border border-rose-700/40 bg-rose-950/30 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}
          {entries === null && loading && (
            <div className="text-xs italic text-fg-faint">Loading…</div>
          )}
          {entries !== null && merged.length === 0 && !loading && (
            <div className="text-xs italic text-fg-faint">
              {task.sessionId
                ? "No messages yet."
                : "Worker hasn't started yet."}
            </div>
          )}
          {merged.map((row) => (
            <ExecutionTurn key={row.id} row={row} />
          ))}
        </div>
      </div>
    </Modal>
  );
}

interface MergedTurn {
  id: string;
  createdAt: number;
  role: "user" | "assistant" | "system";
  text: string;
  /** Tool calls from THIS assistant turn, with their result
   *  envelope already attached (looked up from later tool rows). */
  calls: Array<{
    call: HistoryToolCall;
    result?: HistoryToolResult;
  }>;
}

/**
 * Walk the raw chronologically-ordered entries and merge tool
 * results back into the assistant turn that called them. Mirrors
 * `mergeToolTurns` in packages/web but works on our flat
 * HistoryEntry shape. Tool rows themselves are dropped from the
 * output — the result text lives on the call's chip.
 */
function mergeAssistantToolResults(
  entries: HistoryEntry[],
): MergedTurn[] {
  // Index tool results by callId once.
  const resultByCallId = new Map<string, HistoryToolResult>();
  for (const e of entries) {
    if (e.role === "tool" && e.toolResult?.callId) {
      resultByCallId.set(e.toolResult.callId, e.toolResult);
    }
  }
  const out: MergedTurn[] = [];
  for (const e of entries) {
    if (e.role === "tool") continue;
    const calls = (e.toolCalls ?? []).map((tc) => ({
      call: tc,
      result: resultByCallId.get(tc.callId),
    }));
    out.push({
      id: e.id,
      createdAt: e.createdAt,
      role: e.role === "user" ? "user" : e.role === "assistant" ? "assistant" : "system",
      text: e.text,
      calls,
    });
  }
  return out;
}

/** One assistant / user turn rendered MessageBubble-style. */
function ExecutionTurn({ row }: { row: MergedTurn }) {
  const isUser = row.role === "user";
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={`flex max-w-[85%] flex-col ${isUser ? "items-end" : "items-start"}`}
      >
        <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-fg-faint">
          {isUser ? (
            <User className="h-3 w-3" />
          ) : (
            <Bot className="h-3 w-3 text-link" />
          )}
          <span>{isUser ? "you" : row.role}</span>
          <span className="text-fg-fainter">·</span>
          <span className="text-fg-fainter">
            {new Date(row.createdAt).toLocaleTimeString()}
          </span>
        </div>
        {row.text && (
          <div
            className={`whitespace-pre-line break-words rounded-lg border px-3 py-2 text-[13px] leading-relaxed ${
              isUser
                ? "border-brand-400/30 bg-brand-500/10 text-fg-default"
                : "border-border-subtle bg-bg-elevated/60 text-fg-default"
            }`}
          >
            {row.text}
          </div>
        )}
        {row.calls.length > 0 && (
          <div
            className={`mt-1.5 flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}
          >
            {row.calls.map((c, i) => (
              <ToolCallChip key={c.call.callId || `c${i}`} {...c} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Collapsible tool-call chip; click to reveal the result body. */
function ToolCallChip({
  call,
  result,
}: {
  call: HistoryToolCall;
  result?: HistoryToolResult;
}) {
  const [expanded, setExpanded] = useState(false);
  const running = !result;
  const isError = !!result && result.ok === false;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => !running && setExpanded((v) => !v)}
        className={`flex select-none items-center gap-1.5 py-0.5 text-xs ${
          running
            ? "cursor-default text-fg-faint"
            : "cursor-pointer text-fg-faint hover:text-fg-muted"
        }`}
      >
        {running ? (
          <Loader2 className="h-3 w-3 animate-spin text-warning" />
        ) : isError ? (
          <XCircle className="h-3 w-3 text-rose-400/70" />
        ) : (
          <CheckCircle2 className="h-3 w-3 text-emerald-500/60" />
        )}
        <code className="font-mono text-[12px] text-link">
          {call.toolName}
        </code>
        <span className="font-mono text-[11px] text-fg-fainter">
          {summariseArgsJson(call.argsJson)}
        </span>
        {running ? (
          <span className="text-[11px] text-fg-fainter">running…</span>
        ) : expanded ? (
          <ChevronDown className="h-3 w-3 text-fg-fainter" />
        ) : (
          <ChevronRight className="h-3 w-3 text-fg-fainter" />
        )}
      </button>
      {expanded && result && (
        <pre
          className={`mt-1 max-h-64 max-w-2xl overflow-auto whitespace-pre-wrap break-all rounded-md border px-3 py-2 text-[11px] ${
            isError
              ? "border-rose-700/40 bg-rose-950/30 text-danger"
              : "border-border-subtle/60 bg-bg-elevated/60 text-fg-muted"
          }`}
        >
          {truncateText(result.text || "(empty)", 4000)}
        </pre>
      )}
    </div>
  );
}

function summariseArgsJson(argsJson: string): string {
  if (!argsJson) return "()";
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    // Not JSON — just truncate.
    return argsJson.length > 60 ? `(${argsJson.slice(0, 57)}…)` : `(${argsJson})`;
  }
  if (!parsed || typeof parsed !== "object") return `(${argsJson})`;
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return "()";
  return keys
    .slice(0, 3)
    .map((k) => `${k}=${shortVal(obj[k])}`)
    .join(" ");
}

function shortVal(v: unknown): string {
  if (typeof v === "string")
    return v.length > 40 ? `"${v.slice(0, 37)}…"` : `"${v}"`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v == null) return String(v);
  return JSON.stringify(v).slice(0, 40);
}

function truncateText(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\n…(truncated)";
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wide text-fg-faint mb-0.5">
        {label}
      </div>
      {children}
    </div>
  );
}

/** One row of the task's `resultFiles[]`. Renders the path as a
 *  monospace chip; clicking opens the raw file in a new tab via
 *  the files plugin's GET /raw endpoint. The path is whatever the
 *  worker passed to task_complete — typically a workspace-rooted
 *  path like `/projects/<slug>/foo.py` or a `workspace:///...`
 *  URI. We strip the URI prefix before handing it to the API.
 *  Files outside the user's workspace will 404 from the raw
 *  endpoint; we don't pre-validate here. */
function DeliveryFile({ path }: { path: string }): React.ReactElement {
  const open = useOpenFile();
  const stripped = path.replace(/^workspace:\/\/+/, "/");
  // Display the basename in the chip and the full path in the
  // tooltip so the row stays compact on small cards.
  const display = stripped.split("/").filter(Boolean).pop() || stripped;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        open(stripped);
      }}
      className="inline-flex items-center gap-1 max-w-full text-[10.5px] font-mono text-success hover:underline truncate"
      title={stripped}
    >
      <FileText className="w-3 h-3 shrink-0 opacity-70" />
      <span className="truncate">{display}</span>
    </button>
  );
}

function nextStatus(status: TaskStatus): TaskStatus | null {
  if (status === "ready") return "in_progress";
  if (status === "in_progress") return "done";
  return null;
}

// ─── Inline add-task row ─────────────────────────────────

interface AddTaskInput {
  title: string;
  description?: string;
  project?: string;
  priority?: number;
  workerRole?: string;
  dependsOn?: string[];
}

/** Worker roles the UI hints at. v0.2 only ships `echo`; the four
 *  ADR-0002 roles are listed so the autocomplete is ready when the
 *  follow-up PRs land them. */
const KNOWN_WORKER_ROLES = [
  "echo",
  "qianliyan",
  "luban",
  "xihe",
  "nvwa",
];

function AddTaskRow({
  projects,
  workerRoles,
  allTasks,
  onSubmit,
  onCancel,
}: {
  projects: ProjectSummary[];
  workerRoles: string[];
  /** Used to populate the dependency picker. */
  allTasks: Task[];
  onSubmit: (input: AddTaskInput) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [project, setProject] = useState("");
  const [priority, setPriority] = useState(0);
  const [workerRole, setWorkerRole] = useState("");
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [showMore, setShowMore] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const t = title.trim();
    if (!t) {
      onCancel();
      return;
    }
    onSubmit({
      title: t,
      description: description.trim() || undefined,
      project: project.trim() || undefined,
      priority: priority || undefined,
      workerRole: workerRole.trim() || undefined,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
    });
  };

  return (
    <li className="rounded border border-blue-500/50 bg-bg-elevated/70 p-1.5 space-y-1">
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              onCancel();
            }
          }}
          placeholder="Task title..."
          className="flex-1 min-w-0 bg-bg-raised border border-border-default rounded px-2 py-1 text-[11.5px] text-fg-default outline-none focus:border-blue-500"
        />
        <button
          type="button"
          title={showMore ? "Less" : "More fields"}
          onClick={() => setShowMore((v) => !v)}
          className="p-0.5 text-fg-faint hover:text-fg-default"
        >
          <ChevronDown
            className={`w-3 h-3 transition-transform ${showMore ? "rotate-180" : ""}`}
          />
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="p-0.5 text-fg-faint hover:text-fg-default"
          title="Cancel"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {showMore && (
        <div className="space-y-2 pt-0.5">
          <FieldRow label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional notes for the worker..."
              rows={2}
              className="w-full bg-bg-raised border border-border-default rounded px-2 py-1 text-[11px] text-fg-default outline-none focus:border-blue-500 resize-y"
            />
          </FieldRow>
          <FieldRow label="Project">
            <input
              list="workboard-add-projects"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="inbox"
              className="w-full bg-bg-raised border border-border-default rounded px-2 py-1 text-[11px] text-fg-default outline-none focus:border-blue-500"
            />
          </FieldRow>
          <div className="grid grid-cols-[1fr_72px] gap-2">
            <FieldRow label="Worker">
              <input
                list="workboard-add-roles"
                value={workerRole}
                onChange={(e) => setWorkerRole(e.target.value)}
                placeholder="any"
                className="w-full bg-bg-raised border border-border-default rounded px-2 py-1 text-[11px] text-fg-default outline-none focus:border-blue-500"
              />
            </FieldRow>
            <FieldRow label="Priority">
              <input
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value) || 0)}
                className="w-full bg-bg-raised border border-border-default rounded px-2 py-1 text-[11px] text-fg-default outline-none focus:border-blue-500"
              />
            </FieldRow>
          </div>
          <FieldRow label="Depends on">
            <DependencyPicker
              value={dependsOn}
              onChange={setDependsOn}
              candidates={allTasks}
              project={project}
            />
          </FieldRow>
          <datalist id="workboard-add-roles">
            {workerRoles.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
          <datalist id="workboard-add-projects">
            {projects.map((p) => (
              <option key={p.project} value={p.project} />
            ))}
          </datalist>
        </div>
      )}

      <div className="flex items-center gap-1 pt-1">
        <span className="text-[9.5px] text-fg-fainter truncate">
          {showMore ? "Enter saves" : "Enter · Esc cancel"}
        </span>
        <button
          type="button"
          onClick={submit}
          disabled={!title.trim()}
          className="ml-auto px-2.5 py-0.5 text-[10.5px] rounded bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Add
        </button>
      </div>
    </li>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[9px] uppercase tracking-wide text-fg-faint mb-0.5">
        {label}
      </span>
      {children}
    </label>
  );
}

// ─── Dependency picker ───────────────────────────────────────
//
// Multi-select tag chips. Candidates are filtered to the same
// project (when set) so the user doesn't have to scroll past every
// task they own. Picking a candidate adds a chip; clicking the chip
// removes it. The blank "select..." option in the dropdown is the
// affordance for adding more.

function DependencyPicker({
  value,
  onChange,
  candidates,
  project,
  excludeId,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  candidates: Task[];
  /** Optional project slug to scope the candidates. Empty / Inbox
   *  shows tasks without a project. */
  project?: string;
  /** Optional id to exclude (the task being edited - it can't depend
   *  on itself). */
  excludeId?: string;
}) {
  const candidateMap = useMemo(
    () => new Map(candidates.map((t) => [t.id, t])),
    [candidates],
  );
  const filtered = useMemo(() => {
    const norm = (project ?? "").trim();
    return candidates.filter((t) => {
      if (t.id === excludeId) return false;
      if (value.includes(t.id)) return false;
      if (!norm) return true;
      if (norm === PROJECT_INBOX_KEY) return !t.project || t.project === PROJECT_INBOX_KEY;
      return t.project === norm;
    });
  }, [candidates, project, value, excludeId]);

  const remove = (id: string) => onChange(value.filter((x) => x !== id));
  const add = (id: string) => {
    if (!id || value.includes(id)) return;
    onChange([...value, id]);
  };

  return (
    <div className="space-y-1">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((id) => {
            const t = candidateMap.get(id);
            const label = t
              ? t.title
              : `${id.slice(0, 6)}... (deleted)`;
            const done = t?.status === "done";
            return (
              <span
                key={id}
                className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${
                  done
                    ? "text-success bg-success/10 border-success/30"
                    : "text-indigo-200 bg-indigo-500/15 border-indigo-500/40"
                }`}
                title={t ? `${t.status} · ${t.id}` : id}
              >
                {done ? (
                  <CheckCircle2 className="w-2.5 h-2.5" />
                ) : (
                  <Lock className="w-2.5 h-2.5" />
                )}
                <span className="truncate max-w-[140px]">{label}</span>
                <button
                  type="button"
                  onClick={() => remove(id)}
                  className="text-fg-muted hover:text-fg-default"
                  title="Remove"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            );
          })}
        </div>
      )}
      <select
        value=""
        onChange={(e) => {
          if (e.target.value) {
            add(e.target.value);
            // Reset the select so the same option can be re-picked
            // after a remove without page-state weirdness.
            e.target.value = "";
          }
        }}
        className="w-full bg-bg-raised border border-border-default rounded px-2 py-1 text-[11px] text-fg-default outline-none focus:border-blue-500"
      >
        <option value="">
          {filtered.length === 0
            ? value.length === 0
              ? "(no other tasks)"
              : "(no more candidates)"
            : "Add prerequisite..."}
        </option>
        {filtered.map((t) => (
          <option key={t.id} value={t.id}>
            [{t.status}] {t.title}
          </option>
        ))}
      </select>
    </div>
  );
}

// ─── Project chips strip ─────────────────────────────────────────

function ProjectChips({
  chips,
  active,
  onPick,
  showAll,
  rightExtras,
}: {
  chips: { key: string; label: string; count: number }[];
  active: string;
  onPick: (s: string) => void;
  showAll?: boolean;
  rightExtras?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border-subtle bg-bg-base/40 overflow-x-auto scrollbar-none flex-shrink-0">
      {showAll && (
        <Chip
          active={!active}
          label="All"
          count={chips.reduce((n, c) => n + c.count, 0)}
          onClick={() => onPick("")}
        />
      )}
      {chips.map((p) => (
        <Chip
          key={p.key || "all"}
          active={active === p.key}
          label={p.label}
          count={p.count}
          onClick={() => onPick(active === p.key ? "" : p.key)}
        />
      ))}
      {rightExtras}
    </div>
  );
}

function Chip({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "shrink-0 inline-flex items-center gap-1 rounded-full text-[11px] transition-colors px-2.5 py-0.5",
        active
          ? "bg-blue-500/20 border border-blue-400/50 text-blue-200"
          : "text-fg-muted hover:text-fg-default hover:bg-bg-raised/60 border border-transparent",
      ].join(" ")}
    >
      <span>{label}</span>
      <span className={active ? "text-blue-300/80" : "text-fg-fainter"}>
        {count}
      </span>
    </button>
  );
}

function WorkerStatusRow({
  snapshot,
  onNudge,
}: {
  snapshot: WorkerSnapshot | null;
  onNudge: () => void;
}) {
  if (!snapshot) {
    return (
      <div className="px-6 py-1.5 border-b border-border-subtle text-[11px] text-fg-faint flex-shrink-0">
        Workers: loading...
      </div>
    );
  }
  return (
    <div className="px-6 py-1.5 border-b border-border-subtle text-[11px] flex items-center gap-2 text-fg-muted flex-wrap flex-shrink-0">
      <Hammer className="w-3 h-3 text-fg-faint" />
      <span className="text-fg-faint">Worker types:</span>
      {snapshot.workers.map((w) => (
        <span
          key={w.agentId}
          title={`Type: ${w.kind}\nAgent: ${w.name}`}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border font-mono uppercase tracking-wide ${
            w.busy
              ? "bg-blue-900/40 border-blue-700 text-blue-100"
              : "bg-bg-elevated border-border-default text-fg-muted"
          }`}
        >
          {w.busy ? (
            <Loader2 className="w-2.5 h-2.5 animate-spin" />
          ) : (
            <CheckCircle2 className="w-2.5 h-2.5" />
          )}
          {w.kind}
        </span>
      ))}
      {snapshot.running.length > 0 && (
        <span className="text-fg-faint">
          running {snapshot.running.length} task
          {snapshot.running.length === 1 ? "" : "s"}
        </span>
      )}
      <button
        type="button"
        onClick={onNudge}
        className="ml-auto text-[10px] uppercase tracking-wide text-fg-muted hover:text-fg-default"
      >
        Nudge pool
      </button>
    </div>
  );
}

// ─── Modal: full task editor (admin only) ────────────────────────

function TaskModal({
  task,
  allTasks,
  busy,
  onClose,
  onPatch,
  onDelete,
}: {
  task: Task;
  allTasks: Task[];
  busy: boolean;
  onClose: () => void;
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const { Modal } = useUiPrimitives();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description || "");
  const [project, setProject] = useState(task.project || "");
  const [priority, setPriority] = useState(task.priority);
  const [workerRole, setWorkerRole] = useState(task.workerRole || "");
  const [dependsOn, setDependsOn] = useState<string[]>(task.dependsOn ?? []);

  // Re-sync local form state when the parent reloads with fresh data.
  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description || "");
    setProject(task.project || "");
    setPriority(task.priority);
    setWorkerRole(task.workerRole || "");
    setDependsOn(task.dependsOn ?? []);
  }, [
    task.id,
    task.title,
    task.description,
    task.project,
    task.priority,
    task.workerRole,
    task.dependsOn,
  ]);

  const allStatuses: TaskStatus[] = ["ready", "in_progress", "done"];

  const save = async () => {
    await onPatch({
      title,
      description: description || null,
      project: project || PROJECT_INBOX_KEY,
      priority,
      workerRole: workerRole.trim() || null,
      dependsOn,
    });
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="md"
      hideHeader
      className="bg-bg-base"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="px-4 py-3 border-b border-border-subtle flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase text-fg-faint tracking-wide">
              Task
            </span>
            <span className="text-[10px] text-fg-fainter font-mono truncate">
              {task.id}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="ml-auto p-1 rounded text-fg-muted hover:text-fg-default hover:bg-bg-raised"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {task.sandboxName && (
            <div
              className="flex items-center gap-1.5"
              title="Microsandbox VM bound to this task. Running while the worker is active, stopped after release (disk preserved), removed when the task is deleted."
            >
              <span className="text-[10px] uppercase text-fg-faint tracking-wide">
                Sandbox
              </span>
              <code
                className="text-[10px] text-fg-faint font-mono truncate cursor-pointer hover:text-fg-muted"
                onClick={(e) => {
                  if (!task.sandboxName) return;
                  void navigator.clipboard
                    ?.writeText(task.sandboxName)
                    .catch(() => {});
                  // Brief visual ack: bump opacity via title swap.
                  const t = e.currentTarget;
                  const orig = t.title;
                  t.title = "copied";
                  setTimeout(() => {
                    t.title = orig;
                  }, 800);
                }}
                title="Click to copy"
              >
                {task.sandboxName}
              </code>
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-3 text-xs">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-fg-faint mb-1">
              Title
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-2 py-1.5 bg-bg-elevated border border-border-default rounded outline-none focus:border-blue-600"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-fg-faint mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className="w-full px-2 py-1.5 bg-bg-elevated border border-border-default rounded outline-none focus:border-blue-600 resize-y"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-fg-faint mb-1">
                Project
              </label>
              <input
                value={project}
                onChange={(e) => setProject(e.target.value)}
                placeholder={PROJECT_INBOX_KEY}
                className="w-full px-2 py-1.5 bg-bg-elevated border border-border-default rounded outline-none focus:border-blue-600"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-fg-faint mb-1">
                Priority
              </label>
              <input
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value) || 0)}
                className="w-full px-2 py-1.5 bg-bg-elevated border border-border-default rounded outline-none focus:border-blue-600"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-fg-faint mb-1">
                Worker role
              </label>
              <input
                value={workerRole}
                onChange={(e) => setWorkerRole(e.target.value)}
                placeholder="any"
                className="w-full px-2 py-1.5 bg-bg-elevated border border-border-default rounded outline-none focus:border-blue-600"
              />
            </div>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-fg-faint mb-1">
              Status
            </label>
            <div className="flex flex-wrap gap-1">
              {allStatuses.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={busy || s === task.status}
                  onClick={() => void onPatch({ status: s })}
                  className={`text-[10px] px-2 py-1 rounded border ${
                    s === task.status
                      ? "bg-blue-700/40 border-blue-600 text-blue-100 cursor-default"
                      : "border-border-default text-fg-muted hover:bg-bg-raised hover:text-fg-default"
                  } disabled:cursor-not-allowed`}
                >
                  {s.replace("_", " ")}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-fg-faint mb-1">
              Depends on
            </label>
            <DependencyPicker
              value={dependsOn}
              onChange={setDependsOn}
              candidates={allTasks}
              project={project}
              excludeId={task.id}
            />
          </div>
          {task.resultSummary && (
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-fg-faint mb-1">
                Result
              </label>
              <div className="bg-bg-elevated border border-border-subtle rounded px-2 py-1.5 text-success italic whitespace-pre-line">
                {task.resultSummary}
              </div>
            </div>
          )}
          <div className="grid grid-cols-3 gap-2 text-[10px] text-fg-faint border-t border-border-subtle pt-2">
            <div>
              Created
              <div className="text-fg-muted">
                {new Date(task.createdAt).toLocaleString()}
              </div>
            </div>
            {task.startedAt && (
              <div>
                Started
                <div className="text-fg-muted">
                  {new Date(task.startedAt).toLocaleString()}
                </div>
              </div>
            )}
            {task.endedAt && (
              <div>
                Ended
                <div className="text-fg-muted">
                  {new Date(task.endedAt).toLocaleString()}
                </div>
              </div>
            )}
          </div>
        </div>

        <footer className="px-4 py-3 border-t border-border-subtle flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  `Delete task "${task.title}"? This is permanent.`,
                )
              ) {
                void onDelete();
              }
            }}
            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-red-800 text-red-200 hover:bg-red-900/30 disabled:opacity-50"
          >
            <Trash2 className="w-3 h-3" /> Delete
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto px-3 py-1 text-[11px] rounded border border-border-default text-fg-muted hover:bg-bg-raised"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="px-3 py-1 text-[11px] rounded bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save"}
          </button>
        </footer>
      </div>
    </Modal>
  );
}

// `WorkboardAdminPage` is intentionally not in `components` - the
// manifest's `adminPages` contribution was removed; resurrect it by
// re-adding both at the same time.
void WorkboardAdminPage;

// ─── Sidebar Workers section ──────────────────────────────
//
// Renders the workers contributed by THIS plugin in the host
// sidebar. v0.2 only ships the `echo` worker; future ADR-0002
// roles (qianliyan / luban / xihe / nvwa) ship as their own
// plugins and will append their own rows by claiming the same
// `sidebarSections.after = "workers"` anchor.
//
// The header and the row chrome live here too; the host
// `PluginSidebarSections` will stack rendered sections in order, so
// only the FIRST plugin's section paints the "Workers" header.
// (When more plugins arrive we will probably move the header into
// host code; for now keeping it here keeps the contract visible.)

function WorkersSidebarSection(_props: SidebarSectionProps) {
  const [snapshot, setSnapshot] = useState<WorkerSnapshot | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await getJson<WorkerSnapshot>(`${API_BASE}/workers/status`);
      setSnapshot(r);
    } catch {
      setSnapshot(null);
    }
  }, []);

  useEffect(() => {
    void reload();
    const id = window.setInterval(() => void reload(), 5000);
    return () => window.clearInterval(id);
  }, [reload]);

  const realWorkers = snapshot?.workers ?? [];
  const busyCount = realWorkers.filter((w) => w.busy).length;

  return (
    <div className="px-3 py-2">
      <div className="mb-2 flex items-center gap-2">
        <Zap size={14} className="flex-shrink-0 text-fg-fainter" />
        <span className="flex-1 text-sm font-medium text-fg-muted">
          Workers
        </span>
        <span className="rounded bg-bg-raised px-1.5 py-0.5 text-[9px] text-fg-fainter">
          {busyCount}/{realWorkers.length} busy
        </span>
      </div>
      <div className="space-y-1.5">
        {realWorkers.length === 0 ? (
          <div className="text-[10px] text-fg-fainter px-1">
            No workers running. Toggle echo on under Settings → Plugins →
            Workboard.
          </div>
        ) : (
          realWorkers.map((w) => (
            <SidebarWorkerRow
              key={w.agentId}
              name={w.name}
              kind={w.kind}
              busy={w.busy}
            />
          ))
        )}
      </div>
    </div>
  );
}

function SidebarWorkerRow({
  name,
  kind,
  busy,
}: {
  name: string;
  kind: string;
  busy: boolean;
}) {
  // The agent's display name (set in Settings → Plugins → Worker
  // agents) is the primary identity - the user wants to know which
  // configured instance this is at a glance. The worker *kind*
  // (echo / llm / future ADR-0002 roles) is shown as a small
  // secondary tag so two agents of the same kind stay
  // distinguishable without making the kind dominate the row.
  const emoji = kindEmoji(kind);
  return (
    <div
      className="flex cursor-default items-center gap-2 rounded py-0.5 pl-1 hover:bg-bg-hover/30"
      title={`Agent: ${name}\nWorker type: ${kind}`}
    >
      <span className="w-5 flex-shrink-0 text-center text-base">{emoji}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-fg-default">
          {name}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="truncate rounded bg-bg-raised/80 px-1 py-px font-mono text-[9px] font-semibold uppercase tracking-wide text-fg-muted">
            {kind}
          </span>
          <span
            className={`rounded px-1 py-px text-[9px] ${
              busy
                ? "bg-blue-900/40 text-blue-100 border border-blue-700"
                : "bg-bg-raised/60 text-fg-fainter"
            }`}
          >
            {busy ? "busy" : "idle"}
          </span>
        </div>
      </div>
    </div>
  );
}

function kindEmoji(kind: string): string {
  if (kind === "echo") return "🔁";
  return "⚙️";
}

/** Compact "5m ago" / "2h ago" / "3d ago" rendering for an ms
 *  timestamp. Used by the awaiting-intervention chip so the
 *  operator sees how long the task has been parked at a glance.
 *  We deliberately avoid `Intl.RelativeTimeFormat` because its
 *  output ("5 minutes ago") is too verbose for a chip. */
function formatRelative(ms: number): string {
  const delta = Math.max(0, Date.now() - ms);
  const sec = Math.round(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

const clientExports: PluginClientExports = {
  components: {
    WorkboardPanel: WorkboardPanel as PluginClientExports["components"][string],
    WorkersSidebarSection:
      WorkersSidebarSection as PluginClientExports["components"][string],
    WorkerAgentsPage:
      WorkerAgentsPage as PluginClientExports["components"][string],
  },
};

export const components = clientExports.components;
export default clientExports;
