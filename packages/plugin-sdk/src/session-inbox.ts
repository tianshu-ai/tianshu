// Capability-side type for `host.sessionInbox`.
//
// The host registers an implementation; plugins fetch it through
// `ctx.capabilities.get<SessionInboxCapability>("host.sessionInbox")`.
//
// Why this lives in the SDK and not in @tianshu/server:
//   plugins shouldn't take a server-package dep just to enqueue an
//   inbox message. Mirror the shape here, document the contract,
//   and let the host implementation match it structurally. Same
//   pattern as `AgentLoopRunner`.

/** Kinds of inbox messages the host knows how to render.
 *
 *  - `task_done` — worker called task_complete cleanly.
 *  - `task_intervention_required` (008+) — worker run failed,
 *    timed out, or hit watchdog; main agent decides next step
 *    (continue / retry_fresh / extend_timeout / abort).
 *  - `task_stalled` — legacy alias kept for forward compat with
 *    pre-008 senders. Host renderer treats it identically to
 *    `task_intervention_required`.
 *  - `system_note` — generic kernel/admin note.
 */
export type InboxMessageKind =
  | "task_done"
  | "task_intervention_required"
  | "task_stalled"
  | "system_note"
  /**
   * Recovery agent telling the broken session what happened and
   * what to do next. Distinct from generic system_note so the
   * chat UI / main agent can render it differently ("⚠️ recovery
   * note" vs a plain background notification).
   */
  | "inbox_recovery_note";

export interface InboxMessage {
  /**
   * Symbolic kind drives the rendered prefix the agent sees, e.g.
   * "[Task done] T1 — summary…". Unknown kinds fall back to plain
   * `system_note`.
   */
  kind: InboxMessageKind;
  /**
   * Free-form text. Rendered verbatim under the kind-specific
   * prefix. Plain UTF-8; markdown is fine, the agent's renderer
   * will pick it up.
   */
  text: string;
  /**
   * Optional structured metadata the host stores alongside the
   * message. Not surfaced to the agent — debugging only.
   */
  meta?: Record<string, unknown>;
}

export interface SessionInboxCapability {
  /**
   * Enqueue a message for the given session.
   *
   * Behaviour:
   *   - If the target session has an active harness instance in
   *     this host process, the message is forwarded via
   *     `harness.followUp(...)` so the running agent picks it up
   *     mid-turn (or at the next turn if it's between provider
   *     calls). The DB row is marked delivered.
   *   - Otherwise the message persists with status='pending';
   *     the next user-driven prompt on that session flushes it
   *     as a system-note prefix before passing the user text
   *     to the LLM.
   *
   * Errors thrown from this method MUST NOT bubble into the
   * caller's tool execution path — implementations log and
   * swallow. A failing inbox is a degraded mode, not a fatal one.
   *
   * Returns the inbox row id so callers can correlate later
   * delivery events to their origin tool call.
   */
  enqueue(targetSessionId: string, message: InboxMessage): Promise<string>;
}
