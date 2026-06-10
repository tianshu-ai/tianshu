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
  /** Allow-list of skill names; same semantics. */
  skillsAllow?: string[] | null;
  /** Friendly title for the worker session row. */
  sessionTitle?: string | null;
  /** Worker role. Use the kind id (e.g. \"llm\") when called from a
   *  worker pool. */
  workerRole?: string | null;
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
}

export interface AgentLoopRunnerResult {
  status: "done" | "stalled" | "aborted" | "error";
  summary: string;
  files: string[];
  sessionId: string;
  turns: number;
  reason:
    | "task_complete"
    | "max_turns"
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
