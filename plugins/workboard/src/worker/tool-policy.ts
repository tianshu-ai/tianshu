// Shared worker tool-policy constants.
//
// Single source of truth for which workboard tools belong to the
// orchestrator (chat session) vs the worker (LLM running one task).
// Three call sites consume this:
//
//   - `server.ts` — when seeding the builtin LLM worker agent's
//     `toolsAllow`, strip orchestration-only tools so the seed
//     never advertises them.
//   - `worker/pool.ts` — runtime deny-list applied to every
//     `runAgentLoop()` call, belt-and-braces with the seed.
//   - `worker-agents-page.tsx` — the admin form filters the tool
//     catalog so the user can't even see / pick orchestration
//     tools when editing a worker agent. (User asked for this:
//     "用户也不能选中，最好就不在列表里显示出来".)
//
// Keep this file dependency-free (no node, no DB, no React) so
// every entry point can import it without bundle bloat.

/**
 * Workboard task-management tools that the host (chat) needs but a
 * worker has no business calling. A worker is meant to *do* a task,
 * not create / move / delete / list other tasks. Without this
 * deny-list a worker can confuse `task_complete` with
 * `task_create` and end up dropping a phantom todo on the board
 * (we caught this on the LangGraph T1 run).
 *
 * `task_complete` is the legitimate exit signal so it stays.
 */
export const WORKER_DENY_TOOLS: readonly string[] = [
  "task_list",
  "task_create",
  "task_update",
  "task_move",
  "task_delete",
  // History is for the orchestrator/user explaining a task,
  // not for the worker introspecting its peers.
  "task_get_history",
  // Worker-agent CRUD belongs to the orchestrator. A worker is
  // configured *before* it runs; letting it self-mutate — or
  // mutate peers — would just be a self-foot-gun.
  "worker_agent_kinds_list",
  "worker_agent_list",
  "worker_agent_create",
  "worker_agent_update",
  "worker_agent_delete",
  "worker_agent_reset",
] as const;

export const WORKER_DENY_TOOLS_SET: ReadonlySet<string> = new Set(
  WORKER_DENY_TOOLS,
);

/**
 * Tools that the worker MUST have available, no matter what the
 * user configured per-agent. `task_complete` is the only legitimate
 * exit signal a worker has — if the user trims it out of
 * `toolsAllow`, the worker can't tell the orchestrator it's done
 * and the run will time out / be killed for stalling, even on a
 * perfectly-completed task. So we force-inject it at the pool
 * boundary, after the user's allow-list has been applied.
 *
 * Keep this list small; anything in here is something the worker
 * runtime depends on for control-flow correctness, NOT something
 * an agent designer might want to choose.
 */
export const WORKER_REQUIRED_TOOLS: readonly string[] = [
  "task_complete",
] as const;
