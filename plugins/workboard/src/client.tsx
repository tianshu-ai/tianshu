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
  Globe,
  MessageSquare,
  Send,
  List,
  Pin,
} from "lucide-react";
import {
  subscribeToWsEvent,
  useOpenFile,
  usePluginT,
  useDateLocale,
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
  /** Channel names for multi-channel completion notification.
   *  Displayed as small badges on the card (e.g. "webchat",
   *  "wechat"). NULL means fallback to parentSessionId. */
  notifyChannels?: string[] | null;
  /** Per-task time estimate in ms. Used by supervision watchdog. */
  estimatedDurationMs?: number | null;
  /** Next supervision check epoch ms. */
  nextCheckAt?: number | null;
  /** Default watchdog timeout ms from the task row. */
  timeoutMs?: number;
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

type Translator = (key: string, params?: Record<string, string | number>) => string;

function fmtRelative(ms: number | null, t?: Translator): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return t ? t("panel.time.justNow") : "just now";
  if (diff < 3_600_000) {
    const n = Math.floor(diff / 60_000);
    return t ? t("panel.time.minutesAgo", { n }) : `${n}m ago`;
  }
  if (diff < 86_400_000) {
    const n = Math.floor(diff / 3_600_000);
    return t ? t("panel.time.hoursAgo", { n }) : `${n}h ago`;
  }
  const n = Math.floor(diff / 86_400_000);
  return t ? t("panel.time.daysAgo", { n }) : `${n}d ago`;
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
    // Event-driven: the server pushes `workboard:workboard.task` on
    // every claim/completion, so reload immediately on a push instead
    // of polling on a tight timer. A slow 15s interval stays as a
    // safety net (missed event / dropped ws / non-host shell where
    // subscribeToWsEvent is a no-op). Debounce bursts (a batch of
    // task events shouldn't fire N reloads).
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const kick = () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        void reload();
      }, 250);
    };
    const off = subscribeToWsEvent<{ type: string; event?: string }>(
      "plugin_event",
      (ev) => {
        if (ev.event === "workboard:workboard.task") kick();
      },
    );
    const id = window.setInterval(() => void reload(), 15000);
    return () => {
      off();
      if (debounce) clearTimeout(debounce);
      window.clearInterval(id);
    };
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
  const t = usePluginT("workboard");
  const ctrl = useBoardController({ includeArchived: false, withWorker: false });
  const [projectFilter, setProjectFilter] = useState<string>("");
  const [viewMode, setViewMode] = usePersistedViewMode();
  const [selected, setSelected] = useState<Task | null>(null);

  // Sync selected task with latest data
  useEffect(() => {
    if (!selected || !ctrl.tasks) return;
    const fresh = ctrl.tasks.find((t) => t.id === selected.id);
    if (!fresh) setSelected(null);
    else if (fresh !== selected) setSelected(fresh);
  }, [ctrl.tasks, selected]);

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
          {viewMode === "kanban" ? <Kanban className="w-4 h-4" /> : <List className="w-4 h-4" />}
          {t("panel.title")}
        </h2>
        <div className="flex items-center gap-1">
          <div className="flex items-center gap-0.5 rounded bg-bg-raised p-0.5 mr-1">
            <button
              type="button"
              onClick={() => setViewMode("kanban")}
              className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                viewMode === "kanban"
                  ? "bg-bg-surface text-fg-default shadow-sm"
                  : "text-fg-muted hover:text-fg-default"
              }`}
            >
              <Kanban className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode("list")}
              className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                viewMode === "list"
                  ? "bg-bg-surface text-fg-default shadow-sm"
                  : "text-fg-muted hover:text-fg-default"
              }`}
            >
              <List className="w-3 h-3" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => void ctrl.reload()}
            className="text-xs uppercase tracking-wide text-fg-muted hover:text-fg-default"
          >
            {t("panel.refresh")}
          </button>
        </div>
      </header>

      {viewMode === "kanban" && chips.length > 1 && (
        <ProjectChips
          chips={chips}
          active={projectFilter}
          onPick={setProjectFilter}
        />
      )}

      {ctrl.error && (
        <div className="px-3 py-1.5 text-sm bg-red-900/40 border-b border-red-800 text-red-100 flex-shrink-0">
          {ctrl.error}
        </div>
      )}

      {ctrl.tasks === null ? (
        <div className="flex-1 flex items-center justify-center text-fg-faint py-8">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      ) : viewMode === "list" ? (
        <ListView
          tasks={ctrl.tasks ?? []}
          agentNames={ctrl.agentNames}
          onSelect={setSelected}
        />
      ) : (
        <div className="flex-1 overflow-x-auto overflow-y-hidden">
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
                onDeleteTask={ctrl.deleteTask}
                onDragStart={drag.onDragStart}
                onDragEnd={drag.onDragEnd}
                onDrop={drag.onDrop}
              />
            ))}
          </div>
        </div>
      )}

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

// ─── Admin page: full board ──────────────────────────────────────

type ViewMode = "kanban" | "list";

function usePersistedViewMode(): [ViewMode, (v: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(() => {
    try {
      const s = localStorage.getItem("workboard:view-mode");
      if (s === "kanban" || s === "list") return s;
    } catch { /* ignore */ }
    return "list";
  });
  const set = useCallback((v: ViewMode) => {
    setMode(v);
    try { localStorage.setItem("workboard:view-mode", v); } catch { /* ignore */ }
  }, []);
  return [mode, set];
}

function WorkboardAdminPage(_props: AdminPageProps) {
  const t = usePluginT("workboard");
  const ctrl = useBoardController({ includeArchived: false, withWorker: true });
  const [projectFilter, setProjectFilter] = useState<string>("");
  const [selected, setSelected] = useState<Task | null>(null);
  const [viewMode, setViewMode] = usePersistedViewMode();

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
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold flex items-center gap-2">
            {viewMode === "kanban" ? <Kanban className="w-5 h-5" /> : <List className="w-5 h-5" />}
            {t("panel.admin.title")}
          </h1>
          <div className="flex items-center gap-0.5 rounded-lg bg-bg-raised p-0.5">
            <button
              type="button"
              onClick={() => setViewMode("kanban")}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                viewMode === "kanban"
                  ? "bg-bg-surface text-fg-default shadow-sm"
                  : "text-fg-muted hover:text-fg-default"
              }`}
            >
              <Kanban className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />
              Board
            </button>
            <button
              type="button"
              onClick={() => setViewMode("list")}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                viewMode === "list"
                  ? "bg-bg-surface text-fg-default shadow-sm"
                  : "text-fg-muted hover:text-fg-default"
              }`}
            >
              <List className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />
              List
            </button>
          </div>
        </div>
        {viewMode === "kanban" && (
          <p className="text-sm text-fg-faint mt-1 max-w-3xl">
            {t("panel.admin.descPart1")}
            <Plus className="inline w-3 h-3 align-text-bottom" />
            {t("panel.admin.descPart2")}
            <span className="text-fg-fainter">
              {t("panel.admin.descPart3")}
            </span>
          </p>
        )}
      </header>

      {ctrl.error && (
        <div className="mx-6 mt-3 px-3 py-2 rounded bg-red-900/40 border border-red-800 text-sm text-red-100 flex-shrink-0">
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

      {ctrl.tasks === null ? (
        <div className="flex-1 flex items-center text-fg-faint py-12 justify-center">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : viewMode === "list" ? (
        <ListView
          tasks={visibleTasks ?? []}
          agentNames={ctrl.agentNames}
          onSelect={setSelected}
        />
      ) : (
        <div className="flex-1 overflow-x-auto overflow-y-hidden">
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
                onDeleteTask={ctrl.deleteTask}
                onDragStart={drag.onDragStart}
                onDragEnd={drag.onDragEnd}
                onDrop={drag.onDrop}
              />
            ))}
          </div>
        </div>
      )}

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
  onDeleteTask,
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
  /** Card-initiated delete (quick delete from the card, with an
   *  in-card confirm step). */
  onDeleteTask: (id: string) => Promise<void>;
  projects: ProjectSummary[];
  workerRoles: string[];
  /** Slug → worker display name for the assignee chip. */
  agentNames: Map<string, string>;
  onDragStart: (e: DragEvent, taskId: string) => void;
  onDragEnd: () => void;
  onDrop: (e: DragEvent, targetStatus: TaskStatus) => void;
}) {
  const t = usePluginT("workboard");
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
        <span className={`${compact ? "text-xs" : "text-xs"} font-medium`}>
          {column.status === "ready"
            ? t("panel.column.ready")
            : column.status === "in_progress"
              ? t("panel.column.inProgress")
              : column.status === "done"
                ? t("panel.column.done")
                : column.label}
        </span>
        <span
          className={`ml-auto ${compact ? "text-xs" : "text-xs"} text-fg-faint`}
        >
          {tasks.length}
        </span>
        {column.status === "ready" && (
          <button
            type="button"
            title={t("panel.column.addTaskTitle")}
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
            onDelete={onDeleteTask}
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
            className={`text-center text-xs text-fg-fainter py-3 ${
              column.status === "ready"
                ? "cursor-pointer hover:text-fg-muted"
                : ""
            }`}
            onClick={
              column.status === "ready" ? () => setShowAdd(true) : undefined
            }
          >
            {column.status === "ready"
              ? t("panel.column.emptyClickAdd")
              : t("panel.column.empty")}
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
  onDelete,
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
  onDelete: (id: string) => Promise<void>;
}) {
  const t = usePluginT("workboard");
  const dateLoc = useDateLocale();
  const { Modal } = useUiPrimitives();
  const [expanded, setExpanded] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Reactive pin state — shared with sidebar MiniTaskList
  const [isPinned, setIsPinned] = useState(false);
  useEffect(() => {
    const store = (window as any).__tianshuComposerStore;
    if (!store?.subscribe) return;
    const pinId = `task:${task.id}`;
    const update = () => setIsPinned(
      (store.getState().pinnedContexts ?? []).some((c: { id: string }) => c.id === pinId),
    );
    update();
    return store.subscribe(update);
  }, [task.id]);
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
      className={`group relative rounded border bg-bg-elevated/60 hover:border-border-default ${
        meta.blocked
          ? "border-indigo-500/40"
          : "border-border-subtle"
      } ${hasMore ? "cursor-pointer" : "cursor-grab"} ${busy ? "opacity-60" : ""}`}
    >
      <div className="px-2 py-1.5 flex items-start gap-1.5">
        <button
          type="button"
          title={isPinned ? "Unpin from chat" : "Pin to chat"}
          onClick={(e) => {
            e.stopPropagation();
            const composerStore = (window as any).__tianshuComposerStore;
            if (!composerStore?.getState?.()?.pinContext) return;
            const state = composerStore.getState();
            const pinId = `task:${task.id}`;
            if (state.pinnedContexts.some((c: { id: string }) => c.id === pinId)) {
              state.unpinContext(pinId);
            } else {
              const workerName = agentNames.get(task.workerAgentId ?? "") || task.workerAgentId || "";
              state.pinContext({
                id: pinId,
                kind: "task",
                label: task.title,
                summary: `task_id=${task.id}`,
              });
            }
          }}
          className={`mt-0.5 flex-shrink-0 rounded p-0.5 transition-colors ${
            isPinned
              ? "text-accent bg-accent/15"
              : "text-fg-fainter opacity-0 group-hover:opacity-100 hover:text-accent hover:bg-accent/10"
          }`}
        >
          <Pin size={12} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 flex-wrap">
            <span
              className={`${compact ? "text-xs" : "text-xs"} font-medium text-fg-default break-words`}
            >
              {(() => {
                const ch = (task.notifyChannels && task.notifyChannels.length > 0
                  ? task.notifyChannels
                  : ["webchat"])[0];
                const Icon = ch === "wechat" ? MessageSquare : ch === "telegram" ? Send : Globe;
                return <Icon className="w-3 h-3 inline align-text-bottom text-fg-faint mr-1" />;
              })()}
              {task.title}
            </span>
            {task.priority > 0 && (
              <span className="text-xs px-1 rounded bg-amber-900/50 text-amber-100">
                p{task.priority}
              </span>
            )}
            {task.workerAgentId && (
              <span
                className="text-xs px-1 rounded bg-indigo-900/50 text-indigo-100"
                title={t("panel.card.assigneeTitle", { slug: task.workerAgentId })}
              >
                @{agentNames.get(task.workerAgentId) ?? task.workerAgentId}
              </span>
            )}
            {!task.workerAgentId && task.workerRole && (
              // Legacy rows: pre-PR-C tasks still carry workerRole
              // (kind id) without a workerAgentId. Show it so old
              // records aren't blank.
              <span
                className="text-xs px-1 rounded bg-bg-raised text-fg-muted"
                title={t("panel.card.legacyRoleTitle")}
              >
                {task.workerRole}
              </span>
            )}
            {task.project && task.project !== PROJECT_INBOX_KEY && (
              <span className="text-xs px-1 rounded bg-bg-raised text-fg-muted">
                #{task.project}
              </span>
            )}
            {(task.dependsOn?.length ?? 0) > 0 && (
              <span
                className={`inline-flex items-center gap-0.5 text-xs px-1 rounded border ${
                  meta.blocked
                    ? "text-indigo-200 bg-indigo-500/15 border-indigo-500/40"
                    : "text-fg-muted bg-bg-hover/30 border-border-default"
                }`}
                title={
                  meta.blocked
                    ? t("panel.card.waitingOn", {
                        names: meta.pendingDeps.map((d) => d.title).join(", "),
                      })
                    : meta.deps.length === 1
                      ? t("panel.card.depsSatisfiedOne", { n: meta.deps.length })
                      : t("panel.card.depsSatisfiedMany", { n: meta.deps.length })
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
              className="mt-1 flex items-start gap-1 rounded border border-rose-500/50 bg-rose-500/10 px-1.5 py-1 text-xs text-danger"
              title={task.interventionReason ?? task.failureReason ?? ""}
              onClick={(e) => e.stopPropagation()}
            >
              <AlertTriangle className="w-3 h-3 mt-px shrink-0" />
              <span className="min-w-0 flex-1 break-words line-clamp-3">
                <span className="font-medium">{t("panel.card.awaitingIntervention")}</span>
                {task.interventionAt
                  ? ` (${formatRelative(task.interventionAt, t)})`
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
                className="shrink-0 rounded bg-rose-600 px-1.5 py-px text-xs font-medium text-white hover:bg-rose-500 disabled:opacity-50"
              >
                {t("panel.card.retry")}
              </button>
            </div>
          )}
          {(task.labels ?? []).includes("stalled") && (
            <div
              className="mt-1 flex items-start gap-1 rounded border border-orange-500/40 bg-orange-500/5 px-1.5 py-1 text-xs text-orange-200"
              title={task.failureReason ?? ""}
              onClick={(e) => e.stopPropagation()}
            >
              <AlertTriangle className="w-3 h-3 mt-px shrink-0" />
              <span className="min-w-0 flex-1 break-words line-clamp-3">
                {(task.attempts ?? 0) > 0
                  ? t("panel.card.stalledAfter", { n: task.attempts ?? 0 })
                  : t("panel.card.stalled")}
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
                className="shrink-0 rounded bg-orange-600 px-1.5 py-px text-xs font-medium text-white hover:bg-orange-500 disabled:opacity-50"
              >
                {t("panel.card.retry")}
              </button>
            </div>
          )}
          {(task.labels ?? []).includes("draft") && (
            <div
              className="mt-1 flex items-center gap-1.5"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="inline-block rounded border border-yellow-500/40 bg-yellow-500/5 px-1.5 py-px text-xs text-yellow-200">
                {t("panel.card.draftSkip")}
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
                className="rounded border border-yellow-500/40 px-1 py-px text-xs font-medium text-yellow-100 hover:bg-yellow-500/15 disabled:opacity-50"
              >
                {t("panel.card.publish")}
              </button>
            </div>
          )}
          {task.description && !expanded && (
            <div className="text-xs text-fg-muted mt-0.5 line-clamp-2 whitespace-pre-line">
              {task.description}
            </div>
          )}
          {task.resultSummary && !expanded && (
            <div
              className={`${compact ? "text-xs" : "text-xs"} text-success/90 mt-0.5 italic line-clamp-2 whitespace-pre-line`}
            >
              → {task.resultSummary}
            </div>
          )}
          {task.status === "in_progress" && task.startedAt ? (
            <TaskProgressBar task={task} />
          ) : (
            <div className="text-xs text-fg-faint mt-0.5 flex items-center gap-1">
              <Clock className="w-2.5 h-2.5" />
              {fmtRelative(task.endedAt ?? task.startedAt ?? task.createdAt, t)}
            </div>
          )}
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
            <Section label={t("panel.section.description")}>
              <div className="text-xs text-fg-muted whitespace-pre-line break-words max-h-32 overflow-y-auto">
                {task.description.replace(/^\[(?:Triggered at|System):?[^\]]*\]\s*/i, "").trim()}
              </div>
            </Section>
          )}
          {task.resultSummary && (
            <Section label={t("panel.section.result")}>
              <div className="text-xs text-success whitespace-pre-line break-words max-h-24 overflow-y-auto">
                {task.resultSummary}
              </div>
            </Section>
          )}
          {task.resultFiles.length > 0 && (
            <Section label={t("panel.section.files", { n: task.resultFiles.length })}>
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
            <Section label={t("panel.section.dependsOn")}>
              <ul className="space-y-0.5">
                {meta.deps.map((d) => (
                  <li
                    key={d.id}
                    className="text-xs flex items-center gap-1"
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
                    <span className="ml-auto text-xs text-fg-fainter shrink-0">
                      {d.status.replace("_", " ")}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <div className="flex flex-wrap gap-x-3 text-[10px] text-fg-fainter pt-1">
            <span>{new Date(task.createdAt).toLocaleDateString(dateLoc)}</span>
            {task.startedAt && task.endedAt && (
              <span>
                {Math.round((task.endedAt - task.startedAt) / 1000)}s
              </span>
            )}
          </div>
          <ExecutionSection task={task} workerName={task.workerAgentId ?? task.workerRole ?? undefined} workerKind={task.workerRole ?? undefined} />
        </div>
      )}
      {/* Quick delete: bottom-right, away from the top-right expand
          chevron so the two can't be mis-clicked. Hover-revealed;
          confirms first; stops propagation so it doesn't toggle
          expand or start a drag. */}
      <button
        type="button"
        disabled={busy}
        title={t("panel.card.deleteTaskTitle")}
        onClick={(e) => {
          e.stopPropagation();
          setConfirmingDelete(true);
        }}
        className="absolute bottom-1 right-1 z-10 p-0.5 rounded opacity-0 group-hover:opacity-100 text-fg-fainter hover:text-red-400 hover:bg-bg-raised transition-opacity disabled:opacity-0"
      >
        <Trash2 className="w-3 h-3" />
      </button>

      {/* Styled confirm (SDK Modal) instead of a native window.confirm,
          to match the rest of the UI. stopPropagation on the wrapper
          so clicks inside don't toggle the card's expand. */}
      <div onClick={(e) => e.stopPropagation()}>
        <Modal
          isOpen={confirmingDelete}
          onClose={() => setConfirmingDelete(false)}
          title={t("panel.delete.modalTitle")}
          size="sm"
          allowMaximize={false}
        >
          <div className="flex flex-col gap-4 p-1">
            <p className="text-sm text-fg-muted">
              {t("panel.delete.confirmPre")}
              <span className="font-medium text-fg-default">
                “{task.title}”
              </span>
              {t("panel.delete.confirmPost")}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover transition-colors"
              >
                {t("panel.delete.cancel")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirmingDelete(false);
                  void onDelete(task.id);
                }}
                className="text-xs px-3 py-1.5 rounded-md bg-danger text-fg-on-accent font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {t("panel.delete.delete")}
              </button>
            </div>
          </div>
        </Modal>
      </div>
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
/** Live progress bar for in_progress tasks. Shows elapsed time,
 *  estimated duration, and a visual progress indicator. Ticks
 *  every second while mounted. */
/** Phase background style by generation index. Interpolates hue
 *  from blue(210) through amber(45) to red(0) as generations grow.
 *  Uses inline styles since Tailwind can't handle dynamic HSL. */
function phaseStyle(gen: number): { backgroundColor: string } {
  if (gen === 0) return { backgroundColor: "hsla(160,50%,42%,0.85)" }; // teal-green — on budget
  // Overrun: warm escalation — amber → orange → red-orange → red
  const hues = [38, 25, 12, 0];
  const idx = Math.min(gen - 1, hues.length - 1);
  return { backgroundColor: `hsla(${hues[idx]},80%,50%,0.85)` };
}

// ─── List view: Linear-style status-grouped task list ────────────

const STATUS_FILTER_OPTIONS: { status: TaskStatus; label: string; icon: React.ReactNode }[] = [
  { status: "in_progress", label: "In Progress", icon: <span className="w-2 h-2 rounded-full bg-amber-400" /> },
  { status: "ready", label: "Ready", icon: <span className="w-2 h-2 rounded-full border border-fg-muted" /> },
  { status: "done", label: "Done", icon: <CheckCircle2 className="w-3 h-3 text-emerald-500" /> },
];

function ListView({
  tasks,
  agentNames,
  onSelect,
}: {
  tasks: Task[];
  agentNames: Map<string, string>;
  onSelect: (task: Task) => void;
}) {
  const [activeStatuses, setActiveStatuses] = useState<Set<TaskStatus>>(() => {
    try {
      const saved = localStorage.getItem("workboard:list-filter");
      if (saved) return new Set(JSON.parse(saved) as TaskStatus[]);
    } catch { /* ignore */ }
    return new Set(["in_progress", "ready"]);
  });
  const [activeProjects, setActiveProjects] = useState<Set<string> | null>(() => {
    try {
      const saved = localStorage.getItem("workboard:list-project-filter");
      if (saved) { const arr = JSON.parse(saved); return arr === null ? null : new Set(arr as string[]); }
    } catch { /* ignore */ }
    return null; // null = all projects
  });
  const [activeWorkers, setActiveWorkers] = useState<Set<string> | null>(() => {
    try {
      const saved = localStorage.getItem("workboard:list-worker-filter");
      if (saved) { const arr = JSON.parse(saved); return arr === null ? null : new Set(arr as string[]); }
    } catch { /* ignore */ }
    return null;
  });
  const [filterOpen, setFilterOpen] = useState(false);
  const [projectFilterOpen, setProjectFilterOpen] = useState(false);
  const [workerFilterOpen, setWorkerFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);
  const projectFilterRef = useRef<HTMLDivElement | null>(null);
  const workerFilterRef = useRef<HTMLDivElement | null>(null);

  // Close dropdowns on outside click
  useEffect(() => {
    if (!filterOpen && !projectFilterOpen && !workerFilterOpen) return;
    const handler = (e: MouseEvent) => {
      if (filterOpen && filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false);
      if (projectFilterOpen && projectFilterRef.current && !projectFilterRef.current.contains(e.target as Node)) setProjectFilterOpen(false);
      if (workerFilterOpen && workerFilterRef.current && !workerFilterRef.current.contains(e.target as Node)) setWorkerFilterOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [filterOpen, projectFilterOpen, workerFilterOpen]);

  // Collect unique projects
  const allProjects = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) set.add(t.project || "Inbox");
    return [...set].sort();
  }, [tasks]);

  // Collect unique workers
  const allWorkers = useMemo(() => {
    const map = new Map<string, string>(); // id -> display name
    for (const t of tasks) {
      const id = t.workerAgentId ?? t.workerRole ?? "";
      if (!id) continue;
      if (!map.has(id)) map.set(id, agentNames.get(id) ?? id);
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [tasks, agentNames]);

  const toggleWorker = (id: string) => {
    setActiveWorkers((prev) => {
      let next: Set<string>;
      if (prev === null) {
        next = new Set(allWorkers.map(([k]) => k).filter((k) => k !== id));
      } else {
        next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      const result = next.size === allWorkers.length ? null : next;
      try { localStorage.setItem("workboard:list-worker-filter", JSON.stringify(result === null ? null : [...result])); } catch { /* ignore */ }
      return result;
    });
  };

  const toggleProject = (p: string) => {
    setActiveProjects((prev) => {
      let next: Set<string>;
      if (prev === null) {
        // Was "all" — switch to all-except-this
        next = new Set(allProjects.filter((x) => x !== p));
      } else {
        next = new Set(prev);
        if (next.has(p)) next.delete(p);
        else next.add(p);
      }
      // If all selected, store null
      const result = next.size === allProjects.length ? null : next;
      try { localStorage.setItem("workboard:list-project-filter", JSON.stringify(result === null ? null : [...result])); } catch { /* ignore */ }
      return result;
    });
  };

  const toggleStatus = (s: TaskStatus) => {
    setActiveStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      try { localStorage.setItem("workboard:list-filter", JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  const filtered = useMemo(() => {
    const list = tasks.filter((t) => {
      if (!activeStatuses.has(t.status)) return false;
      if (activeProjects !== null && !activeProjects.has(t.project || "Inbox")) return false;
      if (activeWorkers !== null) {
        const wId = t.workerAgentId ?? t.workerRole ?? "";
        if (wId && !activeWorkers.has(wId)) return false;
      }
      return true;
    });
    list.sort((a, b) => {
      const ta = a.startedAt ?? a.endedAt ?? a.createdAt;
      const tb = b.startedAt ?? b.endedAt ?? b.createdAt;
      return tb - ta;
    });
    return list;
  }, [tasks, activeStatuses, activeProjects]);

  const totalFiltered = filtered.length;
  const activeLabels = STATUS_FILTER_OPTIONS
    .filter((o) => activeStatuses.has(o.status))
    .map((o) => o.label);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Filter bar */}
      <div className="px-3 py-2 border-b border-border-subtle flex items-center gap-2">
        <div className="relative" ref={filterRef}>
        <button
          type="button"
          onClick={() => setFilterOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded-md bg-bg-raised px-2.5 py-1.5 text-xs text-fg-muted hover:text-fg-default transition-colors"
        >
          <Zap className="w-3 h-3" />
          <span className="font-medium">
            {activeLabels.length === STATUS_FILTER_OPTIONS.length
              ? "All Status"
              : activeLabels.join(", ") || "None"}
          </span>
          <span className="text-fg-fainter">{totalFiltered}</span>
          <ChevronDown className={`w-3 h-3 transition-transform ${filterOpen ? "rotate-180" : ""}`} />
        </button>

        {filterOpen && (
          <div className="absolute z-20 mt-1 rounded-lg border border-border-subtle bg-bg-surface shadow-lg py-1 min-w-[160px]">
            {STATUS_FILTER_OPTIONS.map((opt) => {
              const active = activeStatuses.has(opt.status);
              return (
                <button
                  key={opt.status}
                  type="button"
                  onClick={() => toggleStatus(opt.status)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-bg-raised transition-colors"
                >
                  <span className={`w-3.5 h-3.5 flex items-center justify-center rounded border ${
                    active
                      ? "border-accent bg-accent text-white"
                      : "border-fg-faint"
                  }`}>
                    {active && <CheckCircle2 className="w-2.5 h-2.5" />}
                  </span>
                  <span className="flex items-center gap-1.5">
                    {opt.icon}
                    <span className={active ? "text-fg-default" : "text-fg-muted"}>{opt.label}</span>
                  </span>
                  <span className="ml-auto text-fg-fainter">
                    {tasks.filter((t) => t.status === opt.status).length}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        </div>

        {/* Project filter dropdown */}
        {allWorkers.length > 1 && (
          <div className="relative" ref={workerFilterRef}>
            <button
              type="button"
              onClick={() => setWorkerFilterOpen((v) => !v)}
              className="flex items-center gap-1.5 rounded-md bg-bg-raised px-2.5 py-1.5 text-xs text-fg-muted hover:text-fg-default transition-colors"
            >
              <Bot className="w-3 h-3" />
              <span className="font-medium">
                {activeWorkers === null
                  ? "All workers"
                  : activeWorkers.size === 0
                    ? "None"
                    : [...activeWorkers].map((id) => agentNames.get(id) ?? id).join(", ")}
              </span>
              <ChevronDown className={`w-3 h-3 transition-transform ${workerFilterOpen ? "rotate-180" : ""}`} />
            </button>
            {workerFilterOpen && (
              <div className="absolute z-20 mt-1 rounded-lg border border-border-subtle bg-bg-surface shadow-lg py-1 min-w-[160px] max-h-[240px] overflow-y-auto">
                {allWorkers.map(([id, name]) => {
                  const active = activeWorkers === null || activeWorkers.has(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => toggleWorker(id)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-bg-raised transition-colors"
                    >
                      <span className={`w-3.5 h-3.5 flex items-center justify-center rounded border ${
                        active ? "border-accent bg-accent text-white" : "border-fg-faint"
                      }`}>
                        {active && <CheckCircle2 className="w-2.5 h-2.5" />}
                      </span>
                      <span className={`truncate ${active ? "text-fg-default" : "text-fg-muted"}`}>{name}</span>
                      <span className="ml-auto text-fg-fainter">
                        {tasks.filter((t) => (t.workerAgentId ?? t.workerRole ?? "") === id).length}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {allProjects.length > 1 && (
          <div className="relative" ref={projectFilterRef}>
            <button
              type="button"
              onClick={() => setProjectFilterOpen((v) => !v)}
              className="flex items-center gap-1.5 rounded-md bg-bg-raised px-2.5 py-1.5 text-xs text-fg-muted hover:text-fg-default transition-colors"
            >
              <Hammer className="w-3 h-3" />
              <span className="font-medium">
                {activeProjects === null
                  ? "All projects"
                  : activeProjects.size === 0
                    ? "None"
                    : [...activeProjects].join(", ")}
              </span>
              <ChevronDown className={`w-3 h-3 transition-transform ${projectFilterOpen ? "rotate-180" : ""}`} />
            </button>

            {projectFilterOpen && (
              <div className="absolute z-20 mt-1 rounded-lg border border-border-subtle bg-bg-surface shadow-lg py-1 min-w-[160px] max-h-[240px] overflow-y-auto">
                {allProjects.map((proj) => {
                  const active = activeProjects === null || activeProjects.has(proj);
                  return (
                    <button
                      key={proj}
                      type="button"
                      onClick={() => toggleProject(proj)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-bg-raised transition-colors"
                    >
                      <span className={`w-3.5 h-3.5 flex items-center justify-center rounded border ${
                        active
                          ? "border-accent bg-accent text-white"
                          : "border-fg-faint"
                      }`}>
                        {active && <CheckCircle2 className="w-2.5 h-2.5" />}
                      </span>
                      <span className={`truncate ${active ? "text-fg-default" : "text-fg-muted"}`}>{proj}</span>
                      <span className="ml-auto text-fg-fainter">
                        {tasks.filter((t) => (t.project || "Inbox") === proj).length}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {filtered.length === 0 && (
          <div className="text-xs italic text-fg-faint text-center py-8">
            No tasks match the current filter.
          </div>
        )}
        {filtered.map((task) => (
          <ListRow
            key={task.id}
            task={task}
            agentNames={agentNames}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

function ListRow({
  task,
  agentNames,
  onSelect,
}: {
  task: Task;
  agentNames: Map<string, string>;
  onSelect: (task: Task) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const { ChatTranscript, MarkdownBlock } = useUiPrimitives();
  const openFile = useOpenFile();

  // Reactive pin state — shared with sidebar + kanban card
  const [isPinned, setIsPinned] = useState(false);
  useEffect(() => {
    const store = (window as any).__tianshuComposerStore;
    if (!store?.subscribe) return;
    const pinId = `task:${task.id}`;
    const update = () => setIsPinned(
      (store.getState().pinnedContexts ?? []).some((c: { id: string }) => c.id === pinId),
    );
    update();
    return store.subscribe(update);
  }, [task.id]);

  const workerName = task.workerAgentId
    ? agentNames.get(task.workerAgentId) ?? task.workerAgentId
    : task.workerRole ?? null;

  const hasIntervention = task.labels?.includes("awaiting-intervention");

  const statusIcon =
    task.status === "in_progress" ? (
      <span className="w-3.5 h-3.5 flex items-center justify-center">
        <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
      </span>
    ) : task.status === "done" ? (
      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
    ) : hasIntervention ? (
      <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
    ) : (
      <span className="w-3.5 h-3.5 flex items-center justify-center">
        <span className="w-2 h-2 rounded-full border border-fg-faint" />
      </span>
    );

  const fmtElapsed = (ms: number) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m`;
  };

  const fmtTimeAgo = (ms: number) => {
    const sec = Math.floor((Date.now() - ms) / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    return `${Math.floor(hr / 24)}d`;
  };

  const statusLine =
    task.status === "in_progress"
      ? null // shown as animated indicator, not text
      : task.status === "done"
        ? task.resultSummary ?? "Completed"
        : hasIntervention
          ? task.interventionReason ?? "Needs attention"
          : "Queued";

  const timeRef = task.startedAt ?? task.createdAt;

  return (
    <div className="group border-b border-border-subtle/40 last:border-b-0">
      <div
        className={`rounded-lg py-2.5 pr-3 mx-1 mb-0.5 cursor-pointer transition-colors hover:bg-bg-raised ${
          expanded ? "bg-bg-raised" : ""
        } ${
          task.priority >= 3 ? "border-l-2 border-l-rose-500 pl-2.5" :
          task.priority === 2 ? "border-l-2 border-l-amber-500 pl-2.5" :
          task.priority === 1 ? "border-l-2 border-l-blue-500 pl-2.5" :
          "pl-3"
        }`}
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Line 1: pin + title + status icon */}
        <div className="flex items-start gap-1.5">
          <button
            type="button"
            title={isPinned ? "Unpin from chat" : "Pin to chat"}
            onClick={(e) => {
              e.stopPropagation();
              const composerStore = (window as any).__tianshuComposerStore;
              if (!composerStore?.getState?.()?.pinContext) return;
              const state = composerStore.getState();
              const pinId = `task:${task.id}`;
              if (state.pinnedContexts.some((c: { id: string }) => c.id === pinId)) {
                state.unpinContext(pinId);
              } else {
                state.pinContext({
                  id: pinId,
                  kind: "task",
                  label: task.title,
                  summary: `task_id=${task.id}`,
                });
              }
            }}
            className={`shrink-0 mt-0.5 rounded p-0.5 transition-colors ${
              isPinned
                ? "text-accent bg-accent/15"
                : "text-fg-fainter opacity-0 group-hover:opacity-100 hover:text-accent hover:bg-accent/10"
            }`}
          >
            <Pin size={13} />
          </button>
          <span className={`flex-1 min-w-0 text-[13px] font-medium leading-snug ${
            task.status === "done" ? "text-fg-faint" : "text-fg-default"
          }`}>
            {task.title}
          </span>
          <span className="shrink-0 mt-0.5">{statusIcon}</span>
        </div>

        {/* Line 2: progress bar (in_progress) or status text */}
        {task.status === "in_progress" && task.startedAt ? (
          <div className="mt-1.5">
            <TaskProgressBarCompact task={task} workerName={workerName} />
          </div>
        ) : (
          <div className="mt-1 flex items-center gap-2">
            {hasIntervention && (
              <AlertTriangle className="w-3 h-3 shrink-0 text-rose-400" />
            )}
            {statusLine && (
              <span className={`text-xs truncate ${
                hasIntervention ? "text-rose-300" : "text-fg-faint"
              }`}>
                {statusLine}
              </span>
            )}
            <span className="flex-1" />
            {workerName && (
              <span className="text-[11px] text-fg-faint truncate max-w-[100px] shrink-0">
                {workerName}
              </span>
            )}
            <span className="text-[11px] text-fg-fainter shrink-0">
              {fmtTimeAgo(timeRef)}
            </span>
          </div>
        )}
      </div>

      {/* Expanded: task definition details */}
      {expanded && (
        <div className="mx-3 mb-2 rounded-lg border border-border-subtle/60 overflow-hidden text-xs">
          {/* Properties grid */}
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-3 py-2.5 text-[11px]">
            {task.project && task.project !== "Inbox" && (
              <>
                <span className="text-fg-fainter">Project</span>
                <span className="text-fg-muted">{task.project}</span>
              </>
            )}
            {workerName && (
              <>
                <span className="text-fg-fainter">Worker</span>
                <span className="text-fg-muted">{workerName}</span>
              </>
            )}
            {task.priority > 0 && (
              <>
                <span className="text-fg-fainter">Priority</span>
                <span className={`font-medium ${
                  task.priority >= 3 ? "text-rose-400" :
                  task.priority === 2 ? "text-amber-400" :
                  "text-blue-400"
                }`}>P{task.priority}</span>
              </>
            )}
            {task.estimatedDurationMs != null && (
              <>
                <span className="text-fg-fainter">Budget</span>
                <span className="text-fg-muted">{Math.round(task.estimatedDurationMs / 60000)}m</span>
              </>
            )}
            {(task.labels ?? []).filter(l => l !== "awaiting-intervention" && l !== "stalled").length > 0 && (
              <>
                <span className="text-fg-fainter">Labels</span>
                <div className="flex flex-wrap gap-1">
                  {(task.labels ?? []).filter(l => l !== "awaiting-intervention" && l !== "stalled").map(l => (
                    <span key={l} className="rounded-full bg-bg-surface px-1.5 py-0.5 text-[10px] text-fg-muted">{l}</span>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Description */}
          {task.description && (
            <div className="border-t border-border-subtle/40 px-3 py-2.5 text-fg-muted leading-relaxed prose-xs">
              <MarkdownBlock noProse>{task.description}</MarkdownBlock>
            </div>
          )}

          {/* Result summary */}
          {task.resultSummary && (
            <div className="border-t border-border-subtle/40 px-3 py-2 flex items-start gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
              <span className="text-fg-muted leading-relaxed">{task.resultSummary}</span>
            </div>
          )}

          {/* Result files */}
          {task.resultFiles.length > 0 && (
            <div className="border-t border-border-subtle/40 px-3 py-2 flex flex-wrap gap-1.5">
              {task.resultFiles.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openFile(p);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md bg-bg-surface px-2 py-1 text-[11px] text-fg-muted hover:text-fg-default hover:bg-bg-hover transition-colors"
                  title={p}
                >
                  <FileText className="w-3 h-3" />
                  <span className="max-w-[140px] truncate">{p.split("/").pop()}</span>
                </button>
              ))}
            </div>
          )}

          {/* Failure reason */}
          {task.failureReason && (
            <div className="border-t border-border-subtle/40 px-3 py-2 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
              <span className="text-rose-300 leading-relaxed">{task.failureReason}</span>
            </div>
          )}

          {/* Actions */}
          {task.sessionId && (
            <div className="border-t border-border-subtle/40 px-3 py-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowDetail(true);
                }}
                className="inline-flex items-center gap-1.5 rounded-md bg-bg-surface px-2.5 py-1.5 text-[11px] text-fg-muted hover:text-fg-default hover:bg-bg-hover transition-colors"
              >
                <ScrollText className="w-3 h-3" />
                View transcript
                {task.status === "in_progress" && (
                  <span className="flex items-center gap-1 text-amber-400 text-[10px]">
                    <span className="w-1 h-1 rounded-full bg-amber-400 animate-pulse" />
                    live
                  </span>
                )}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Transcript dialog */}
      {showDetail && (
        <ExecutionDialog task={task} onClose={() => setShowDetail(false)} />
      )}
    </div>
  );
}

/** Compact progress bar for list rows: multi-segment with text inside. */
function TaskProgressBarCompact({ task, workerName }: { task: Task; workerName?: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const startedAt = task.startedAt!;
  const elapsedMs = now - startedAt;
  const budgetMs = task.estimatedDurationMs ?? task.timeoutMs ?? 600_000;
  const overBudget = elapsedMs > budgetMs;

  const fmtDuration = (ms: number) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}m${rem}s` : `${m}m`;
  };

  // Build segments: budget phase + overshoot check intervals (same as TaskProgressBar)
  const segments: { ms: number; gen: number }[] = [];
  segments.push({ ms: budgetMs, gen: 0 });
  if (elapsedMs > budgetMs) {
    const baseInterval = Math.max(60_000, Math.min(budgetMs, 30 * 60_000));
    let cursor = budgetMs;
    let gen = 0;
    while (cursor < elapsedMs) {
      const interval = Math.min(baseInterval * Math.pow(2, gen + 1), 30 * 60_000);
      segments.push({ ms: interval, gen: gen + 1 });
      cursor += interval;
      gen++;
      if (gen > 10) break;
    }
  }

  const totalMs = Math.max(elapsedMs, budgetMs);
  let cumMs = 0;
  const filledSegments = segments.map((seg) => {
    const segStart = cumMs;
    cumMs += seg.ms;
    const filledMs = Math.max(0, Math.min(elapsedMs, cumMs) - segStart);
    return {
      widthPct: (seg.ms / totalMs) * 100,
      fillPct: seg.ms > 0 ? (filledMs / seg.ms) * 100 : 0,
      style: phaseStyle(seg.gen),
    };
  });

  // Overall fill percentage for clipPath text
  const overallPct = Math.min(100, (elapsedMs / totalMs) * 100);

  const phaseLabel = !overBudget ? ""
    : elapsedMs < budgetMs + 5 * 60_000 ? "⚠️"
    : elapsedMs < budgetMs + 15 * 60_000 ? "⚠️⚠️"
    : "🚨";

  const totalLabel = fmtDuration(segments.reduce((a, s) => a + s.ms, 0));

  return (
    <div className="relative h-5 rounded-md overflow-hidden" style={{ background: "var(--color-bg-surface)" }}>
      {/* Multi-segment fill */}
      <div className="absolute inset-0 flex">
        {filledSegments.map((seg, i) => (
          <div
            key={i}
            className="h-full overflow-hidden"
            style={{ width: `${seg.widthPct}%` }}
          >
            <div
              className="h-full transition-all duration-1000"
              style={{ width: `${seg.fillPct}%`, ...seg.style }}
            />
          </div>
        ))}
      </div>
      {/* Text layer: unfilled area (uses fg-default for high contrast on any theme) */}
      <div className="absolute inset-0 flex items-center px-2.5 text-[10px] font-semibold text-fg-default">
        <span className="relative flex h-1.5 w-1.5 mr-1.5 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-50" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-current" />
        </span>
        <span className={overBudget ? "font-bold" : ""}>{fmtDuration(elapsedMs)}</span>
        <span className="text-fg-muted mx-0.5">/</span>
        <span className="text-fg-muted">{totalLabel}</span>
        {phaseLabel && <span className="ml-1">{phaseLabel}</span>}
      </div>
      {/* Text layer: filled area (white on colored bg), clipped to fill */}
      <div
        className="absolute inset-0 flex items-center px-2.5 text-[10px] font-semibold text-white"
        style={{ clipPath: `inset(0 ${100 - overallPct}% 0 0)` }}
      >
        <span className="relative flex h-1.5 w-1.5 mr-1.5 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-50" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-white" />
        </span>
        <span className={overBudget ? "font-bold" : ""}>{fmtDuration(elapsedMs)}</span>
        <span className="text-white/70 mx-0.5">/</span>
        <span className="text-white/70">{totalLabel}</span>
        {phaseLabel && <span className="ml-1">{phaseLabel}</span>}
      </div>
    </div>
  );
}

/** @deprecated kept for reference, unused */
function ListProgressMini({ task }: { task: Task }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsedMs = now - task.startedAt!;
  const budgetMs = task.estimatedDurationMs ?? task.timeoutMs ?? 600_000;
  const pct = Math.min(100, (elapsedMs / budgetMs) * 100);
  const overBudget = elapsedMs > budgetMs;

  return (
    <div className="h-1 rounded-full bg-bg-raised overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-1000 ${
          overBudget ? "bg-amber-500" : "bg-accent"
        }`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function TaskProgressBar({ task }: { task: Task }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const startedAt = task.startedAt!;
  const elapsedMs = now - startedAt;
  const budgetMs = task.estimatedDurationMs ?? task.timeoutMs ?? 600_000;

  const fmtDuration = (ms: number) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}m${rem}s` : `${m}m`;
  };

  // Build segments: budget phase + overshoot check intervals.
  // Base interval = 50% of budget (min 1min, max 30min), doubles
  // each generation — matches the server's watchdog backoff.
  const segments: { ms: number; gen: number }[] = [];
  segments.push({ ms: budgetMs, gen: 0 });
  if (elapsedMs > budgetMs) {
    const baseInterval = Math.max(60_000, Math.min(budgetMs, 30 * 60_000));
    let cursor = budgetMs;
    let gen = 0;
    while (cursor < elapsedMs) {
      const interval = Math.min(baseInterval * Math.pow(2, gen + 1), 30 * 60_000);
      segments.push({ ms: interval, gen: gen + 1 });
      cursor += interval;
      gen++;
      if (gen > 10) break; // safety cap
    }
  }

  // Total bar width = max(elapsed, budget) for proportional rendering
  const totalMs = Math.max(elapsedMs, budgetMs);

  // Compute filled width for each segment
  let cumMs = 0;
  const filledSegments = segments.map((seg) => {
    const segStart = cumMs;
    cumMs += seg.ms;
    const filledMs = Math.max(0, Math.min(elapsedMs, cumMs) - segStart);
    return {
      widthPct: (seg.ms / totalMs) * 100,
      fillPct: seg.ms > 0 ? (filledMs / seg.ms) * 100 : 0,
      style: phaseStyle(seg.gen),
    };
  });

  const overBudget = elapsedMs > budgetMs;
  const phaseLabel = !overBudget ? ""
    : elapsedMs < budgetMs + 5 * 60_000 ? "⚠️"
    : elapsedMs < budgetMs + 15 * 60_000 ? "⚠️⚠️"
    : "🚨";

  return (
    <div className="mt-1 space-y-0.5">
      <div className="flex items-center justify-between text-[10px] text-fg-faint">
        <span className="flex items-center gap-1">
          <Clock className="w-2.5 h-2.5" />
          <span className={overBudget ? "text-amber-400 font-medium" : ""}>
            {fmtDuration(elapsedMs)}
          </span>
          <span className="text-fg-fainter">/</span>
          <span className="text-fg-fainter">
            {fmtDuration(segments.reduce((a, s) => a + s.ms, 0))}
          </span>
          {phaseLabel && <span>{phaseLabel}</span>}
        </span>
        {task.nextCheckAt && (
          <span className="text-fg-fainter" title="Next supervision check">
            🔔 {fmtDuration(Math.max(0, task.nextCheckAt - now))}
          </span>
        )}
      </div>
      <div className="h-1.5 rounded-full bg-bg-raised overflow-hidden flex">
        {filledSegments.map((seg, i) => (
          <div
            key={i}
            className="h-full overflow-hidden"
            style={{ width: `${seg.widthPct}%` }}
          >
            <div
              className="h-full transition-all duration-1000"
              style={{ width: `${seg.fillPct}%`, ...seg.style }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function ExecutionSection({ task, workerName, workerKind }: { task: Task; workerName?: string; workerKind?: string }) {
  const t = usePluginT("workboard");
  const dateLoc = useDateLocale();
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
          className="inline-flex items-center gap-1.5 rounded border border-border-default px-1.5 py-0.5 text-xs text-fg-muted hover:border-border-strong hover:bg-bg-raised"
        >
          <ScrollText className="w-3 h-3" />
          {t("panel.execution.viewTranscript")}
          {task.status === "in_progress" && (
            <span className="flex items-center gap-1 text-warning">
              <span className="w-1 h-1 rounded-full bg-amber-400 animate-pulse" />
              {t("panel.execution.live")}
            </span>
          )}
        </button>
      </div>
      {open && (
        <ExecutionDialog task={task} onClose={() => setOpen(false)} workerName={workerName} workerKind={workerKind} />
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
  workerName?: string;
  workerKind?: string;
}) {
  const t = usePluginT("workboard");
  const { Modal, ChatTranscript } = useUiPrimitives();

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
        onDragStart={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-border-subtle px-4 py-2 text-xs text-fg-faint">
          <ScrollText className="h-3.5 w-3.5 text-fg-faint" />
          <span className="font-medium text-fg-muted">{t("panel.execution.transcript")}</span>
          {task.sessionId && (
            <span className="font-mono text-fg-fainter">· {task.sessionId}</span>
          )}
          {task.status === "in_progress" && (
            <span className="flex items-center gap-1 text-warning">
              ·
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
              {t("panel.execution.tailing")}
            </span>
          )}
        </header>

        {task.sessionId ? (
          <ChatTranscript
            sessionId={task.sessionId}
            tailing={task.status === "in_progress"}
            className="flex-1 overflow-y-auto"
          />
        ) : (
          <div className="p-4 text-xs italic text-fg-faint">
            {t("panel.execution.workerNotStarted")}
          </div>
        )}
      </div>
    </Modal>
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
      <div className="text-xs uppercase tracking-wide text-fg-faint mb-0.5">
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
      className="inline-flex items-center gap-1 max-w-full text-xs font-mono text-success hover:underline truncate"
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
  const t = usePluginT("workboard");
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
    const trimmed = title.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    onSubmit({
      title: trimmed,
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
          placeholder={t("panel.addTask.titlePlaceholder")}
          className="flex-1 min-w-0 bg-bg-raised border border-border-default rounded px-2 py-1 text-xs text-fg-default outline-none focus:border-blue-500"
        />
        <button
          type="button"
          title={showMore ? t("panel.addTask.less") : t("panel.addTask.moreFields")}
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
          title={t("panel.addTask.cancel")}
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {showMore && (
        <div className="space-y-2 pt-0.5">
          <FieldRow label={t("panel.field.description")}>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("panel.addTask.descPlaceholder")}
              rows={2}
              className="w-full bg-bg-raised border border-border-default rounded px-2 py-1 text-xs text-fg-default outline-none focus:border-blue-500 resize-y"
            />
          </FieldRow>
          <FieldRow label={t("panel.field.project")}>
            <input
              list="workboard-add-projects"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="inbox"
              className="w-full bg-bg-raised border border-border-default rounded px-2 py-1 text-xs text-fg-default outline-none focus:border-blue-500"
            />
          </FieldRow>
          <div className="grid grid-cols-[1fr_72px] gap-2">
            <FieldRow label={t("panel.field.worker")}>
              <input
                list="workboard-add-roles"
                value={workerRole}
                onChange={(e) => setWorkerRole(e.target.value)}
                placeholder={t("panel.addTask.anyPlaceholder")}
                className="w-full bg-bg-raised border border-border-default rounded px-2 py-1 text-xs text-fg-default outline-none focus:border-blue-500"
              />
            </FieldRow>
            <FieldRow label={t("panel.field.priority")}>
              <input
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value) || 0)}
                className="w-full bg-bg-raised border border-border-default rounded px-2 py-1 text-xs text-fg-default outline-none focus:border-blue-500"
              />
            </FieldRow>
          </div>
          <FieldRow label={t("panel.field.dependsOn")}>
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
        <span className="text-xs text-fg-fainter truncate">
          {showMore ? t("panel.addTask.enterSaves") : t("panel.addTask.enterEscCancel")}
        </span>
        <button
          type="button"
          onClick={submit}
          disabled={!title.trim()}
          className="ml-auto px-2.5 py-0.5 text-xs rounded bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t("panel.addTask.add")}
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
      <span className="block text-xs uppercase tracking-wide text-fg-faint mb-0.5">
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
  const t = usePluginT("workboard");
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
            const candTask = candidateMap.get(id);
            const label = candTask
              ? candTask.title
              : t("panel.dep.deletedLabel", { id: id.slice(0, 6) });
            const done = candTask?.status === "done";
            return (
              <span
                key={id}
                className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border ${
                  done
                    ? "text-success bg-success/10 border-success/30"
                    : "text-indigo-200 bg-indigo-500/15 border-indigo-500/40"
                }`}
                title={candTask ? `${candTask.status} · ${candTask.id}` : id}
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
                  title={t("panel.dep.remove")}
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
        className="w-full bg-bg-raised border border-border-default rounded px-2 py-1 text-xs text-fg-default outline-none focus:border-blue-500"
      >
        <option value="">
          {filtered.length === 0
            ? value.length === 0
              ? t("panel.dep.noOtherTasks")
              : t("panel.dep.noMoreCandidates")
            : t("panel.dep.addPrerequisite")}
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
  const t = usePluginT("workboard");
  return (
    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border-subtle bg-bg-base/40 overflow-x-auto scrollbar-none flex-shrink-0">
      {showAll && (
        <Chip
          active={!active}
          label={t("panel.chip.all")}
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
        "shrink-0 inline-flex items-center gap-1 rounded-full text-xs transition-colors px-2.5 py-0.5",
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
  const t = usePluginT("workboard");
  if (!snapshot) {
    return (
      <div className="px-6 py-1.5 border-b border-border-subtle text-xs text-fg-faint flex-shrink-0">
        {t("panel.workers.loading")}
      </div>
    );
  }
  return (
    <div className="px-6 py-1.5 border-b border-border-subtle text-xs flex items-center gap-2 text-fg-muted flex-wrap flex-shrink-0">
      <Hammer className="w-3 h-3 text-fg-faint" />
      <span className="text-fg-faint">{t("panel.workers.types")}</span>
      {snapshot.workers.map((w) => (
        <span
          key={w.agentId}
          title={`Type: ${w.kind}\nAgent: ${w.name}`}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs border font-mono uppercase tracking-wide ${
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
          {snapshot.running.length === 1
            ? t("panel.workers.runningOne")
            : t("panel.workers.runningMany", { n: snapshot.running.length })}
        </span>
      )}
      <button
        type="button"
        onClick={onNudge}
        className="ml-auto text-xs uppercase tracking-wide text-fg-muted hover:text-fg-default"
      >
        {t("panel.workers.nudge")}
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
  const t = usePluginT("workboard");
  const dateLoc = useDateLocale();
  const { Modal } = useUiPrimitives();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description || "");
  const [project, setProject] = useState(task.project || "");
  const [priority, setPriority] = useState(task.priority);
  const [workerRole, setWorkerRole] = useState(task.workerRole || "");
  const [dependsOn, setDependsOn] = useState<string[]>(task.dependsOn ?? []);
  const [notifyChannels, setNotifyChannels] = useState(
    (task.notifyChannels ?? []).join(", "),
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Re-sync local form state when the parent reloads with fresh data.
  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description || "");
    setProject(task.project || "");
    setPriority(task.priority);
    setWorkerRole(task.workerRole || "");
    setDependsOn(task.dependsOn ?? []);
    setNotifyChannels((task.notifyChannels ?? []).join(", "));
  }, [
    task.id,
    task.title,
    task.description,
    task.project,
    task.priority,
    task.workerRole,
    task.dependsOn,
    task.notifyChannels,
  ]);

  const allStatuses: TaskStatus[] = ["ready", "in_progress", "done"];

  const save = async () => {
    const parsedChannels = notifyChannels
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    await onPatch({
      title,
      description: description || null,
      project: project || PROJECT_INBOX_KEY,
      priority,
      workerRole: workerRole.trim() || null,
      dependsOn,
      notifyChannels: parsedChannels.length > 0 ? parsedChannels : null,
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
            <span className="text-xs uppercase text-fg-faint tracking-wide">
              {t("panel.modal.task")}
            </span>
            <span className="text-xs text-fg-fainter font-mono truncate">
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
              title={t("panel.modal.sandboxTitle")}
            >
              <span className="text-xs uppercase text-fg-faint tracking-wide">
                {t("panel.modal.sandbox")}
              </span>
              <code
                className="text-xs text-fg-faint font-mono truncate cursor-pointer hover:text-fg-muted"
                onClick={(e) => {
                  if (!task.sandboxName) return;
                  void navigator.clipboard
                    ?.writeText(task.sandboxName)
                    .catch(() => {});
                  // Brief visual ack: bump opacity via title swap.
                  const el = e.currentTarget;
                  const orig = el.title;
                  el.title = "copied";
                  setTimeout(() => {
                    el.title = orig;
                  }, 800);
                }}
                title={t("panel.modal.copyTitle")}
              >
                {task.sandboxName}
              </code>
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-3 text-xs">
          <div>
            <label className="block text-xs uppercase tracking-wide text-fg-faint mb-1">
              {t("panel.modal.title")}
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-2 py-1.5 bg-bg-elevated border border-border-default rounded outline-none focus:border-blue-600"
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wide text-fg-faint mb-1">
              {t("panel.modal.description")}
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
              <label className="block text-xs uppercase tracking-wide text-fg-faint mb-1">
                {t("panel.modal.project")}
              </label>
              <input
                value={project}
                onChange={(e) => setProject(e.target.value)}
                placeholder={PROJECT_INBOX_KEY}
                className="w-full px-2 py-1.5 bg-bg-elevated border border-border-default rounded outline-none focus:border-blue-600"
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wide text-fg-faint mb-1">
                {t("panel.modal.priority")}
              </label>
              <input
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value) || 0)}
                className="w-full px-2 py-1.5 bg-bg-elevated border border-border-default rounded outline-none focus:border-blue-600"
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wide text-fg-faint mb-1">
                {t("panel.modal.workerRole")}
              </label>
              <input
                value={workerRole}
                onChange={(e) => setWorkerRole(e.target.value)}
                placeholder={t("panel.modal.workerRolePlaceholder")}
                className="w-full px-2 py-1.5 bg-bg-elevated border border-border-default rounded outline-none focus:border-blue-600"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wide text-fg-faint mb-1">
              {t("panel.modal.status")}
            </label>
            <div className="flex flex-wrap gap-1">
              {allStatuses.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={busy || s === task.status}
                  onClick={() => void onPatch({ status: s })}
                  className={`text-xs px-2 py-1 rounded border ${
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
            <label className="block text-xs uppercase tracking-wide text-fg-faint mb-1">
              {t("panel.modal.dependsOn")}
            </label>
            <DependencyPicker
              value={dependsOn}
              onChange={setDependsOn}
              candidates={allTasks}
              project={project}
              excludeId={task.id}
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wide text-fg-faint mb-1">
              {t("panel.modal.notifyChannels")}
            </label>
            <input
              value={notifyChannels}
              onChange={(e) => setNotifyChannels(e.target.value)}
              placeholder={t("panel.modal.notifyChannelsPlaceholder")}
              className="w-full px-2 py-1.5 bg-bg-elevated border border-border-default rounded outline-none focus:border-blue-600 text-sm"
            />
            <span className="text-xs text-fg-fainter mt-0.5 block">
              {t("panel.modal.notifyChannelsHint")}
            </span>
          </div>
          {task.resultSummary && (
            <div>
              <label className="block text-xs uppercase tracking-wide text-fg-faint mb-1">
                {t("panel.modal.result")}
              </label>
              <div className="bg-bg-elevated border border-border-subtle rounded px-2 py-1.5 text-success italic whitespace-pre-line">
                {task.resultSummary}
              </div>
            </div>
          )}
          <div className="grid grid-cols-3 gap-2 text-xs text-fg-faint border-t border-border-subtle pt-2">
            <div>
              {t("panel.modal.created")}
              <div className="text-fg-muted">
                {new Date(task.createdAt).toLocaleString(dateLoc)}
              </div>
            </div>
            {task.startedAt && (
              <div>
                {t("panel.modal.started")}
                <div className="text-fg-muted">
                  {new Date(task.startedAt).toLocaleString(dateLoc)}
                </div>
              </div>
            )}
            {task.endedAt && (
              <div>
                {t("panel.modal.ended")}
                <div className="text-fg-muted">
                  {new Date(task.endedAt).toLocaleString(dateLoc)}
                </div>
              </div>
            )}
          </div>
        </div>

        <footer className="px-4 py-3 border-t border-border-subtle flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-red-800 text-red-200 hover:bg-red-900/30 disabled:opacity-50"
          >
            <Trash2 className="w-3 h-3" /> {t("panel.modal.delete")}
          </button>
          <Modal
            isOpen={confirmingDelete}
            onClose={() => setConfirmingDelete(false)}
            title={t("panel.delete.modalTitle")}
            size="sm"
            allowMaximize={false}
          >
            <div className="flex flex-col gap-4 p-1">
              <p className="text-sm text-fg-muted">
                {t("panel.delete.confirmPre")}
                <span className="font-medium text-fg-default">
                  “{task.title}”
                </span>
                {t("panel.delete.confirmPost")}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover transition-colors"
                >
                  {t("panel.delete.cancel")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirmingDelete(false);
                    void onDelete();
                  }}
                  className="text-xs px-3 py-1.5 rounded-md bg-danger text-fg-on-accent font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {t("panel.delete.delete")}
                </button>
              </div>
            </div>
          </Modal>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto px-3 py-1 text-xs rounded border border-border-default text-fg-muted hover:bg-bg-raised"
          >
            {t("panel.modal.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="px-3 py-1 text-xs rounded bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t("panel.modal.save")}
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
  const t = usePluginT("workboard");
  const [snapshot, setSnapshot] = useState<WorkerSnapshot | null>(null);
  const [collapsed, setCollapsed] = useState(true);

  const reload = useCallback(async () => {
    try {
      const r = await getJson<WorkerSnapshot>(`${API_BASE}/workers/status`);
      setSnapshot(r);
    } catch {
      setSnapshot(null);
    }
  }, []);

  useEffect(() => {
    // Fetch once for the initial state, then rely on server pushes
    // (`workboard:workers.status`, sent on every busy-state / roster
    // change) instead of a 5s poll. The server carries the full
    // snapshot in the event payload, so no re-fetch on push.
    void reload();
    const off = subscribeToWsEvent<{ type: string; event?: string; payload?: unknown }>(
      "plugin_event",
      (ev) => {
        if (ev.event !== "workboard:workers.status") return;
        if (ev.payload) setSnapshot(ev.payload as WorkerSnapshot);
      },
    );
    // WS may be unavailable (subscribeToWsEvent is a no-op then); a slow
    // safety-net poll keeps the sidebar eventually-correct without the
    // old 5s churn.
    const id = window.setInterval(() => void reload(), 60000);
    return () => {
      off();
      window.clearInterval(id);
    };
  }, [reload]);

  const realWorkers = snapshot?.workers ?? [];
  const busyCount = realWorkers.filter((w) => w.busy).length;

  // Emit badge count to top bar button
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("tianshu:topbar:badge", {
        detail: { buttonId: "workboard.toggle", count: busyCount },
      }),
    );
  }, [busyCount]);

  // Auto-expand when any worker is busy
  const hasBusy = busyCount > 0;

  return (
    <div className="px-3 py-2">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="mb-1 flex w-full items-center gap-2 rounded-lg px-1 py-1 transition-colors hover:bg-bg-hover/30"
      >
        <Zap size={14} className="flex-shrink-0 text-fg-fainter" />
        <span className="flex-1 text-left text-sm font-medium text-fg-muted">
          {t("workers.title")}
        </span>
        <span className="rounded bg-bg-raised px-1.5 py-0.5 text-xs text-fg-fainter">
          {t("workers.busyCount", {
            busy: busyCount,
            total: realWorkers.length,
          })}
        </span>
        <ChevronDown
          size={12}
          className={`flex-shrink-0 text-fg-fainter transition-transform ${
            collapsed && !hasBusy ? "-rotate-90" : ""
          }`}
        />
      </button>
      {(!collapsed || hasBusy) && (
        <div className="space-y-1.5 mt-1">
          {realWorkers.length === 0 ? (
            <div className="text-xs text-fg-fainter px-1">
              {t("workers.empty")}
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
      )}
      <MiniTaskList workers={realWorkers} />
    </div>
  );
}

/** Compact list of in-progress tasks in the sidebar. */
function MiniTaskList({ workers }: { workers: { agentId: string; name: string; kind: string; busy: boolean }[] }) {
  const t = usePluginT("workboard");
  const [tasks, setTasks] = useState<Task[]>([]);
  // Track pinned IDs reactively so pin icon updates on pin/unpin/send
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const store = (window as any).__tianshuComposerStore;
    if (!store?.subscribe) return;
    const update = () => {
      const ids = new Set<string>(
        (store.getState().pinnedContexts ?? []).map((c: { id: string }) => c.id),
      );
      setPinnedIds(ids);
    };
    update();
    return store.subscribe(update);
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const r = await getJson<{ tasks: Task[] }>(
          `${API_BASE}/tasks?status=in_progress`,
        );
        setTasks(r.tasks ?? []);
      } catch {
        setTasks([]);
      }
    };
    void load();
    // Refresh on task events
    const off = subscribeToWsEvent<{ type: string; event?: string }>("plugin_event", (ev) => {
      if (ev.event?.startsWith("workboard:")) void load();
    });
    const id = window.setInterval(() => void load(), 30000);
    return () => { off(); window.clearInterval(id); };
  }, []);

  if (tasks.length === 0) return null;

  return (
    <div className="mt-2 border-t border-border-subtle/30 pt-2">
      <div className="mb-1 flex items-center gap-1.5 px-1">
        <span className="text-[10px] font-medium uppercase tracking-wider text-fg-fainter">
          In Progress
        </span>
        <span className="rounded-full bg-accent/15 px-1.5 text-[10px] font-bold text-accent">
          {tasks.length}
        </span>
      </div>
      <div className="space-y-0.5">
        {tasks.slice(0, 5).map((task) => {
          const workerName = workers.find((w) => w.agentId === task.workerAgentId)?.name || task.workerAgentId || task.workerRole || "";
          const pinId = `task:${task.id}`;
          const composerStore = (window as any).__tianshuComposerStore;
          const isPinned = pinnedIds.has(pinId);
          return (
            <button
              key={task.id}
              type="button"
              onClick={() => {
                if (!composerStore?.getState?.()?.pinContext) return;
                const state = composerStore.getState();
                if (state.pinnedContexts.some((c: { id: string }) => c.id === pinId)) {
                  state.unpinContext(pinId);
                } else {
                  state.pinContext({
                    id: pinId,
                    kind: "task",
                    label: task.title,
                    summary: `task_id=${task.id}`,
                  });
                }
              }}
              className={`flex w-full items-center gap-2 rounded px-1 py-1 text-left transition-colors ${
                isPinned ? "bg-accent/10 border border-accent/20" : "hover:bg-bg-hover/30"
              }`}
              title={task.description || task.title}
            >
              <Pin size={12} className={`flex-shrink-0 transition-colors ${
                isPinned ? "text-accent" : "text-fg-fainter"
              }`} />
              <div className="min-w-0 flex-1">
                <span className="block truncate text-xs text-fg-muted">
                  {task.title}
                </span>
                <span className="block truncate text-[10px] text-fg-fainter">
                  {workerName}
                  {task.startedAt && " \u00b7 "}
                  {task.startedAt && <MiniCountdown startedAt={task.startedAt} budgetMs={task.estimatedDurationMs ?? task.timeoutMs ?? 600_000} />}
                </span>
              </div>
            </button>
          );
        })}
        {tasks.length > 5 && (
          <div className="px-1 text-[10px] text-fg-fainter">
            +{tasks.length - 5} more
          </div>
        )}
      </div>
    </div>
  );
}

/** Live countdown: shows elapsed / remaining time for a running task. */
function MiniCountdown({ startedAt, budgetMs }: { startedAt: number; budgetMs: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const elapsed = now - startedAt;
  const remaining = budgetMs - elapsed;
  const overdue = remaining < 0;
  const abs = Math.abs(remaining);
  const min = Math.floor(abs / 60000);
  const sec = Math.floor((abs % 60000) / 1000);
  const display = `${min}:${sec.toString().padStart(2, "0")}`;
  if (overdue) {
    return <span className="text-danger font-mono">+{display}</span>;
  }
  // Warn when <20% budget remaining
  const warn = remaining < budgetMs * 0.2;
  return <span className={`font-mono ${warn ? "text-warning" : ""}`}>{display}</span>;
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
  const t = usePluginT("workboard");
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
      title={t("workers.rowTitle", { name, kind })}
    >
      <span className="w-5 flex-shrink-0 text-center text-base">{emoji}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-fg-default">
          {name}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="truncate rounded bg-bg-raised/80 px-1 py-px font-mono text-xs font-semibold uppercase tracking-wide text-fg-muted">
            {kind}
          </span>
          <span
            className={`rounded px-1 py-px text-xs ${
              busy
                ? "bg-blue-900/40 text-blue-100 border border-blue-700"
                : "bg-bg-raised/60 text-fg-fainter"
            }`}
          >
            {busy ? t("workers.status.busy") : t("workers.status.idle")}
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
function formatRelative(ms: number, t?: Translator): string {
  const delta = Math.max(0, Date.now() - ms);
  const sec = Math.round(delta / 1000);
  if (sec < 60) return t ? t("panel.time.secondsAgo", { n: sec }) : `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return t ? t("panel.time.minutesAgo", { n: min }) : `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return t ? t("panel.time.hoursAgo", { n: hr }) : `${hr}h ago`;
  const day = Math.round(hr / 24);
  return t ? t("panel.time.daysAgo", { n: day }) : `${day}d ago`;
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
