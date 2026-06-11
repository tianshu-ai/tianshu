// Workboard plugin — client side.
//
// Right-column kanban panel inside the chat shell. 3 horizontal
// columns (todo / in-progress / done), sized for the narrow right
// rail. Add tasks inline (Todo column), drag across columns,
// dependency chips show 1f512 / 1f517 state.
//
// `WorkboardAdminPage` is kept in this file but NOT contributed via
// the manifest — it lived as a /admin/workboard/main page in earlier
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Clock,
  Hammer,
  Kanban,
  Link2,
  Loader2,
  Lock,
  Plus,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import type { AdminPageProps, PanelProps, PluginClientExports, SidebarSectionProps } from "@tianshu/plugin-sdk/client";
import WorkerAgentsPage from "./worker-agents-page.js";

const API_BASE = "/api/p/workboard";

type TaskStatus =
  | "todo"
  | "in_progress"
  | "done"
  | "stalled"
  | "aborted";

interface Task {
  id: string;
  title: string;
  description: string | null;
  project: string;
  workerRole: string | null;
  status: TaskStatus;
  priority: number;
  resultSummary: string | null;
  resultFiles: string[];
  sessionId: string | null;
  /** Task ids that must reach status='done' first. */
  dependsOn: string[];
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
  todo: number;
  inProgress: number;
  done: number;
  stalled: number;
  total: number;
}

interface WorkerSnapshot {
  workers: { agentId: string; name: string; kind: string; busy: boolean }[];
  running: string[];
}

const PROJECT_INBOX_KEY = "***";

interface ColumnSpec {
  status: TaskStatus;
  label: string;
  color: string;
  dot: string;
}

const BOARD_COLUMNS: ColumnSpec[] = [
  { status: "todo",        label: "Todo",        color: "border-indigo-500/40 bg-indigo-500/5",    dot: "bg-indigo-400" },
  { status: "in_progress", label: "In progress", color: "border-amber-500/40 bg-amber-500/5",      dot: "bg-amber-400 animate-pulse" },
  { status: "done",        label: "Done",        color: "border-emerald-500/40 bg-emerald-500/5",  dot: "bg-emerald-400" },
];

const EXTRA_COLUMNS: ColumnSpec[] = [
  { status: "stalled", label: "Stalled", color: "border-orange-500/40 bg-orange-500/5", dot: "bg-orange-400" },
  { status: "aborted", label: "Aborted", color: "border-red-500/40 bg-red-500/5",       dot: "bg-red-400" },
];

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
    if (visibleStatuses.includes("todo")) n += p.todo;
    if (visibleStatuses.includes("in_progress")) n += p.inProgress;
    if (visibleStatuses.includes("done")) n += p.done;
    if (visibleStatuses.includes("stalled")) n += p.stalled;
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
      ];
      if (opts.withWorker) {
        requests.push(getJson<WorkerSnapshot>(`${API_BASE}/workers/status`));
      }
      const results = await Promise.all(requests);
      setTasks((results[0] as { tasks: Task[] }).tasks);
      setProjects((results[1] as { projects: ProjectSummary[] }).projects);
      if (opts.withWorker) {
        setWorker(results[2] as WorkerSnapshot);
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
        await sendJson<{ task: Task }>(`${API_BASE}/tasks`, {
          title: input.title,
          status,
          project,
          priority: input.priority || 0,
          workerRole: input.workerRole || null,
          description: input.description || null,
        });
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
        await sendJson(`${API_BASE}/tasks/${id}`, null, "DELETE");
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
      projectChipsFromSummary(ctrl.projects, ["todo", "in_progress", "done"]),
    [ctrl.projects],
  );

  const drag = ctrl.bindDrag();

  return (
    <div className="flex flex-col h-full bg-gray-950 text-gray-100">
      <header className="flex items-center justify-between px-3 py-2 border-b border-gray-800 flex-shrink-0">
        <h2 className="flex items-center gap-1.5 font-semibold text-sm">
          <Kanban className="w-4 h-4" /> Tasks
        </h2>
        <button
          type="button"
          onClick={() => void ctrl.reload()}
          className="text-[10px] uppercase tracking-wide text-gray-400 hover:text-gray-100"
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
          <div className="flex items-center justify-center text-gray-500 py-8 h-full">
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
                allTasks={ctrl.tasks ?? []}
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
  const [includeArchived, setIncludeArchived] = useState(false);
  const ctrl = useBoardController({ includeArchived, withWorker: true });
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

  const visibleStatuses: TaskStatus[] = includeArchived
    ? ["todo", "in_progress", "done", "stalled", "aborted"]
    : ["todo", "in_progress", "done"];

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

  const renderColumns = includeArchived
    ? [...BOARD_COLUMNS, ...EXTRA_COLUMNS]
    : BOARD_COLUMNS;

  const drag = ctrl.bindDrag();

  return (
    <div className="flex flex-col h-full bg-gray-950 text-gray-100">
      <header className="px-6 py-4 border-b border-gray-800 flex-shrink-0">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Kanban className="w-5 h-5" /> Workboard
        </h1>
        <p className="text-xs text-gray-500 mt-1 max-w-3xl">
          Drag cards across columns. Click <Plus className="inline w-3 h-3 align-text-bottom" />{" "}
          on a column to add a task in place. Workers in the pool claim
          ready tasks and report back with a result summary.
          <span className="text-gray-600">
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
          rightExtras={
            <label className="ml-auto flex items-center gap-1.5 text-[11px] text-gray-400 shrink-0 mr-2">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
                className="accent-blue-600"
              />
              Show stalled / aborted
            </label>
          }
        />
      )}

      <WorkerStatusRow
        snapshot={ctrl.worker}
        onNudge={() => void sendJson(`${API_BASE}/workers/restart`, {})}
      />

      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        {ctrl.tasks === null ? (
          <div className="flex items-center text-gray-500 py-12 justify-center h-full">
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
                allTasks={ctrl.tasks ?? []}
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
  projects,
  workerRoles,
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
  projects: ProjectSummary[];
  workerRoles: string[];
  onDragStart: (e: DragEvent, taskId: string) => void;
  onDragEnd: () => void;
  onDrop: (e: DragEvent, targetStatus: TaskStatus) => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  return (
    <div
      className={`flex flex-col flex-1 min-w-[160px] rounded-lg border transition-colors ${
        isDragOver
          ? "border-blue-500/60 bg-gray-900/80"
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
      <header className="px-2 py-1.5 border-b border-gray-800/60 flex items-center gap-1.5 sticky top-0">
        <span className={`w-2 h-2 rounded-full ${column.dot}`} />
        <span className={`${compact ? "text-[11px]" : "text-xs"} font-medium`}>
          {column.label}
        </span>
        <span
          className={`ml-auto ${compact ? "text-[10px]" : "text-[11px]"} text-gray-500`}
        >
          {tasks.length}
        </span>
        {column.status === "todo" && (
          <button
            type="button"
            title="Add task"
            onClick={() => setShowAdd(true)}
            className="p-0.5 text-gray-600 hover:text-gray-200 rounded"
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
            meta={computeMeta(t, allTasks)}
            busy={busyId === t.id}
            compact={compact}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
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
            className={`text-center text-[10px] text-gray-600 py-3 ${
              column.status === "todo"
                ? "cursor-pointer hover:text-gray-400"
                : ""
            }`}
            onClick={
              column.status === "todo" ? () => setShowAdd(true) : undefined
            }
          >
            {column.status === "todo"
              ? "empty — click to add"
              : "empty"}
          </li>
        )}
      </ul>
    </div>
  );
}

function computeMeta(task: Task, allTasks: Task[]): TaskMeta {
  const byId = new Map(allTasks.map((t) => [t.id, t]));
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
    task.status === "todo" &&
    (pendingDeps.length > 0 || missingDepCount > 0);
  return { deps, pendingDeps, blocked };
}

function BoardCard({
  task,
  meta,
  busy,
  compact,
  onDragStart,
  onDragEnd,
}: {
  task: Task;
  meta: TaskMeta;
  busy: boolean;
  compact?: boolean;
  onDragStart: (e: DragEvent, taskId: string) => void;
  onDragEnd: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMore =
    Boolean(task.description?.trim()) ||
    Boolean(task.resultSummary?.trim()) ||
    meta.deps.length > 0;
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
        // braces — but we do swallow the event so the column-level
        // drop handler doesn't see it.
        e.stopPropagation();
        if (hasMore) setExpanded((v) => !v);
      }}
      className={`rounded border bg-gray-900/60 hover:border-gray-700 ${
        meta.blocked
          ? "border-indigo-500/40"
          : "border-gray-800"
      } ${hasMore ? "cursor-pointer" : "cursor-grab"} ${busy ? "opacity-60" : ""}`}
    >
      <div className="px-2 py-1.5 flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 flex-wrap">
            <span
              className={`${compact ? "text-[11.5px]" : "text-xs"} font-medium text-gray-100 break-words`}
            >
              {task.title}
            </span>
            {task.priority > 0 && (
              <span className="text-[9px] px-1 rounded bg-amber-900/50 text-amber-100">
                p{task.priority}
              </span>
            )}
            {task.workerRole && (
              <span className="text-[9px] px-1 rounded bg-indigo-900/50 text-indigo-100">
                {task.workerRole}
              </span>
            )}
            {task.project && task.project !== PROJECT_INBOX_KEY && (
              <span className="text-[9px] px-1 rounded bg-gray-800 text-gray-400">
                #{task.project}
              </span>
            )}
            {(task.dependsOn?.length ?? 0) > 0 && (
              <span
                className={`inline-flex items-center gap-0.5 text-[9px] px-1 rounded border ${
                  meta.blocked
                    ? "text-indigo-200 bg-indigo-500/15 border-indigo-500/40"
                    : "text-gray-400 bg-gray-700/30 border-gray-700"
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
          {task.description && !expanded && (
            <div className="text-[10.5px] text-gray-400 mt-0.5 line-clamp-2 whitespace-pre-line">
              {task.description}
            </div>
          )}
          {task.resultSummary && !expanded && (
            <div
              className={`${compact ? "text-[10px]" : "text-[10.5px]"} text-emerald-300/80 mt-0.5 italic line-clamp-2 whitespace-pre-line`}
            >
              → {task.resultSummary}
            </div>
          )}
          <div className="text-[9.5px] text-gray-500 mt-0.5 flex items-center gap-1">
            <Clock className="w-2.5 h-2.5" />
            {fmtRelative(task.endedAt ?? task.startedAt ?? task.createdAt)}
          </div>
        </div>
        {hasMore && (
          <ChevronDown
            className={`w-3 h-3 mt-0.5 text-gray-500 shrink-0 transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
          />
        )}
        {busy && <Loader2 className="w-3 h-3 animate-spin text-gray-400" />}
      </div>
      {expanded && (
        <div
          className="px-2 pb-2 pt-0 border-t border-gray-800/60 space-y-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          {task.description && (
            <Section label="Description">
              <div className="text-[10.5px] text-gray-300 whitespace-pre-line break-words max-h-48 overflow-y-auto">
                {task.description}
              </div>
            </Section>
          )}
          {task.resultSummary && (
            <Section label="Result">
              <div className="text-[10.5px] text-emerald-300/90 italic whitespace-pre-line break-words max-h-48 overflow-y-auto">
                → {task.resultSummary}
              </div>
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
                      <CheckCircle2 className="w-2.5 h-2.5 text-emerald-400 shrink-0" />
                    ) : (
                      <Lock className="w-2.5 h-2.5 text-indigo-400 shrink-0" />
                    )}
                    <span
                      className={`truncate ${
                        d.status === "done"
                          ? "text-gray-400 line-through"
                          : "text-indigo-200"
                      }`}
                    >
                      {d.title}
                    </span>
                    <span className="ml-auto text-[9px] text-gray-600 shrink-0">
                      {d.status.replace("_", " ")}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <div className="grid grid-cols-2 gap-x-3 gap-y-0 text-[9.5px] text-gray-500 pt-1">
            <div>
              Created 
              <span className="text-gray-300">
                {new Date(task.createdAt).toLocaleString()}
              </span>
            </div>
            {task.startedAt && (
              <div>
                Started 
                <span className="text-gray-300">
                  {new Date(task.startedAt).toLocaleString()}
                </span>
              </div>
            )}
            {task.endedAt && (
              <div>
                Ended 
                <span className="text-gray-300">
                  {new Date(task.endedAt).toLocaleString()}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </li>
  );
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
      <div className="text-[9px] uppercase tracking-wide text-gray-500 mb-0.5">
        {label}
      </div>
      {children}
    </div>
  );
}

function nextStatus(status: TaskStatus): TaskStatus | null {
  if (status === "todo") return "in_progress";
  if (status === "in_progress") return "done";
  if (status === "stalled") return "todo";
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
    <li className="rounded border border-blue-500/50 bg-gray-900/70 p-1.5 space-y-1">
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
          placeholder="Task title…"
          className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11.5px] text-gray-100 outline-none focus:border-blue-500"
        />
        <button
          type="button"
          title={showMore ? "Less" : "More fields"}
          onClick={() => setShowMore((v) => !v)}
          className="p-0.5 text-gray-500 hover:text-gray-200"
        >
          <ChevronDown
            className={`w-3 h-3 transition-transform ${showMore ? "rotate-180" : ""}`}
          />
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="p-0.5 text-gray-500 hover:text-gray-200"
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
              placeholder="Optional notes for the worker…"
              rows={2}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-100 outline-none focus:border-blue-500 resize-y"
            />
          </FieldRow>
          <FieldRow label="Project">
            <input
              list="workboard-add-projects"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="inbox"
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-100 outline-none focus:border-blue-500"
            />
          </FieldRow>
          <div className="grid grid-cols-[1fr_72px] gap-2">
            <FieldRow label="Worker">
              <input
                list="workboard-add-roles"
                value={workerRole}
                onChange={(e) => setWorkerRole(e.target.value)}
                placeholder="any"
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-100 outline-none focus:border-blue-500"
              />
            </FieldRow>
            <FieldRow label="Priority">
              <input
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value) || 0)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-100 outline-none focus:border-blue-500"
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
        <span className="text-[9.5px] text-gray-600 truncate">
          {showMore ? "Enter saves" : "Enter · Esc cancel"}
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
      <span className="block text-[9px] uppercase tracking-wide text-gray-500 mb-0.5">
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
// removes it. The blank "select…" option in the dropdown is the
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
  /** Optional id to exclude (the task being edited — it can't depend
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
              : `${id.slice(0, 6)}… (deleted)`;
            const done = t?.status === "done";
            return (
              <span
                key={id}
                className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${
                  done
                    ? "text-emerald-200 bg-emerald-500/10 border-emerald-500/30"
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
                  className="text-gray-400 hover:text-gray-100"
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
        className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-100 outline-none focus:border-blue-500"
      >
        <option value="">
          {filtered.length === 0
            ? value.length === 0
              ? "(no other tasks)"
              : "(no more candidates)"
            : "Add prerequisite…"}
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
    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-800 bg-gray-950/40 overflow-x-auto scrollbar-none flex-shrink-0">
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
          : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/60 border border-transparent",
      ].join(" ")}
    >
      <span>{label}</span>
      <span className={active ? "text-blue-300/80" : "text-gray-600"}>
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
      <div className="px-6 py-1.5 border-b border-gray-800 text-[11px] text-gray-500 flex-shrink-0">
        Workers: loading…
      </div>
    );
  }
  return (
    <div className="px-6 py-1.5 border-b border-gray-800 text-[11px] flex items-center gap-2 text-gray-300 flex-wrap flex-shrink-0">
      <Hammer className="w-3 h-3 text-gray-500" />
      <span className="text-gray-500">Worker types:</span>
      {snapshot.workers.map((w) => (
        <span
          key={w.agentId}
          title={`Type: ${w.kind}\nAgent: ${w.name}`}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border font-mono uppercase tracking-wide ${
            w.busy
              ? "bg-blue-900/40 border-blue-700 text-blue-100"
              : "bg-gray-900 border-gray-700 text-gray-400"
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
        <span className="text-gray-500">
          running {snapshot.running.length} task
          {snapshot.running.length === 1 ? "" : "s"}
        </span>
      )}
      <button
        type="button"
        onClick={onNudge}
        className="ml-auto text-[10px] uppercase tracking-wide text-gray-400 hover:text-gray-100"
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

  const allStatuses: TaskStatus[] = [
    "todo",
    "in_progress",
    "done",
    "stalled",
    "aborted",
  ];

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
    <div
      className="fixed inset-0 bg-black/60 z-40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl bg-gray-950 border border-gray-800 rounded-lg shadow-xl flex flex-col max-h-[80vh] overflow-hidden"
      >
        <header className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
          <span className="text-[10px] uppercase text-gray-500 tracking-wide">
            Task
          </span>
          <span className="text-[10px] text-gray-600 font-mono truncate">
            {task.id}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto p-1 rounded text-gray-400 hover:text-gray-100 hover:bg-gray-800"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-3 text-xs">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
              Title
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded outline-none focus:border-blue-600"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded outline-none focus:border-blue-600 resize-y"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
                Project
              </label>
              <input
                value={project}
                onChange={(e) => setProject(e.target.value)}
                placeholder={PROJECT_INBOX_KEY}
                className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded outline-none focus:border-blue-600"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
                Priority
              </label>
              <input
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value) || 0)}
                className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded outline-none focus:border-blue-600"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
                Worker role
              </label>
              <input
                value={workerRole}
                onChange={(e) => setWorkerRole(e.target.value)}
                placeholder="any"
                className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded outline-none focus:border-blue-600"
              />
            </div>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
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
                      : "border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-gray-100"
                  } disabled:cursor-not-allowed`}
                >
                  {s.replace("_", " ")}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
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
              <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
                Result
              </label>
              <div className="bg-gray-900 border border-gray-800 rounded px-2 py-1.5 text-emerald-200 italic whitespace-pre-line">
                {task.resultSummary}
              </div>
            </div>
          )}
          <div className="grid grid-cols-3 gap-2 text-[10px] text-gray-500 border-t border-gray-800 pt-2">
            <div>
              Created
              <div className="text-gray-300">
                {new Date(task.createdAt).toLocaleString()}
              </div>
            </div>
            {task.startedAt && (
              <div>
                Started
                <div className="text-gray-300">
                  {new Date(task.startedAt).toLocaleString()}
                </div>
              </div>
            )}
            {task.endedAt && (
              <div>
                Ended
                <div className="text-gray-300">
                  {new Date(task.endedAt).toLocaleString()}
                </div>
              </div>
            )}
          </div>
        </div>

        <footer className="px-4 py-3 border-t border-gray-800 flex items-center gap-2">
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
            className="ml-auto px-3 py-1 text-[11px] rounded border border-gray-700 text-gray-300 hover:bg-gray-800"
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
    </div>
  );
}

// `WorkboardAdminPage` is intentionally not in `components` — the
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
        <Zap size={14} className="flex-shrink-0 text-gray-600" />
        <span className="flex-1 text-sm font-medium text-gray-300">
          Workers
        </span>
        <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[9px] text-gray-600">
          {busyCount}/{realWorkers.length} busy
        </span>
      </div>
      <div className="space-y-1.5">
        {realWorkers.length === 0 ? (
          <div className="text-[10px] text-gray-600 px-1">
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
  // agents) is the primary identity — the user wants to know which
  // configured instance this is at a glance. The worker *kind*
  // (echo / llm / future ADR-0002 roles) is shown as a small
  // secondary tag so two agents of the same kind stay
  // distinguishable without making the kind dominate the row.
  const emoji = kindEmoji(kind);
  return (
    <div
      className="flex cursor-default items-center gap-2 rounded py-0.5 pl-1 hover:bg-gray-700/30"
      title={`Agent: ${name}\nWorker type: ${kind}`}
    >
      <span className="w-5 flex-shrink-0 text-center text-base">{emoji}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-gray-200">
          {name}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="truncate rounded bg-gray-800/80 px-1 py-px font-mono text-[9px] font-semibold uppercase tracking-wide text-gray-400">
            {kind}
          </span>
          <span
            className={`rounded px-1 py-px text-[9px] ${
              busy
                ? "bg-blue-900/40 text-blue-100 border border-blue-700"
                : "bg-gray-800/60 text-gray-600"
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
