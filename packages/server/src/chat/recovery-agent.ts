// Session-recovery agent.
//
// When a chat session's main agent loop throws (compact failure,
// provider error, harness crash, etc.) the handler currently sends
// a `stream_error` to the UI and stops. The user is left looking at
// a half-rendered turn with no idea what happened, no way to
// recover except typing a fresh prompt — which the broken session
// may still reject.
//
// This module spawns a recovery agent in an isolated session,
// gives it diagnostic + nudge tools, and lets it figure out what
// went wrong and ping the original session back to life.
//
// Design notes:
//   - Recovery runs in an ISOLATED session (worker kind), not
//     piggy-backing on the broken one. We don't want a broken
//     session's transcript to influence the recovery agent, and we
//     don't want recovery turns to clutter the user-visible
//     transcript.
//   - One concurrent recovery per session. If a recovery is in
//     flight and another error fires, we drop the second trigger
//     (the recovery already has the chance to see both errors via
//     its inspect tool). Prevents stuck->recover->stuck loops.
//   - Recovery agent uses the host's `runAgentLoop` so it gets the
//     same model + tool plumbing as a regular worker. We pass a
//     dedicated system prompt and a minimal tool allow-list:
//     diagnostic + nudge_session + run_doctor + shell_exec.
//     Everything else (workboard tasks, plugin install, etc.) is
//     denied — recovery should be focused.
//   - The agent's only "external" effect is calling nudge_session,
//     which appends a system note to the original chat session's
//     inbox. The user's main session picks it up on the next turn.
//     If the agent never nudges, the recovery just exits and the
//     user can keep typing themselves.

import { runAgentLoop } from "./agent-loop.js";
import type { ChatSession } from "./messages.js";
import type { TenantContext } from "../core/tenant-context.js";
import type { PluginRegistry } from "../core/plugins/registry.js";

// Recovery-agent logging goes to console.\* directly rather than
// through a tenant-scoped logger because TenantContext doesn't
// expose one and we want recovery output to land in the same
// dev-server stderr stream the rest of the chat handler logs to.

/** Per-tenant set of session ids that already have a recovery
 *  agent running. Module-local; the host wires one recovery per
 *  agent loop runner, but the in-flight map lives here so the
 *  dedupe is global across whatever spawned the trigger. */
const inFlight = new Set<string>();

/** Cap how long a recovery agent can run before we abort it.
 *  Recovery should be a sprint, not a marathon — 5 minutes is
 *  enough to diagnose + nudge, and short enough that a stuck
 *  recovery doesn't pin model quota or worker capacity. */
const RECOVERY_MAX_RUN_MS = 5 * 60_000;

export interface RecoveryTrigger {
  /** Why the main agent loop failed. Free-form short string,
   *  surfaced verbatim to the recovery agent. Examples:
   *    - "harness threw: ECONNRESET"
   *    - "compact failed: token limit exceeded"
   *    - "watchdog: idle 60s with outstanding tool call X"
   */
  reason: string;
  /** The error message proper, if any. Surface separately from
   *  `reason` so the recovery agent can grep it / quote it back. */
  errorMessage?: string;
  /** Tool calls that were still in-flight when the error fired.
   *  Recovery may try to drain / abort them before nudging. */
  outstandingToolCalls?: { id: string; name: string }[];
  /** Optional last assistant row id so the recovery agent can
   *  fetch the partial assistant content if needed. */
  lastAssistantRowId?: string;
}

export interface SpawnRecoveryOpts {
  ctx: TenantContext;
  userId: string;
  brokenSession: ChatSession;
  trigger: RecoveryTrigger;
  pluginRegistry: PluginRegistry;
  /** Override the recovery agent's model. Defaults to the same
   *  model the broken session was using \u2014 if the broken session
   *  failed because of a model-side issue, the operator can
   *  configure a fallback via tenant config. */
  modelId?: string;
  /** Hook fired after the recovery agent's run resolves. Lets
   *  tests assert outcomes without scraping logs. */
  onComplete?: (result: { ok: boolean; reason?: string }) => void;
}

/**
 * Spawn a recovery agent for the given broken session.
 *
 * Returns immediately. The recovery agent runs as a fire-and-
 * forget background task; its progress is captured in its own
 * isolated session (queryable via the standard session APIs)
 * and its only observable effect on the broken session is the
 * inbox notes it may post via `nudge_session`.
 *
 * If a recovery is already in flight for this session, the call
 * is a no-op \u2014 we don't queue retries.
 */
export function spawnSessionRecovery(opts: SpawnRecoveryOpts): void {
  const { brokenSession } = opts;
  if (inFlight.has(brokenSession.id)) {
    // Already running. Don't pile up.
    // eslint-disable-next-line no-console
    console.info(
      `[recovery] skip duplicate spawn for session=${brokenSession.id}`,
    );
    return;
  }
  inFlight.add(brokenSession.id);

  void (async () => {
    try {
      await runRecoveryLoop(opts);
      opts.onComplete?.({ ok: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[recovery] agent for session=${brokenSession.id} threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      opts.onComplete?.({
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inFlight.delete(brokenSession.id);
    }
  })();
}

async function runRecoveryLoop(opts: SpawnRecoveryOpts): Promise<void> {
  const { ctx, userId, brokenSession, trigger, pluginRegistry, modelId } = opts;

  const initialPrompt = buildInitialPrompt(brokenSession, trigger);
  const systemPrompt = RECOVERY_SYSTEM_PROMPT;

  // eslint-disable-next-line no-console
  console.info(
    `[recovery] spawning agent for session=${brokenSession.id} reason="${trigger.reason}"`,
  );

  const result = await runAgentLoop({
    ctx,
    userId,
    initialUserMessage: initialPrompt,
    systemPrompt,
    modelId,
    // Recovery-only tools. Everything else is denied so the agent
    // can't accidentally do something destructive (creating tasks,
    // installing plugins, mutating tenant config, etc.). The
    // diagnose + nudge surface lives in the recovery toolset
    // (recovery-tools.ts).
    toolsAllow: [
      "inspect_session",
      "read_session_log",
      "nudge_session",
      "run_doctor",
      "shell_exec",
    ],
    toolsDeny: null,
    skillsAllow: [],
    sessionTitle: `recovery for ${brokenSession.id}`,
    workerRole: "recovery",
    workerSlug: "recovery",
    parentSessionId: brokenSession.id,
    // No taskId / projectSlug / taskTitle \u2014 recovery isn't a
    // workboard task and shouldn't stage files under any project.
    timeouts: {
      // Per-call (single LLM round) idle watchdog: 60s. If the
      // recovery agent itself stalls, we'd rather kill it than
      // recover the recovery.
      idleMs: 60_000,
      firstResponseMs: 60_000,
      maxRunMs: RECOVERY_MAX_RUN_MS,
    },
    pluginRegistry,
    homeDir: ctx.userHomeDir(userId),
  });

  // eslint-disable-next-line no-console
  console.info(
    `[recovery] agent for session=${brokenSession.id} finished status=${result.status} reason=${result.reason ?? "-"}`,
  );
}

function buildInitialPrompt(
  brokenSession: ChatSession,
  trigger: RecoveryTrigger,
): string {
  // The recovery agent's initial user message. We hand it the
  // broken session id, the failure reason, and the structural hints
  // it needs to start diagnosing without us pre-judging the cause.
  const outstanding = (trigger.outstandingToolCalls ?? [])
    .map((c) => `  - ${c.name} (call id ${c.id})`)
    .join("\n");
  const lines: string[] = [
    `A chat session needs recovery. Diagnose what went wrong, decide whether to nudge the session, and nudge it (or explain why you didn't) before exiting.`,
    ``,
    `## Broken session`,
    `- id: ${brokenSession.id}`,
    `- userId: ${brokenSession.userId}`,
    `- title: ${brokenSession.title ?? "(untitled)"}`,
    ``,
    `## Failure`,
    `- reason: ${trigger.reason}`,
  ];
  if (trigger.errorMessage) {
    lines.push(`- error: ${trigger.errorMessage}`);
  }
  if (outstanding) {
    lines.push(``, `## Outstanding tool calls when the loop died`);
    lines.push(outstanding);
  }
  if (trigger.lastAssistantRowId) {
    lines.push(``, `## Last assistant row`);
    lines.push(`- id: ${trigger.lastAssistantRowId}`);
  }
  lines.push(
    ``,
    `## What to do`,
    `1. Call \`inspect_session\` on the broken session id to see its recent activity, pending tool calls, and any stream_error rows.`,
    `2. If the error is opaque, call \`read_session_log\` to grep the dev-server log around the failure time.`,
    `3. If a host-side thing is obviously broken (Docker down, openshell missing, model 401), use \`run_doctor\` to confirm and \`shell_exec\` to fix \u2014 same rules as the setup agent (confirm before mutating, one command per call).`,
    `4. Once you understand the root cause, call \`nudge_session\` to post a system note to the broken session. Make it short and actionable: tell the user what failed, what (if anything) you fixed, and what they should do next ("type 'retry' to continue", "restart the gateway", etc.).`,
    `5. If the failure is unrecoverable from your side (provider outage, OOM, ambiguous corruption), nudge with a brief honest note saying you couldn't auto-fix and the user should investigate themselves.`,
    `6. When you've nudged once, you're done. Don't try multiple nudges \u2014 the user (or the main agent) sees the first one and takes it from there.`,
  );
  return lines.join("\n");
}

const RECOVERY_SYSTEM_PROMPT = `\
You are a session-recovery agent for the Tianshu chat system. A
chat session's main agent loop just failed mid-turn (compact crash,
provider error, harness exception, watchdog timeout, etc.). Your
job is to:

  1. Diagnose what went wrong using the diagnostic tools available.
  2. Optionally repair the underlying problem if it's a host-side
     issue you can act on (e.g. Docker daemon not running,
     openshell binary missing, model API key expired).
  3. Post ONE short, actionable system note back to the broken
     session via \`nudge_session\`, then exit.

You have FIVE tools:

- \`inspect_session(sessionId)\` \u2014 read-only. Returns the broken
  session's recent messages, any pending tool calls, recent
  stream_error events, and the last assistant row.

- \`read_session_log(sessionId, opts?)\` \u2014 read-only. Grep
  the dev-server log for lines related to this session in the last
  N minutes. Use this when inspect_session alone doesn't tell you
  what crashed (stack traces live in the server log, not the
  session transcript).

- \`run_doctor()\` \u2014 read-only. Runs the standard tianshu doctor
  health check. Use this when you suspect a host-side problem
  (Docker down, plugin prerequisites missing, etc.). Same tool as
  the setup agent.

- \`shell_exec({command, purpose, ...})\` \u2014 MUTATING. Every call
  requires user confirmation. Use the same discipline as the setup
  agent: one command per call, narrate purpose clearly, never
  destructive without an explicit go-ahead, refuse \`sudo rm -rf\`
  -style commands.

- \`nudge_session(sessionId, text)\` \u2014 MUTATING. Posts a system
  note to the broken session's inbox. The user (or their main
  agent) sees it on the next turn. Use this as your ONE
  observable side-effect: one nudge per recovery, focused and
  actionable.

Rules:

- Stay focused. You are NOT a general assistant. Don't research
  the codebase, don't propose refactors, don't speculate about
  product direction. Diagnose, fix what's fixable, nudge, exit.

- Be concise in the nudge. The user is in a chat session that just
  broke; they want to know "what failed" + "what to do next" in
  two or three short sentences. Don't dump stack traces \u2014
  reference the log/inspect tools the main agent can run if it
  wants details.

- Don't loop. If your first nudge fails (tool error, session
  missing), don't retry; just exit. The user (or another recovery
  trigger) will retry by other means.

- Don't escalate to ANOTHER recovery. You're the recovery; if you
  can't fix it, the user will. Never try to spawn another recovery
  agent or queue work for the workboard from here.

- Mutation discipline: shell_exec and nudge_session are confirmed
  per-call by the host. Treat the confirms as a feature, not an
  obstacle \u2014 they let the user veto an unsafe action.

Exit cleanly once you've nudged (success) or once you've concluded
you can't help (also a kind of success \u2014 inform the user, exit).
`;
