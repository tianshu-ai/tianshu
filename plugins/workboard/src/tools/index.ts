// Agent tools the workboard plugin contributes.
//
// Five tools cover the kanban surface from the agent's side:
//
//   - task_list   — read the board (status-grouped, optional project filter)
//   - task_create — drop a new ready task on the board
//   - task_update — patch title / description / priority / project
//   - task_move   — move a task between status columns
//   - task_delete — remove a task
//
// Worker-side helpers (claim / complete) intentionally do NOT live
// here — workers don't run inside the agent loop, they live inside
// the host process. The only "worker" the agent talks to is via the
// task itself: drop a task on the board, watch the kanban panel, see
// it flip to done.
//
// All tools require a database handle which the activator passes in
// once and closes over via these factories. We don't capture the
// AgentToolContext.userId from the call — we read it from the ctx
// each invocation so that cross-user tool routing in v1 can change
// the scope without rewriting the tools.

import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type {
  AgentTool,
  AgentToolContext,
  TenantDbHandle,
  PluginLogger,
} from "@tianshu/plugin-sdk";
import {
  createTask,
  deleteTask,
  getTask,
  isEligible,
  listTasks,
  updateTask,
  isTaskStatus,
  VISIBLE_STATUSES,
  type Task,
  type TaskStatus,
} from "../db/tasks.js";

export interface ToolDeps {
  db: TenantDbHandle;
  log: PluginLogger;
  /** Called after a write so the worker pool drains pending todos. */
  onTaskWrite(): void;
}

interface ToolReturn {
  ok: boolean;
  text: string;
  data?: unknown;
}

const STATUS_DESCRIPTION =
  'One of "todo", "in_progress", "done", "stalled", "aborted". ' +
  '"todo" tasks are picked up by the worker pool. The board UI hides "aborted" by default.';

function summarise(t: Task, blocked: boolean): Record<string, unknown> {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    project: t.projectSlug,
    priority: t.priority,
    workerRole: t.workerRole,
    description: t.description,
    resultSummary: t.resultSummary,
    dependsOn: t.dependsOn,
    blocked,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
  };
}

/** Filter caller-supplied depends_on against owner-scoped tasks.
 *  Drops any id that doesn't belong to this user (silently — it's
 *  the same forgiving behaviour the routes layer uses). */
function sanitiseDepsForOwner(
  db: TenantDbHandle,
  ownerUserId: string,
  raw: string[] | undefined,
  excludeId?: string,
): string[] {
  if (!raw || raw.length === 0) return [];
  const cleaned = raw
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim())
    .filter((id) => id !== excludeId);
  if (cleaned.length === 0) return [];
  const placeholders = cleaned.map(() => "?").join(",");
  const rows = db
    .prepare<unknown[], { id: string }>(
      `SELECT id FROM tasks WHERE owner_user_id = ? AND id IN (${placeholders})`,
    )
    .all(ownerUserId, ...cleaned);
  return rows.map((r) => r.id);
}

function formatBoard(
  tasks: Task[],
  blockedSet: Set<string>,
): string {
  if (tasks.length === 0) return "(no tasks)";
  const groups = new Map<TaskStatus, Task[]>();
  for (const s of VISIBLE_STATUSES) groups.set(s, []);
  for (const t of tasks) {
    let arr = groups.get(t.status);
    if (!arr) {
      arr = [];
      groups.set(t.status, arr);
    }
    arr.push(t);
  }
  const lines: string[] = [];
  for (const [status, list] of groups) {
    if (list.length === 0) continue;
    lines.push(`${status} (${list.length}):`);
    for (const t of list) {
      const tag = t.priority > 0 ? ` [p${t.priority}]` : "";
      const role = t.workerRole ? ` <${t.workerRole}>` : "";
      const project = t.projectSlug && t.projectSlug !== "inbox" ? ` #${t.projectSlug}` : "";
      const deps = t.dependsOn.length > 0
        ? ` deps:${blockedSet.has(t.id) ? "🔒" : "✓"}${t.dependsOn.length}`
        : "";
      lines.push(`  ${t.id} — ${t.title}${tag}${role}${project}${deps}`);
    }
  }
  return lines.join("\n");
}

export function buildTaskListTool(deps: ToolDeps): AgentTool {
  return {
    schema: {
      name: "task_list",
      description:
        "List tasks on the workboard. Defaults to the four visible columns " +
        "(todo / in_progress / done / stalled). Pass a project filter to scope " +
        "to one slug, or status to override the default columns. Use this before " +
        "task_create to avoid duplicates.",
      parameters: Type.Object({
        project: Type.Optional(
          Type.String({
            description:
              'Project slug to filter on. Tasks without an explicit slug are filed under "inbox".',
          }),
        ),
        status: Type.Optional(
          Type.String({
            description:
              "Comma-separated statuses, e.g. \"todo,in_progress\". Overrides the default visible columns.",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: "Max rows. Default 200, hard cap 2000.",
          }),
        ),
      }),
    },
    execute: (raw, ctx: AgentToolContext): ToolReturn => {
      const args = raw as { project?: string; status?: string; limit?: number };
      const statuses: TaskStatus[] = [];
      if (args.status) {
        for (const piece of args.status.split(",")) {
          const trimmed = piece.trim();
          if (!trimmed) continue;
          if (!isTaskStatus(trimmed)) {
            return { ok: false, text: `unknown status: ${trimmed}` };
          }
          statuses.push(trimmed);
        }
      }
      const tasks = listTasks(deps.db, {
        ownerUserId: ctx.userId,
        projectSlug: args.project ?? null,
        statuses: statuses.length ? statuses : undefined,
        limit: args.limit ?? 200,
      });
      const blocked = new Set<string>();
      for (const t of tasks) {
        if (t.status === "todo" && !isEligible(deps.db, t)) {
          blocked.add(t.id);
        }
      }
      return {
        ok: true,
        text: formatBoard(tasks, blocked),
        data: {
          tasks: tasks.map((t) => summarise(t, blocked.has(t.id))),
        },
      };
    },
  };
}

export function buildTaskCreateTool(deps: ToolDeps): AgentTool {
  return {
    schema: {
      name: "task_create",
      description:
        "Drop a new task on the workboard. Defaults to status=todo, project=inbox. " +
        "Workers in the pool will pick up todo tasks automatically. " +
        "Optionally tag with worker_role to direct the task at a specific worker " +
        "(role-less tasks are claimed by any worker).",
      parameters: Type.Object({
        title: Type.String({ description: "Short human-readable title." }),
        description: Type.Optional(
          Type.String({ description: "Long-form notes / context for the worker." }),
        ),
        project: Type.Optional(
          Type.String({ description: "Project slug. Default \"inbox\"." }),
        ),
        priority: Type.Optional(
          Type.Number({
            description:
              "Higher = picked up first. Range -10..10; default 0.",
          }),
        ),
        worker_role: Type.Optional(
          Type.String({
            description:
              'Restrict to one role (e.g. "echo", "qianliyan"). Omit to let any worker pick it up.',
          }),
        ),
        depends_on: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Task ids that must reach status='done' before this task is eligible for a worker. Use this to express 'B starts after A'. Ids that don't belong to you are silently ignored.",
          }),
        ),
      }),
    },
    execute: (raw, ctx: AgentToolContext): ToolReturn => {
      const args = raw as {
        title?: string;
        description?: string;
        project?: string;
        priority?: number;
        worker_role?: string;
        depends_on?: string[];
      };
      const title = args.title?.trim();
      if (!title) return { ok: false, text: "title is required" };
      if (title.length > 200) {
        return { ok: false, text: "title too long (max 200 chars)" };
      }
      const id = randomUUID();
      const dependsOn = sanitiseDepsForOwner(
        deps.db,
        ctx.userId,
        args.depends_on,
        id,
      );
      const task = createTask(deps.db, id, {
        ownerUserId: ctx.userId,
        title,
        description: args.description,
        projectSlug: args.project,
        priority: args.priority,
        workerRole: args.worker_role ?? null,
        dependsOn,
      });
      const blocked = !isEligible(deps.db, task);
      deps.onTaskWrite();
      const blockedNote = blocked
        ? ` (blocked by ${dependsOn.length} unfinished prerequisite${dependsOn.length === 1 ? "" : "s"})`
        : "";
      return {
        ok: true,
        text: `Created task ${task.id}: ${task.title} (status=todo, project=${task.projectSlug})${blockedNote}`,
        data: { task: summarise(task, blocked) },
      };
    },
  };
}

export function buildTaskUpdateTool(deps: ToolDeps): AgentTool {
  return {
    schema: {
      name: "task_update",
      description:
        "Patch a task. Pass id + any subset of (title, description, project, " +
        "priority, worker_role, depends_on). For status changes use task_move.",
      parameters: Type.Object({
        id: Type.String(),
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        project: Type.Optional(Type.String()),
        priority: Type.Optional(Type.Number()),
        worker_role: Type.Optional(Type.String()),
        depends_on: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Replace the dependency list. Pass [] to clear. Ids must belong to you; bogus ids are silently dropped.",
          }),
        ),
      }),
    },
    execute: (raw, ctx: AgentToolContext): ToolReturn => {
      const args = raw as {
        id?: string;
        title?: string;
        description?: string;
        project?: string;
        priority?: number;
        worker_role?: string | null;
        depends_on?: string[];
      };
      if (!args.id) return { ok: false, text: "id is required" };
      const before = getTask(deps.db, args.id);
      if (!before) return { ok: false, text: `task not found: ${args.id}` };
      if (before.ownerUserId !== ctx.userId) {
        // v0 keeps the board single-user. Future: add an explicit
        // share mechanism + relax this check.
        return { ok: false, text: `task ${args.id} is not yours` };
      }
      const patch: Parameters<typeof updateTask>[2] = {
        title: args.title,
        description: args.description,
        projectSlug: args.project,
        priority: args.priority,
        workerRole: args.worker_role,
      };
      if (args.depends_on !== undefined) {
        patch.dependsOn = sanitiseDepsForOwner(
          deps.db,
          ctx.userId,
          args.depends_on,
          args.id,
        );
      }
      const patched = updateTask(deps.db, args.id, patch);
      const blocked = patched
        ? patched.status === "todo" && !isEligible(deps.db, patched)
        : false;
      return {
        ok: true,
        text: `Updated task ${args.id}.`,
        data: { task: patched ? summarise(patched, blocked) : null },
      };
    },
  };
}

export function buildTaskMoveTool(deps: ToolDeps): AgentTool {
  return {
    schema: {
      name: "task_move",
      description:
        "Change a task's status column. Valid targets: todo, in_progress, done, stalled, aborted. " +
        "Moving back to 'todo' re-queues the task for the worker pool.",
      parameters: Type.Object({
        id: Type.String(),
        status: Type.String({ description: STATUS_DESCRIPTION }),
        result_summary: Type.Optional(
          Type.String({
            description:
              "Optional one-line summary for the result column (typically used when moving to done/stalled).",
          }),
        ),
      }),
    },
    execute: (raw, ctx: AgentToolContext): ToolReturn => {
      const args = raw as {
        id?: string;
        status?: string;
        result_summary?: string;
      };
      if (!args.id) return { ok: false, text: "id is required" };
      if (!args.status || !isTaskStatus(args.status)) {
        return { ok: false, text: `unknown status: ${args.status}` };
      }
      const before = getTask(deps.db, args.id);
      if (!before) return { ok: false, text: `task not found: ${args.id}` };
      if (before.ownerUserId !== ctx.userId) {
        return { ok: false, text: `task ${args.id} is not yours` };
      }

      const status = args.status;
      const now = Date.now();
      const patch: Parameters<typeof updateTask>[2] = { status };
      if (args.result_summary !== undefined) {
        patch.resultSummary = args.result_summary;
      }
      // Handy timestamp accounting so the UI doesn't have to guess.
      if (status === "in_progress" && !before.startedAt) patch.startedAt = now;
      if (status === "done" || status === "stalled" || status === "aborted") {
        patch.endedAt = now;
      }
      if (status === "todo") {
        patch.startedAt = null;
        patch.endedAt = null;
        patch.resultSummary = null;
      }
      const after = updateTask(deps.db, args.id, patch);

      // Re-queueing → kick the pool so the worker drains immediately.
      if (status === "todo") deps.onTaskWrite();

      const blocked = after
        ? after.status === "todo" && !isEligible(deps.db, after)
        : false;
      return {
        ok: true,
        text: `Moved task ${args.id}: ${before.status} → ${status}`,
        data: { task: after ? summarise(after, blocked) : null },
      };
    },
  };
}

export function buildTaskDeleteTool(deps: ToolDeps): AgentTool {
  return {
    schema: {
      name: "task_delete",
      description:
        "Remove a task from the board. The id is gone for good — there's no undo. " +
        "Prefer task_move with status='aborted' if you want to keep the audit trail.",
      parameters: Type.Object({
        id: Type.String(),
      }),
    },
    execute: (raw, ctx: AgentToolContext): ToolReturn => {
      const args = raw as { id?: string };
      if (!args.id) return { ok: false, text: "id is required" };
      const before = getTask(deps.db, args.id);
      if (!before) return { ok: false, text: `task not found: ${args.id}` };
      if (before.ownerUserId !== ctx.userId) {
        return { ok: false, text: `task ${args.id} is not yours` };
      }
      deleteTask(deps.db, args.id);
      return { ok: true, text: `Deleted task ${args.id}.` };
    },
  };
}
