// Agent tools the workboard plugin contributes.
//
// Five tools cover the kanban surface from the agent's side:
//
//   - task_list   — read the board (status-grouped, optional project filter)
//   - task_create — drop one or more new ready tasks on the board (batch)
//   - task_update — patch title / description / priority / project
//   - task_move   — move a task between status columns
//   - task_delete — remove one or more tasks (batch)
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
import {
  createUserWorkerAgent,
  deleteWorkerAgent,
  getWorkerAgent,
  listWorkerAgents,
  resetBuiltinAgent,
  updateWorkerAgent,
  type SeedAgentSpec,
  type WorkerAgent,
} from "../db/agents.js";
import { readSessionHistory } from "../db/session-history.js";
import {
  ALL_WORKER_KIND_FIELDS,
  allowedFieldsFor,
  type WorkerKindDef,
  type WorkerKindField,
} from "../routes/handlers.js";

export interface ToolDeps {
  db: TenantDbHandle;
  log: PluginLogger;
  /** Called after a write so the worker pool drains pending todos. */
  onTaskWrite(): void;
}

/** Extra deps the worker_agent_* tools need on top of `ToolDeps`. */
export interface AgentToolDeps extends ToolDeps {
  /** Tenant id for tenant-scoped agent CRUD. The pool's `nudge`
   *  doesn't need it because pool/db are already tenant-bound, but
   *  the agent CRUD layer takes it explicitly. */
  tenantId: string;
  /** Workboard's kind catalogue. Same list the admin UI reads via
   *  `GET /api/p/workboard/agents`; the tools use it for kind
   *  validation + per-kind field allow-listing. */
  workerKinds: WorkerKindDef[];
  /** Builtin seeds keyed by `builtin_key` so `worker_agent_reset`
   *  can roll a row back to its default. */
  seedsByKey: Map<string, SeedAgentSpec>;
  /** Notify the pool that the agent set changed so it can rebuild
   *  worker slots. */
  onAgentsWrite(): void;
}

interface ToolReturn {
  ok: boolean;
  text: string;
  data?: unknown;
}

const STATUS_DESCRIPTION =
  'One of "ready", "in_progress", "done". ' +
  '"ready" tasks are picked up by the worker pool. ' +
  'Tasks tagged with the "stalled" or "draft" label stay in "ready" ' +
  'but are skipped by the pool until the label is removed.';

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
    labels: t.labels,
    failureReason: t.failureReason,
    attempts: t.attempts,
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
        "(ready / in_progress / done). Pass a project filter to scope " +
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
        if (t.status === "ready" && !isEligible(deps.db, t)) {
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

/**
 * Schema for one task inside a `task_create` batch. Kept as a
 * named TypeBox object so the description renders cleanly inside
 * the array's items schema.
 */
const TaskCreateItem = Type.Object({
  title: Type.String({ description: "Short human-readable title." }),
  description: Type.Optional(
    Type.String({ description: "Long-form notes / context for the worker." }),
  ),
  project: Type.Optional(
    Type.String({ description: "Project slug. Default \"inbox\"." }),
  ),
  priority: Type.Optional(
    Type.Number({
      description: "Higher = picked up first. Range -10..10; default 0.",
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
  labels: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Free-form labels. Reserved values: 'stalled' (after MAX_ATTEMPTS pool failures, set automatically) and 'draft' (user opt-in: keeps the task in ready column but the pool skips it until cleared).",
    }),
  ),
});

type TaskCreateItemArgs = {
  title?: string;
  description?: string;
  project?: string;
  priority?: number;
  worker_role?: string;
  depends_on?: string[];
  labels?: string[];
};

export function buildTaskCreateTool(deps: ToolDeps): AgentTool {
  return {
    schema: {
      name: "task_create",
      description:
        "Drop one or more new tasks on the workboard. Always pass a `tasks` array — " +
        "single-task callers should send a 1-element array. Defaults are " +
        "status=ready, project=inbox; workers in the pool will pick up ready " +
        "tasks automatically. Per-row failures (e.g. an unknown worker_role) do " +
        "NOT abort the rest of the batch — each row reports independently in " +
        "the response's `results` array.",
      parameters: Type.Object({
        tasks: Type.Array(TaskCreateItem, {
          minItems: 1,
          maxItems: 100,
          description:
            "Tasks to create, in the order they should appear in `results`.",
        }),
      }),
    },
    execute: (raw, ctx: AgentToolContext): ToolReturn => {
      const args = raw as { tasks?: TaskCreateItemArgs[] };
      const items = Array.isArray(args.tasks) ? args.tasks : [];
      if (items.length === 0) {
        return { ok: false, text: "tasks array must not be empty" };
      }
      // Cache the worker-agent list once for the whole batch —
      // creating 50 tasks against the same role shouldn't hit the
      // DB 50 times for the same lookup.
      const agents = listWorkerAgents(deps.db, ctx.tenantId);
      type Row = {
        ok: boolean;
        index: number;
        task?: ReturnType<typeof summarise>;
        text?: string;
      };
      const results: Row[] = items.map((item, index) => {
        const title = item?.title?.trim();
        if (!title) {
          return { ok: false, index, text: "title is required" };
        }
        if (title.length > 200) {
          return {
            ok: false,
            index,
            text: "title too long (max 200 chars)",
          };
        }
        const id = randomUUID();
        const dependsOn = sanitiseDepsForOwner(
          deps.db,
          ctx.userId,
          item.depends_on,
          id,
        );
        const role = item.worker_role ?? null;
        if (role) {
          const candidates = agents.filter(
            (a) => a.enabled && a.kind === role,
          );
          if (candidates.length === 0) {
            return {
              ok: false,
              index,
              text: `No enabled worker has kind="${role}". Either enable an existing worker of that kind under Settings → Plugins → Worker agents, or omit worker_role so any worker can pick the task up.`,
            };
          }
        }
        const task = createTask(deps.db, id, {
          ownerUserId: ctx.userId,
          title,
          description: item.description,
          projectSlug: item.project,
          priority: item.priority,
          workerRole: role,
          dependsOn,
          labels: item.labels,
          // Stamp the asking session so the pool knows who to
          // notify when this task finishes. Tools called outside
          // an LLM context (none of these today, but possible
          // for an internal job) just leave it null.
          parentSessionId: ctx.sessionId ?? null,
        });
        const blocked = !isEligible(deps.db, task);
        return {
          ok: true,
          index,
          task: summarise(task, blocked),
        };
      });
      const okCount = results.filter((r) => r.ok).length;
      if (okCount > 0) deps.onTaskWrite();
      const failCount = results.length - okCount;
      const summary =
        failCount === 0
          ? `Created ${okCount} task${okCount === 1 ? "" : "s"}.`
          : `Created ${okCount}/${results.length} task${results.length === 1 ? "" : "s"}; ${failCount} failed.`;
      return {
        ok: okCount > 0,
        text: summary,
        data: { results },
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
        "priority, worker_role, depends_on, labels). For status changes use task_move.",
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
        labels: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Replace the labels list. Pass [] to clear. Reserved: 'stalled' (set automatically by the pool after MAX_ATTEMPTS failures), 'draft' (pool skip).",
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
        labels?: string[];
      };
      if (!args.id) return { ok: false, text: "id is required" };
      const before = getTask(deps.db, args.id);
      if (!before) return { ok: false, text: `task not found: ${args.id}` };
      if (before.ownerUserId !== ctx.userId) {
        // v0 keeps the board single-user. Future: add an explicit
        // share mechanism + relax this check.
        return { ok: false, text: `task ${args.id} is not yours` };
      }
      // If the patch changes the role, validate the new role is
      // serviceable (same rule as on create). args.worker_role of
      // `undefined` means "don't touch"; an explicit `null` clears
      // the role pin (always safe).
      if (args.worker_role !== undefined && args.worker_role !== null) {
        const candidates = listWorkerAgents(deps.db, ctx.tenantId).filter(
          (a) => a.enabled && a.kind === args.worker_role,
        );
        if (candidates.length === 0) {
          return {
            ok: false,
            text: `No enabled worker has kind="${args.worker_role}". Enable a matching worker under Settings → Plugins → Worker agents, or pass worker_role=null to clear the pin.`,
          };
        }
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
      if (args.labels !== undefined) {
        patch.labels = args.labels;
      }
      const patched = updateTask(deps.db, args.id, patch);
      // If the patch dropped the `stalled` / `draft` label the
      // task may now be claimable; nudge so the pool re-considers.
      if (
        patched &&
        args.labels !== undefined &&
        before.labels.some((l) => ["stalled", "draft"].includes(l)) &&
        !patched.labels.some((l) => ["stalled", "draft"].includes(l)) &&
        patched.status === "ready"
      ) {
        deps.onTaskWrite();
      }
      const blocked = patched
        ? patched.status === "ready" && !isEligible(deps.db, patched)
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
        "Change a task's status column. Valid targets: ready, in_progress, done. " +
        "Moving back to 'ready' re-queues the task for the worker pool.",
      parameters: Type.Object({
        id: Type.String(),
        status: Type.String({ description: STATUS_DESCRIPTION }),
        result_summary: Type.Optional(
          Type.String({
            description:
              "Optional one-line summary for the result column (typically used when moving to done).",
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
      if (status === "done") {
        patch.endedAt = now;
      }
      if (status === "ready") {
        patch.startedAt = null;
        patch.endedAt = null;
        patch.resultSummary = null;
        // Manual re-queue clears the failure trail too — the user
        // is saying "this is fixed, try again".
        patch.failureReason = null;
        patch.attempts = 0;
      }
      const after = updateTask(deps.db, args.id, patch);

      // Re-queueing → kick the pool so the worker drains immediately.
      // Nudge the pool when the move could create new claimable
      // work: putting THIS task back to ready, OR marking it done
      // and thereby unblocking any task that depended on it.
      if (status === "ready" || status === "done") deps.onTaskWrite();

      const blocked = after
        ? after.status === "ready" && !isEligible(deps.db, after)
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
        "Remove one or more tasks from the board. Always pass an `ids` array — " +
        "single-task callers should send a 1-element array. Per-row failures " +
        "(unknown id, not yours) do NOT abort the rest of the batch — each " +
        "id reports independently in `results`. The deletion is permanent; " +
        "add the 'stalled' label via task_update if you want to keep an audit " +
        "trail instead.",
      parameters: Type.Object({
        ids: Type.Array(Type.String(), {
          minItems: 1,
          maxItems: 100,
          description: "Task ids to delete, order matches the `results`.",
        }),
      }),
    },
    execute: (raw, ctx: AgentToolContext): ToolReturn => {
      const args = raw as { ids?: string[] };
      const ids = Array.isArray(args.ids) ? args.ids : [];
      if (ids.length === 0) {
        return { ok: false, text: "ids array must not be empty" };
      }
      type Row = { ok: boolean; id: string; text?: string };
      const results: Row[] = ids.map((id) => {
        if (typeof id !== "string" || !id) {
          return {
            ok: false,
            id: String(id ?? ""),
            text: "id is required",
          };
        }
        const before = getTask(deps.db, id);
        if (!before) return { ok: false, id, text: `task not found: ${id}` };
        if (before.ownerUserId !== ctx.userId) {
          return { ok: false, id, text: `task ${id} is not yours` };
        }
        deleteTask(deps.db, id);
        return { ok: true, id };
      });
      const okCount = results.filter((r) => r.ok).length;
      if (okCount > 0) deps.onTaskWrite();
      const failCount = results.length - okCount;
      const summary =
        failCount === 0
          ? `Deleted ${okCount} task${okCount === 1 ? "" : "s"}.`
          : `Deleted ${okCount}/${results.length} task${results.length === 1 ? "" : "s"}; ${failCount} failed.`;
      return {
        ok: okCount > 0,
        text: summary,
        data: { results },
      };
    },
  };
}

/**
 * Read a task's worker execution transcript.
 *
 * The chat-side orchestrator calls this when the user asks "why
 * did T4 fail?" — the orchestrator gets the full assistant /
 * tool-call / tool-result trail of the worker's most recent run
 * and can reason about it directly. The same data backs the
 * kanban Execution tab; both views go through this code path so
 * the agent can never see anything the user can't.
 *
 * Empty `entries` is the normal response for a task that has
 * never been claimed (`tasks.session_id IS NULL`).
 */
export function buildTaskGetHistoryTool(deps: ToolDeps): AgentTool {
  return {
    schema: {
      name: "task_get_history",
      description:
        "Fetch the worker's execution transcript for a task you own. " +
        "Returns the chronological list of assistant / tool-call / " +
        "tool-result rows from the worker's most recent run, plus " +
        "attempts and failure_reason. Use this when the user wants " +
        "to know why a task stalled or what the worker actually did.",
      parameters: Type.Object({
        id: Type.String({ description: "Task id." }),
      }),
    },
    execute: (raw, ctx: AgentToolContext): ToolReturn => {
      const args = raw as { id?: string };
      if (!args.id) return { ok: false, text: "id is required" };
      const task = getTask(deps.db, args.id);
      if (!task) return { ok: false, text: `task not found: ${args.id}` };
      if (task.ownerUserId !== ctx.userId) {
        return { ok: false, text: `task ${args.id} is not yours` };
      }
      const sessionId = task.sessionId;
      if (!sessionId) {
        return {
          ok: true,
          text: `Task ${args.id} has no execution history yet (never claimed by a worker).`,
          data: {
            taskId: task.id,
            sessionId: null,
            attempts: task.attempts,
            failureReason: task.failureReason,
            entries: [],
          },
        };
      }
      const entries = readSessionHistory(deps.db, sessionId);
      return {
        ok: true,
        text: `Found ${entries.length} entries from the worker session for task ${args.id}.`,
        data: {
          taskId: task.id,
          sessionId,
          attempts: task.attempts,
          failureReason: task.failureReason,
          entries,
        },
      };
    },
  };
}

/**
 * Special agent tool the LLM worker calls to wrap up the task it
 * was assigned. The agent-loop's wrapper picks the structured
 * `summary` / `files` fields off the return value and resolves the
 * loop with `status=done`. Calling this tool is the *only* way for
 * an LLM worker to mark its task complete — walking off without it
 * leaves the loop stalled.
 *
 * The tool intentionally has no side-effect on the workboard's
 * tasks table itself — the LLMWorker class writes the row using
 * the captured summary/files, keeping the agent ignorant of the
 * caller's task id. (An LLM that didn't know the task id couldn't
 * forge a completion for someone else's task.)
 */
export function buildTaskCompleteTool(): AgentTool {
  return {
    schema: {
      name: "task_complete",
      description:
        "Call this when you have finished the task you were assigned. " +
        "Pass a one-line `summary` of what you produced and an optional " +
        "list of `files` you wrote (paths under your home dir). After this " +
        "call, the worker terminates and the orchestrator reads your summary.",
      parameters: Type.Object({
        summary: Type.String({
          description: "One-line summary of the result. Required.",
        }),
        files: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Optional list of output file paths the worker produced.",
          }),
        ),
      }),
    },
    execute: (raw): ToolReturn => {
      const args = raw as { summary?: unknown; files?: unknown };
      const summary =
        typeof args.summary === "string" ? args.summary.trim() : "";
      if (!summary) {
        return { ok: false, text: "summary is required" };
      }
      const files = Array.isArray(args.files)
        ? args.files.filter((f): f is string => typeof f === "string")
        : [];
      // The agent-loop wrapper picks up the canonical summary/files
      // off the *arguments* the agent passed (see
      // `wrappedExecutors[task_complete]` in chat/agent-loop.ts), so
      // we don't need to thread them through the return shape.
      return {
        ok: true,
        text: "Task marked complete. The worker will exit.",
        data: { summary, files },
      };
    },
  };
}

// ─── Worker agent CRUD (orchestrator-side) ──────────────────────
//
// These tools let the chat orchestrator manage the worker_agents
// table: list / create / patch / delete user-created workers and
// reset builtin ones to their seeded defaults. The same pieces are
// already exposed via `/api/p/workboard/agents/*` for the admin
// UI; this just makes them callable from the agent loop so the
// model can do things like "create a worker that uses Claude Sonnet
// with the web_search tool" without the user leaving chat.
//
// Field handling mirrors the REST handlers exactly: the per-kind
// field allow-list (`allowedFieldsFor` from routes/handlers.ts) is
// consulted on every write, and stray fields trip a
// `field_not_allowed_for_kind` error so an `echo` worker can't
// accidentally carry a system prompt.
//
// These tools are deliberately NOT in WORKER_DENY_TOOLS' opposite —
// i.e. workers don't get them. A worker is configured by its
// orchestrator before it runs; letting it self-mutate (or mutate
// peers) would just be a self-foot-gun.

function agentJson(a: WorkerAgent): Record<string, unknown> {
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    description: a.description,
    modelId: a.modelId,
    systemPrompt: a.systemPrompt,
    toolsAllow: a.toolsAllow,
    skills: a.skills,
    enabled: a.enabled,
    source: a.source,
    builtinKey: a.builtinKey,
    overridesAt: a.overridesAt,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function kindJson(k: WorkerKindDef): Record<string, unknown> {
  return {
    id: k.id,
    displayName: k.displayName,
    description: k.description ?? null,
    userCreatable: k.userCreatable !== false,
    fields: k.fields ?? ALL_WORKER_KIND_FIELDS,
  };
}

/** Common typebox shape for the optional fields a kind may opt
 *  into. Every field is optional at the schema layer; per-kind
 *  validation runs after parse so the error message is precise. */
const AgentEditableFields = {
  description: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        "Free-form description shown in the admin UI. Pass null to clear.",
    }),
  ),
  modelId: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        "Model id (e.g. \"sap-proxy/claude-sonnet-4-6\"). Only valid for kinds that opt into this field (e.g. `llm`). Pass null to fall back to the host default.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        "Worker system prompt. Only valid for kinds that opt into this field. Empty/null clears it (the kind's default prompt applies).",
    }),
  ),
  toolsAllow: Type.Optional(
    Type.Union([Type.Array(Type.String()), Type.Null()], {
      description:
        "Allow-list of host tool names the worker may call. Null = no restriction (all host tools available). Orchestration tools (task_list / task_create / task_update / task_move / task_delete / task_get_history) are denied at runtime regardless of what's listed here.",
    }),
  ),
  skills: Type.Optional(
    Type.Union([Type.Array(Type.String()), Type.Null()], {
      description:
        "Allow-list of skill names the worker is taught. Null = no restriction.",
    }),
  ),
};

function validateAgainstKind(
  kind: string,
  body: Record<string, unknown>,
  workerKinds: WorkerKindDef[],
): { ok: true } | { ok: false; text: string; data?: unknown } {
  const def = workerKinds.find((k) => k.id === kind);
  if (!def) {
    return {
      ok: false,
      text: `unknown worker kind "${kind}". Call worker_agent_kinds_list to see available kinds.`,
      data: { code: "unknown_kind", kind },
    };
  }
  const allow = allowedFieldsFor(kind, workerKinds);
  for (const f of ALL_WORKER_KIND_FIELDS) {
    if (!allow.has(f) && body[f] !== undefined) {
      return {
        ok: false,
        text: `field "${f}" is not allowed for kind "${kind}". Allowed fields: ${[...allow].join(", ") || "(name only)"}.`,
        data: { code: "field_not_allowed_for_kind", kind, field: f },
      };
    }
  }
  return { ok: true };
}

export function buildWorkerAgentKindsListTool(
  deps: AgentToolDeps,
): AgentTool {
  return {
    schema: {
      name: "worker_agent_kinds_list",
      description:
        "List the worker kinds this workboard supports. Returns one row per kind with `id`, `displayName`, `description`, `userCreatable`, and `fields` (the optional config fields that kind accepts on top of `name`). Call this before `worker_agent_create` if you don't already know which kinds exist.",
      parameters: Type.Object({}),
    },
    execute: (): ToolReturn => {
      const rows = deps.workerKinds.map(kindJson);
      const lines = rows.map((k) => {
        const fields = (k.fields as readonly string[]).join(", ") || "(name only)";
        const tag = k.userCreatable ? "" : " [seed-only]";
        return `- ${k.id}${tag} — ${k.displayName}; fields: ${fields}`;
      });
      return {
        ok: true,
        text: lines.length ? lines.join("\n") : "(no worker kinds registered)",
        data: { kinds: rows },
      };
    },
  };
}

export function buildWorkerAgentListTool(deps: AgentToolDeps): AgentTool {
  return {
    schema: {
      name: "worker_agent_list",
      description:
        "List configured worker agents in this tenant. Optional filters: `kind` (echo / llm / ...), `enabled` (true=only enabled, false=only disabled, omit=both), `source` (\"builtin\" or \"user\").",
      parameters: Type.Object({
        kind: Type.Optional(
          Type.String({ description: "Filter by worker kind id." }),
        ),
        enabled: Type.Optional(
          Type.Boolean({
            description: "true = only enabled, false = only disabled.",
          }),
        ),
        source: Type.Optional(
          Type.String({
            description: '"builtin" or "user".',
          }),
        ),
      }),
    },
    execute: (raw): ToolReturn => {
      const args = raw as {
        kind?: string;
        enabled?: boolean;
        source?: string;
      };
      let agents = listWorkerAgents(deps.db, deps.tenantId);
      if (args.kind) {
        const k = args.kind;
        agents = agents.filter((a) => a.kind === k);
      }
      if (typeof args.enabled === "boolean") {
        const want = args.enabled;
        agents = agents.filter((a) => a.enabled === want);
      }
      if (args.source === "builtin" || args.source === "user") {
        const src = args.source;
        agents = agents.filter((a) => a.source === src);
      }
      const lines = agents.map((a) => {
        const flags: string[] = [a.kind, a.source];
        if (!a.enabled) flags.push("disabled");
        if (a.modelId) flags.push(`model=${a.modelId}`);
        return `- ${a.id} "${a.name}" (${flags.join(", ")})`;
      });
      return {
        ok: true,
        text: lines.length ? lines.join("\n") : "(no worker agents)",
        data: { agents: agents.map(agentJson) },
      };
    },
  };
}

export function buildWorkerAgentCreateTool(deps: AgentToolDeps): AgentTool {
  return {
    schema: {
      name: "worker_agent_create",
      description:
        "Create a new worker agent in this tenant. `kind` and `name` are required; the optional fields are kind-dependent — call `worker_agent_kinds_list` if you're not sure which fields a kind accepts. Returns the created row.",
      parameters: Type.Object({
        kind: Type.String({
          description:
            'Worker kind id (e.g. "llm"). Use `worker_agent_kinds_list` to discover.',
        }),
        name: Type.String({
          description: "Human-readable name shown in the UI / pool logs.",
        }),
        ...AgentEditableFields,
        enabled: Type.Optional(
          Type.Boolean({
            description: "Defaults to true; pass false to create muted.",
          }),
        ),
      }),
    },
    execute: (raw, ctx: AgentToolContext): ToolReturn => {
      const args = raw as Record<string, unknown>;
      const kind = typeof args.kind === "string" ? args.kind.trim() : "";
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!kind) return { ok: false, text: "kind is required" };
      if (!name) return { ok: false, text: "name is required" };
      if (name.length > 80) {
        return { ok: false, text: "name too long (max 80 chars)" };
      }
      const def = deps.workerKinds.find((k) => k.id === kind);
      if (!def) {
        return {
          ok: false,
          text: `unknown worker kind "${kind}". Call worker_agent_kinds_list to see available kinds.`,
          data: { code: "unknown_kind", kind },
        };
      }
      if (def.userCreatable === false) {
        return {
          ok: false,
          text: `kind "${kind}" is seed-only and cannot be created at runtime.`,
          data: { code: "kind_not_user_creatable", kind },
        };
      }
      const guard = validateAgainstKind(kind, args, deps.workerKinds);
      if (!guard.ok) return guard;
      const allow = allowedFieldsFor(kind, deps.workerKinds);
      const description =
        allow.has("description") && typeof args.description === "string"
          ? args.description
          : null;
      const modelId =
        allow.has("modelId") && typeof args.modelId === "string"
          ? args.modelId
          : null;
      const systemPrompt =
        allow.has("systemPrompt") && typeof args.systemPrompt === "string"
          ? args.systemPrompt
          : null;
      const toolsAllow =
        allow.has("toolsAllow") && Array.isArray(args.toolsAllow)
          ? args.toolsAllow.filter((x): x is string => typeof x === "string")
          : null;
      const skills =
        allow.has("skills") && Array.isArray(args.skills)
          ? args.skills.filter((x): x is string => typeof x === "string")
          : null;
      const enabled =
        typeof args.enabled === "boolean" ? args.enabled : true;
      const created = createUserWorkerAgent(deps.db, deps.tenantId, {
        kind,
        name,
        description,
        modelId,
        systemPrompt,
        toolsAllow,
        skills,
        ownerUserId: ctx.userId,
        enabled,
      });
      deps.onAgentsWrite();
      return {
        ok: true,
        text: `Created worker agent ${created.id} "${created.name}" (${created.kind}).`,
        data: { agent: agentJson(created) },
      };
    },
  };
}

export function buildWorkerAgentUpdateTool(deps: AgentToolDeps): AgentTool {
  return {
    schema: {
      name: "worker_agent_update",
      description:
        "Patch an existing worker agent. Only pass the fields you want to change; omitting a field leaves it as-is. Pass `null` to clear nullable fields. Toggling only `enabled` does NOT mark the row as user-edited (so future plugin upgrades can still flow display fields through); changing any other field locks the row against seed updates.",
      parameters: Type.Object({
        id: Type.String({ description: "Worker agent id." }),
        name: Type.Optional(Type.String()),
        enabled: Type.Optional(Type.Boolean()),
        ...AgentEditableFields,
      }),
    },
    execute: (raw): ToolReturn => {
      const args = raw as Record<string, unknown>;
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return { ok: false, text: "id is required" };
      const before = getWorkerAgent(deps.db, deps.tenantId, id);
      if (!before) {
        return {
          ok: false,
          text: `worker agent ${id} not found`,
          data: { code: "not_found" },
        };
      }
      const guard = validateAgainstKind(before.kind, args, deps.workerKinds);
      if (!guard.ok) return guard;
      const allow = allowedFieldsFor(before.kind, deps.workerKinds);
      const patch: Parameters<typeof updateWorkerAgent>[3] = {};
      if (typeof args.name === "string") patch.name = args.name;
      if (allow.has("description") && "description" in args) {
        patch.description =
          typeof args.description === "string" ? args.description : null;
      }
      if (allow.has("modelId") && "modelId" in args) {
        patch.modelId =
          typeof args.modelId === "string" ? args.modelId : null;
      }
      if (allow.has("systemPrompt") && "systemPrompt" in args) {
        patch.systemPrompt =
          typeof args.systemPrompt === "string" ? args.systemPrompt : null;
      }
      if (allow.has("toolsAllow") && "toolsAllow" in args) {
        patch.toolsAllow = Array.isArray(args.toolsAllow)
          ? args.toolsAllow.filter(
              (x): x is string => typeof x === "string",
            )
          : null;
      }
      if (allow.has("skills") && "skills" in args) {
        patch.skills = Array.isArray(args.skills)
          ? args.skills.filter((x): x is string => typeof x === "string")
          : null;
      }
      if (typeof args.enabled === "boolean") {
        patch.enabled = args.enabled;
      }
      const after = updateWorkerAgent(deps.db, deps.tenantId, id, patch);
      if (!after) {
        return {
          ok: false,
          text: `worker agent ${id} disappeared mid-update`,
          data: { code: "not_found" },
        };
      }
      deps.onAgentsWrite();
      return {
        ok: true,
        text: `Updated worker agent ${after.id} "${after.name}".`,
        data: { agent: agentJson(after) },
      };
    },
  };
}

export function buildWorkerAgentDeleteTool(deps: AgentToolDeps): AgentTool {
  return {
    schema: {
      name: "worker_agent_delete",
      description:
        "Delete a user-created worker agent. Builtin (seeded) rows cannot be deleted — call `worker_agent_reset` instead to roll them back to defaults.",
      parameters: Type.Object({
        id: Type.String({ description: "Worker agent id." }),
      }),
    },
    execute: (raw): ToolReturn => {
      const args = raw as { id?: string };
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return { ok: false, text: "id is required" };
      const before = getWorkerAgent(deps.db, deps.tenantId, id);
      if (!before) {
        return {
          ok: false,
          text: `worker agent ${id} not found`,
          data: { code: "not_found" },
        };
      }
      if (before.source === "builtin") {
        return {
          ok: false,
          text: `worker agent ${id} ("${before.name}") is a builtin row; use worker_agent_reset instead.`,
          data: { code: "cannot_delete_builtin" },
        };
      }
      const ok = deleteWorkerAgent(deps.db, deps.tenantId, id);
      if (!ok) {
        return {
          ok: false,
          text: `failed to delete ${id}`,
          data: { code: "delete_failed" },
        };
      }
      deps.onAgentsWrite();
      return {
        ok: true,
        text: `Deleted worker agent ${id} "${before.name}".`,
      };
    },
  };
}

export function buildWorkerAgentResetTool(deps: AgentToolDeps): AgentTool {
  return {
    schema: {
      name: "worker_agent_reset",
      description:
        "Reset a builtin worker agent back to its seeded defaults and clear the `overrides_at` flag so future plugin upgrades flow through. Only works on rows where `source` is `builtin`.",
      parameters: Type.Object({
        id: Type.String({ description: "Worker agent id." }),
      }),
    },
    execute: (raw): ToolReturn => {
      const args = raw as { id?: string };
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return { ok: false, text: "id is required" };
      const before = getWorkerAgent(deps.db, deps.tenantId, id);
      if (!before) {
        return {
          ok: false,
          text: `worker agent ${id} not found`,
          data: { code: "not_found" },
        };
      }
      if (before.source !== "builtin" || !before.builtinKey) {
        return {
          ok: false,
          text: `worker agent ${id} is not a builtin row; nothing to reset.`,
          data: { code: "not_builtin" },
        };
      }
      const after = resetBuiltinAgent(
        deps.db,
        deps.tenantId,
        id,
        deps.seedsByKey,
      );
      if (!after) {
        return {
          ok: false,
          text: `worker agent ${id} no longer matches a seed; cannot reset.`,
          data: { code: "seed_missing" },
        };
      }
      deps.onAgentsWrite();
      return {
        ok: true,
        text: `Reset builtin worker agent ${after.id} "${after.name}" to seeded defaults.`,
        data: { agent: agentJson(after) },
      };
    },
  };
}
