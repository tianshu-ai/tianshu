// Session inbox: persisted bus for messages addressed to a chat
// session, with a process-local fast path through any active
// harness.
//
// Public surface:
//   - enqueue(ctx, sessionId, message)
//       Persist + try-deliver. Always resolves; persistence
//       failure is logged + swallowed because the caller is
//       usually a worker pool that can't usefully retry.
//   - drainPending(ctx, sessionId)
//       Pop all pending messages for a session. Used by the chat
//       handler before prompt() to inject queued messages as a
//       system-note prefix.
//   - renderForPrompt(messages)
//       Format the drained rows into a single text block ready
//       to be prepended to the user's next prompt. Empty input
//       returns an empty string.
//
// Storage shape lives in migrations/007-session-inbox.ts.

import { randomUUID } from "node:crypto";
import type { TenantContext } from "../core/index.js";
import type {
  InboxMessage,
  InboxMessageKind,
} from "@tianshu-ai/plugin-sdk";
import { getActiveHarness } from "./active-harnesses.js";

/**
 * How long enqueue() waits before flushing accumulated pending
 * messages to a live harness as a single batched followUp.
 *
 * Why we debounce instead of forwarding immediately:
 *   When a chat agent kicks off N parallel tasks (typical:
 *   `task_create` with `tasks: [...]` of 4-6 entries), they tend
 *   to finish within seconds of each other. Each independent
 *   followUp() lands as a separate `user` message in the
 *   session, so the agent sees N independent prompts and answers
 *   each one in full — read_file, evaluate, summarise. Across 4
 *   tasks that's 4 turns of reactive narration before the user
 *   gets the floor back, which is the "messy" feeling Yu
 *   reported. Debouncing a short window lets the inbox bundle
 *   them into one followUp like "4 tasks done, here are the
 *   summaries", which the agent can ack in one turn.
 *
 * 1500ms is a guess: long enough to coalesce a parallel batch,
 * short enough that a single isolated done feels live. Tune later.
 */
const FLUSH_DEBOUNCE_MS = 1500;

/**
 * Per-session pending-flush timers. We never queue more than one
 * timer per session; if more inbox rows arrive while the timer
 * is armed, they're picked up by the eventual drainPending in
 * the timer body. The Map is module-scoped because the registry
 * of active harnesses is too — they share the same single-process
 * lifetime.
 */
const pendingFlushTimers = new Map<string, NodeJS.Timeout>();

/**
 * Sessions for which an idle background turn is currently in
 * flight. Used as a re-entrancy guard: if more inbox rows land
 * while the background turn is mid-LLM-call, we don't kick a
 * second turn — the running turn will see the new pending rows
 * via drainPending at the start of its prompt build.
 */
const idleTurnsInFlight = new Set<string>();

/**
 * Sessions for which a `flushSessionInbox` invocation is
 * currently running (covers both active-harness path and the
 * idle-runner path — they're alternatives, never concurrent for
 * the same session).
 *
 * Without this guard, two in-flight flushes for the same
 * session can each call `drainPendingTentative`, see the same
 * still-pending row (because tentative drain doesn't mark), and
 * each push it to the harness, producing duplicate inbox
 * messages in the chat. The lock means the second flush waits
 * for the first to complete, then runs its own drain on whatever
 * rows remain pending.
 */
const flushInFlight = new Set<string>();

/**
 * Runs an inbox-driven background turn on an idle session. Wired
 * by the host at startup via `bindIdleRunner` so this module
 * stays free of `runPrompt` import (avoids a cycle:
 * handler.ts → session-inbox.ts → handler.ts).
 *
 * Contract:
 *   - Resolves *only after* the LLM turn has fully finished
 *     (assistant message persisted, stream_end emitted).
 *   - Throws on infrastructure errors so flushSessionInbox can
 *     log them; LLM-internal errors (provider failure, etc.)
 *     should already be surfaced via `stream_error` events from
 *     the runner itself.
 */
export type IdleTurnRunner = (params: {
  sessionId: string;
  userId: string;
  promptText: string;
}) => Promise<void>;

let boundIdleRunner: IdleTurnRunner | null = null;

/**
 * Host calls this once at startup to wire in the runner. We
 * accept null to support test reset.
 */
export function bindIdleRunner(runner: IdleTurnRunner | null): void {
  boundIdleRunner = runner;
}

interface InboxRow {
  id: string;
  target_session_id: string;
  payload: string;
  status: string;
  created_at: number;
  delivered_at: number | null;
}

export interface DeliveredMessage {
  id: string;
  createdAt: number;
  message: InboxMessage;
}

/**
 * Persist `message` for `targetSessionId` and arm a debounced
 * flush to the live harness, if one is registered.
 *
 * We always write the DB row first so a process crash never
 * loses a message — the `pending` row will be flushed on the
 * next prompt regardless of what the live deliver does.
 *
 * The flush is debounced (FLUSH_DEBOUNCE_MS) and batched: when
 * a parallel batch of tasks finishes within the window, the
 * timer body drains ALL pending rows for the session and sends
 * them as a single combined followUp. This is the difference
 * between the agent seeing 4 separate "task done" prompts (and
 * answering each in full) vs. one "4 tasks done" prompt it can
 * acknowledge in one turn.
 */
export async function enqueue(
  ctx: TenantContext,
  targetSessionId: string,
  message: InboxMessage,
): Promise<string> {
  const id = `inbox_${randomUUID()}`;
  const now = Date.now();
  const payload = JSON.stringify(message);
  ctx.db
    .prepare(
      `INSERT INTO session_inbox
         (id, target_session_id, payload, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)`,
    )
    .run(id, targetSessionId, payload, now);

  // Always debounce-and-flush. The flush body picks the right
  // delivery mode based on session state at the time it runs:
  //   - active harness  → batched harness.followUp(...)
  //   - idle session    → background runPrompt() turn (so the
  //                       agent reacts even when the user isn't
  //                       sending anything)
  //   - re-entrant idle → skip; the in-flight turn will pick up
  //                       new pending rows itself.
  scheduleFlush(ctx, targetSessionId);
  return id;
}

/**
 * Schedule a debounced `flushSessionInbox` for `sessionId`. No-op
 * if a timer is already pending. Reused by both the public
 * enqueue path and the post-flush "more arrived while we were
 * working" follow-up.
 */
function scheduleFlush(ctx: TenantContext, sessionId: string): void {
  if (pendingFlushTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    pendingFlushTimers.delete(sessionId);
    void runFlushWithLock(ctx, sessionId);
  }, FLUSH_DEBOUNCE_MS);
  pendingFlushTimers.set(sessionId, timer);
}

/**
 * Wrap `flushSessionInbox` with the per-session lock. If a flush
 * is already running, just re-arm the timer so the next slot
 * picks up whatever is still pending.
 */
async function runFlushWithLock(
  ctx: TenantContext,
  sessionId: string,
): Promise<void> {
  if (flushInFlight.has(sessionId)) {
    scheduleFlush(ctx, sessionId);
    return;
  }
  flushInFlight.add(sessionId);
  try {
    await flushSessionInbox(ctx, sessionId, ownerUserId(ctx, sessionId));
  } finally {
    flushInFlight.delete(sessionId);
    // Pending arrivals during the flush — schedule another pass.
    if (countPending(ctx, sessionId) > 0) {
      scheduleFlush(ctx, sessionId);
    }
  }
}

/** Look up the owner of a session. Used by the idle path to
 *  attribute the background turn to the right user. */
function ownerUserId(ctx: TenantContext, sessionId: string): string | null {
  const row = ctx.db
    .prepare<[string], { user_id: string }>(
      `SELECT user_id FROM sessions WHERE id = ?`,
    )
    .get(sessionId);
  return row?.user_id ?? null;
}

/**
 * Drain pending inbox rows for `sessionId` and forward them as a
 * single batched `harness.followUp(...)` call.
 *
 * Race notes:
 *   - drainPending is its own SQLite transaction (select +
 *     update-to-delivered) so two concurrent flushes can't both
 *     claim the same row.
 *   - If the harness vanished between schedule and fire, we abort
 *     before draining — the rows stay pending and the next user
 *     prompt picks them up.
 *   - If `followUp` throws after we already marked rows
 *     delivered (in-band shutdown race), the rows are lost from
 *     the inbox surface. The user still sees the task statuses
 *     in the kanban, so this is a soft failure.
 */
async function flushSessionInbox(
  ctx: TenantContext,
  sessionId: string,
  userId: string | null,
): Promise<void> {
  // Active harness: try the cheap path — push the rendered batch
  // through `harness.followUp` so pi consumes it on the next
  // provider-turn boundary.
  //
  // CRITICAL: rows stay `pending` here. `harness.followUp(...)`
  // only enqueues the text; pi consumes it at the next turn
  // boundary. If the active turn errors out before that
  // (provider terminated, abort, network blip), the queued text
  // is silently dropped. Marking rows delivered prematurely
  // would lose them forever.
  //
  // The actual marker writeback happens in handler.ts's
  // bridgeHarnessEventToWs when a `user` message_end fires whose
  // content matches an inbox id — that's the only point at which
  // we know pi truly persisted the followUp into the session
  // transcript. See `markDeliveredFromMessage` below.
  //
  // If `followUp` itself throws (harness phase=idle, between
  // turns), we fall through to the idle-runner path so the rows
  // get processed by a fresh background turn.
  const harness = getActiveHarness(sessionId);
  if (harness) {
    const drained = drainPendingTentative(ctx, sessionId);
    if (drained.length === 0) return;
    try {
      await harness.followUp(renderForPrompt(drained));
      // No markDelivered here; see comment above.
      return;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[session-inbox] live followUp rejected for ${sessionId}, falling back to idle runner:`,
        err instanceof Error ? err.message : err,
      );
      // Fall through to the idle-runner path. Rows are still
      // pending (we never called markDelivered).
    }
  }

  // Idle session: kick a background turn so the agent reacts
  // without waiting for the user to type. Guards:
  //   - Need an idle runner (host wires it; tests can leave it
  //     null and the rows stay pending).
  //   - Need a userId (orphan session w/o user_id row → give up;
  //     pending rows will get flushed on next user prompt if
  //     anyone ever reconnects).
  //   - Need re-entrancy guard so a second enqueue mid-turn
  //     doesn't kick a second turn; the running turn sees its
  //     own new rows on the next drainPending.
  if (!boundIdleRunner) return;
  if (!userId) return;
  if (idleTurnsInFlight.has(sessionId)) return;

  const drained = drainPending(ctx, sessionId);
  if (drained.length === 0) return;
  const promptText = renderForPrompt(drained);

  idleTurnsInFlight.add(sessionId);
  try {
    await boundIdleRunner({ sessionId, userId, promptText });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[session-inbox] idle background turn failed for ${sessionId}:`,
      err instanceof Error ? err.message : err,
    );
  } finally {
    idleTurnsInFlight.delete(sessionId);
  }
  // The runFlushWithLock wrapper checks for newly-pending rows
  // after we return and schedules another pass; nothing to do
  // here.
}

function countPending(ctx: TenantContext, sessionId: string): number {
  const row = ctx.db
    .prepare<[string], { n: number }>(
      `SELECT count(*) AS n FROM session_inbox
       WHERE target_session_id = ? AND status = 'pending'`,
    )
    .get(sessionId);
  return row?.n ?? 0;
}

/**
 * Atomically pop all pending messages for a session, oldest
 * first, marking them as delivered.
 *
 * Used by the prompt path (handler.ts) where the rendered text
 * is appended verbatim to the user's message and the agent sees
 * it for sure. The active-harness flush path uses
 * `drainPendingTentative` + `markDelivered` instead so a failed
 * `harness.followUp` doesn't lose the rows.
 */
export function drainPending(
  ctx: TenantContext,
  sessionId: string,
): DeliveredMessage[] {
  const txn = ctx.db.transaction(() => {
    const rows = ctx.db
      .prepare<[string], InboxRow>(
        `SELECT * FROM session_inbox
         WHERE target_session_id = ? AND status = 'pending'
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(sessionId);
    if (rows.length === 0) return [];
    const now = Date.now();
    const update = ctx.db.prepare(
      `UPDATE session_inbox SET status = 'delivered', delivered_at = ? WHERE id = ?`,
    );
    for (const r of rows) update.run(now, r.id);
    return rows;
  });
  const rows = txn();
  return rows.map(rowToDelivered);
}

/**
 * Read pending rows WITHOUT marking them delivered. Caller is
 * responsible for `markDelivered(ids)` after the side-effect
 * (e.g. `harness.followUp`) is confirmed to have succeeded.
 *
 * If the side-effect throws and we never call markDelivered, the
 * next flush picks the rows up again — nothing is lost.
 *
 * The previous implementation drained-and-marked atomically,
 * which lost rows when followUp succeeded but the surrounding
 * turn never actually emitted the user message (T4 reproducer
 * 2026-06-12: row marked delivered, content never reached the
 * agent). With tentative + confirm, the worst case is a row
 * delivered twice; that's vastly preferable to silent loss.
 */
export function drainPendingTentative(
  ctx: TenantContext,
  sessionId: string,
): DeliveredMessage[] {
  const rows = ctx.db
    .prepare<[string], InboxRow>(
      `SELECT * FROM session_inbox
       WHERE target_session_id = ? AND status = 'pending'
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(sessionId);
  return rows.map(rowToDelivered);
}

/**
 * Scan a freshly-persisted user message text for inbox markers
 * and mark each matched row delivered. Called by the handler
 * when pi emits message_end for a `user` role row — that's the
 * one event that proves pi has actually consumed a followUp.
 *
 * Markers are emitted by `renderForPrompt` as
 *   <inbox kind="..." id="inbox_...">
 */
export function markDeliveredFromMessage(
  ctx: TenantContext,
  text: string,
): void {
  if (!text.includes("<inbox kind=")) return;
  const ids: string[] = [];
  // The text we get here is whatever the handler reads back from
  // the `messages.content` column. For chat-handler callsite that
  // column stores `JSON.stringify(AgentMessage)`, so the literal
  // bytes are JSON-escaped: <inbox kind=\"task_done\" id=\"inbox_x\">.
  // For tool-result / tenant-config paths the same function gets
  // called with raw markdown, where the bytes are exactly
  // <inbox kind="task_done" id="inbox_x">. Match BOTH forms so the
  // bug-of-the-day in 2026-06-28 (inbox notification repeating 8
  // times because regex only matched raw) cannot recur.
  //
  // Compiled pattern explained:
  //   <inbox\s+kind=\\?"[^"\\]*\\?"\s+id=\\?"(inbox_[^"\\]+)\\?"
  //   ^                ^^^^                ^^^^         ^^^^
  //   literal          optional escape     optional escape
  //   tag              before quote        before quote
  // [^"\\]+ excludes both the quote char and the backslash so we
  // stop at the right boundary regardless of escape level.
  const re =
    /<inbox\s+kind=\\?"[^"\\]*\\?"\s+id=\\?"(inbox_[^"\\]+)\\?"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    ids.push(m[1]);
  }
  if (ids.length > 0) markDelivered(ctx, ids);
}

/**
 * Mark the given rows delivered. Idempotent: re-marking a row
 * already delivered is a no-op (the WHERE clause filters by
 * status='pending').
 */
export function markDelivered(
  ctx: TenantContext,
  ids: string[],
): void {
  if (ids.length === 0) return;
  const now = Date.now();
  const update = ctx.db.prepare(
    `UPDATE session_inbox
     SET status = 'delivered', delivered_at = ?
     WHERE id = ? AND status = 'pending'`,
  );
  const txn = ctx.db.transaction(() => {
    for (const id of ids) update.run(now, id);
  });
  txn();
}

function rowToDelivered(row: InboxRow): DeliveredMessage {
  let parsed: InboxMessage;
  try {
    parsed = JSON.parse(row.payload) as InboxMessage;
  } catch {
    parsed = { kind: "system_note", text: row.payload };
  }
  return { id: row.id, createdAt: row.created_at, message: parsed };
}

/**
 * Render a list of drained messages into a single text block
 * suitable for prepending to the user's next prompt.
 *
 * Empty input ⇒ empty string (callers can `${rendered}${userText}`
 * unconditionally).
 *
 * Format intentionally uses XML-ish tags so the LLM can tell
 * "messages addressed to me while I was idle" apart from the
 * user's own input. The tags carry the kind so the agent has a
 * hint about what to do:
 *   - `task_done` is informational; brief acknowledge.
 *   - `task_intervention_required` (post-008) means a worker
 *     hit a failure / timeout and the orchestrator NEEDS the
 *     main agent to pick: task_continue, task_retry_fresh,
 *     task_extend_timeout, or task_abort. Don't just
 *     acknowledge — act.
 *   - `task_stalled` is the legacy spelling of the above.
 */
export function renderForPrompt(messages: DeliveredMessage[]): string {
  if (messages.length === 0) return "";
  const blocks = messages.map((m) => {
    return `<inbox kind="${m.message.kind}" id="${m.id}">\n${m.message.text}\n</inbox>`;
  });
  // Framing: tell the agent these are notifications, not user
  // requests. The earlier wording ("Acknowledge them as
  // appropriate") had the agent diving into per-task analysis
  // — reading the result file, evaluating quality — which is
  // useful when the user asks for it but very noisy when 4
  // parallel tasks finish in a row.
  //
  // The new wording: brief acknowledge, then yield. The agent
  // still has the kanban + task_get_history if it wants to dig.
  // Note for the LLM: split guidance by kind so an
  // intervention_required block prompts a decision while a
  // task_done block stays informational.
  const hasIntervention = messages.some(
    (m) =>
      m.message.kind === "task_intervention_required" ||
      m.message.kind === "task_stalled",
  );
  const guidance = hasIntervention
    ? `${messages.length} background notification${messages.length === 1 ? "" : "s"} arrived. At least one is a task_intervention_required: read its meta + the task's history if useful, then call ONE of task_continue / task_retry_fresh / task_extend_timeout / task_abort to keep the work moving. For task_done blocks, brief acknowledge is enough.`
    : `${messages.length} background notification${messages.length === 1 ? "" : "s"} arrived while you were idle. Briefly acknowledge them in one short message (one line per notification is enough) and stop \u2014 do NOT investigate, evaluate, or take new action unless the user explicitly asks.`;
  return [
    "<system-note>",
    guidance,
    "",
    ...blocks,
    "</system-note>",
    "",
  ].join("\n");
}



/** Test-only convenience: surface kinds for assertions. */
export const KNOWN_KINDS: readonly InboxMessageKind[] = [
  "task_done",
  "task_intervention_required",
  "task_stalled",
  "system_note",
];
