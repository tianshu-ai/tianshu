// Capability-side type for `host.agentLoop`.
//
// The host registers a runner satisfying this interface; plugins
// look it up via `ctx.capabilities.get<AgentLoopRunner>(\"host.agentLoop\")`.
//
// We deliberately re-declare the request/result shapes in the SDK
// instead of re-exporting from `@tianshu/server` so plugin builds
// don't have to depend on the server bundle. The host's actual
// implementation must remain shape-compatible with this contract.

export interface AgentLoopRunnerRequest {
  /** Owner of the worker session. Tasks are owner-scoped, so this
   *  must match the task's owner_user_id when called by a worker
   *  pool. */
  userId: string;
  /** Initial user prompt. The headline + a Description block work
   *  fine; any well-formed prompt does. */
  initialUserMessage: string;
  /** System-prompt override; falls through to the host default. */
  systemPrompt?: string;
  /** Model id from tenant config; falls through to default. */
  modelId?: string;
  /** Allow-list of tool names. `null` / undefined = all available. */
  toolsAllow?: string[] | null;
  /** Deny-list applied AFTER `toolsAllow`. Used by worker pools to
   *  scrub tools that are unsafe in worker context (e.g. workboard's
   *  task_create) regardless of what the agent's allow-list says. */
  toolsDeny?: string[] | null;
  /** Allow-list of skill names; same semantics. */
  skillsAllow?: string[] | null;
  /** Friendly title for the worker session row. */
  sessionTitle?: string | null;
  /** Worker role. Use the kind id (e.g. \"llm\") when called from a
   *  worker pool. */
  workerRole?: string | null;
  /** Worker filesystem slug — the directory name under
   *  `_tenant/config/workers/<slug>/`. Drives the
   *  `tenant_config_write` boundary so a worker can author skills
   *  inside its own bundle. When omitted, the tools fall back to
   *  scoping by `workerRole`. */
  workerSlug?: string | null;
  /** Task id when this run is driven by a workboard task. Plumbed
   *  through to `AgentToolContext.taskId` so per-task tools (most
   *  importantly the microsandbox `exec` route) can scope their
   *  resources to a single task lifecycle: the task pool boots one
   *  sandbox per `taskId` and stops it once the task terminates.
   *  Absent for chat sessions and ad-hoc agent loops. */
  taskId?: string | null;
  /** Parent session id (the user's main session that requested
   *  the worker). Lets the UI render worker sessions as children. */
  parentSessionId?: string | null;
  /** Three layered timeouts. 0 disables the layer. */
  timeouts?: {
    firstResponseMs?: number;
    idleMs?: number;
    maxRunMs?: number;
  };
  /** External abort signal. */
  signal?: AbortSignal;
  /**
   * Fires once, immediately after the worker session row has been
   * inserted into the host DB and before the first LLM call.
   *
   * Plugins use this to link a long-running task row to its
   * session id ASAP — without it, the workboard plugin would have
   * to wait until the run terminated to write back
   * `tasks.session_id`, which means the kanban Execution tab
   * couldn't tail an in-progress conversation.
   *
   * Errors thrown by the callback are caught + logged and do not
   * abort the run.
   */
  onSessionStart?: (sessionId: string) => void;
  /**
   * Resume a previous worker session instead of creating a fresh
   * one. The host opens the existing session row and the LLM sees
   * its prior transcript as context.
   *
   * Workboard uses this to retry a stalled task without losing the
   * transcript that explains *why* it stalled — the new run
   * picks up where the old one left off and (typically) just
   * needs to call task_complete to finish.
   *
   * If the id doesn't exist, the host falls back to creating a new
   * session and logs a warning rather than throwing.
   */
  resumeSessionId?: string;
  /**
   * Prompt to send when `resumeSessionId` is set. Defaults to a
   * generic nudge reminding the agent it didn't call task_complete
   * last time. Ignored when starting a fresh session.
   */
  resumePrompt?: string;
}

export interface AgentLoopRunnerResult {
  status: "done" | "stalled" | "aborted" | "error";
  summary: string;
  files: string[];
  sessionId: string;
  turns: number;
  reason:
    | "task_complete"
    | "no_completion"
    | "first_response_timeout"
    | "idle_timeout"
    | "max_run_timeout"
    | "aborted"
    | "stream_error"
    | "exception";
}

export interface AgentLoopRunner {
  run(req: AgentLoopRunnerRequest): Promise<AgentLoopRunnerResult>;
}
