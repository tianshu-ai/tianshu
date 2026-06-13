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
import { loadWorkerAgents } from "../fs-worker-agents.js";
import type { WorkerAgent } from "../types.js";

/** PR-C2 replaces the listWorkerAgents() DB call with a fs scan.
 *  Helper kept local so the existing call sites change as little
 *  as possible. The tool surface still passes through `deps.db`
 *  (some tools genuinely need it), so we don't bother routing
 *  tenantHomeDir through ToolDeps; we just rebuild the path from
 *  the tenant id we already have. */
function listAgents(
  tenantId: string,
  tenantHomeDir: string,
): WorkerAgent[] {
  return loadWorkerAgents({ tenantId, tenantHomeDir }).agents;
}
import { readSessionHistory } from "../db/session-history.js";

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
  worker_agent_id: Type.Optional(
    Type.String({
      description:
        "Slug of the worker that should pick this task up (e.g. \"coder\", \"llm-default\"). Use `tenant_config_list({path:\"workers\"})` to see what's registered. Omitting this leaves the task unpinned — any enabled worker can grab it, but you lose control over which one. Pinning by slug is the recommended path; kind-based dispatch is no longer exposed.",
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
  worker_agent_id?: string;
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
        "tasks automatically. Per-row failures (e.g. an unknown worker_agent_id) do " +
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
      const agents = listAgents(ctx.tenantId, ctx.tenantHomeDir);
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
        const explicitAgentId = item.worker_agent_id?.trim() || null;
        if (explicitAgentId) {
          const target = agents.find((a) => a.id === explicitAgentId);
          if (!target) {
            return {
              ok: false,
              index,
              text: `Worker agent "${explicitAgentId}" doesn't exist in this tenant. Use \`tenant_config_list({ path: "workers" })\` to see available slugs.`,
            };
          }
          if (!target.enabled) {
            return {
              ok: false,
              index,
              text: `Worker agent "${target.name}" (${explicitAgentId}) is disabled. Enable it (set agent.json enabled: true) or pick another worker.`,
            };
          }
        }
        const task = createTask(deps.db, id, {
          ownerUserId: ctx.userId,
          title,
          description: item.description,
          projectSlug: item.project,
          priority: item.priority,
          // workerRole no longer set from the tool surface —
          // dispatch is by worker_agent_id (slug) only. The DB
          // column stays for backwards compat with existing rows.
          workerRole: null,
          workerAgentId: explicitAgentId,
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
        "priority, worker_agent_id, depends_on, labels). For status changes use task_move.",
      parameters: Type.Object({
        id: Type.String(),
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        project: Type.Optional(Type.String()),
        priority: Type.Optional(Type.Number()),
        worker_agent_id: Type.Optional(
          Type.Union([Type.String(), Type.Null()], {
            description:
              "Repin to a different worker by slug, or pass null to clear the pin (any enabled worker can grab it). Use `tenant_config_list({path:\"workers\"})` to see slugs.",
          }),
        ),
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
        worker_agent_id?: string | null;
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
      // If the patch changes the pin, validate the slug exists
      // and is enabled (same rule as on create). `undefined` =
      // don't touch; explicit `null` = clear the pin.
      if (args.worker_agent_id !== undefined && args.worker_agent_id !== null) {
        const slug = args.worker_agent_id.trim();
        if (!slug) {
          return {
            ok: false,
            text: "worker_agent_id is empty; pass null to clear the pin or a slug to pin.",
          };
        }
        const target = listAgents(ctx.tenantId, ctx.tenantHomeDir).find(
          (a) => a.id === slug,
        );
        if (!target) {
          return {
            ok: false,
            text: `Worker agent "${slug}" doesn't exist. Use \`tenant_config_list({path:"workers"})\` for available slugs.`,
          };
        }
        if (!target.enabled) {
          return {
            ok: false,
            text: `Worker agent "${target.name}" (${slug}) is disabled. Enable it or pick another.`,
          };
        }
      }
      const patch: Parameters<typeof updateTask>[2] = {
        title: args.title,
        description: args.description,
        projectSlug: args.project,
        priority: args.priority,
        workerAgentId: args.worker_agent_id,
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

