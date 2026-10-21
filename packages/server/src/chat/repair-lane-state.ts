// Repair stale lane operation refs before AgentHarness.create().
//
// When a turn is interrupted (abort, crash, SIGTERM), the lane state
// in session_values may record a currentOperationId whose op.meta /
// op.state KV entries were never written or whose operation was
// mid-flight (tool call running, result never received).
//
// pi-agent-core's restoreLaneState treats a missing op.meta as a
// fatal SessionInvariantError → HarnessFault. A zombie operation
// (meta exists, but tool result never arrived) causes the harness
// to silently stall — the lane waits for a tool result that will
// never come, so the agent produces no reply.
//
// Fix: scan lane states and null out currentOperationId when:
//   1. op.meta is missing (original case), OR
//   2. op.state shows the operation is still mid-flight (the tool
//      was interrupted and will never complete)
//
// This is a runtime-state repair, not a history rewrite — the
// operation never completed, so clearing its ref is the correct
// recovery.

import type Database from "better-sqlite3";

import { createLogger } from "../setup/logger.js";

const log = createLogger("repair-lane-state");


/** Check if an operation looks like it was interrupted mid-flight. */
function isZombieOperation(
  db: Database.Database,
  sessionId: string,
  opId: string,
): boolean {
  // Check op.state — if it exists and indicates in-progress, it's a zombie.
  const stateRow = db
    .prepare<[string, string, string], { value: string }>(
      `SELECT value FROM session_values
       WHERE session_id = ? AND namespace = ? AND key = ?`,
    )
    .get(sessionId, "pi.op.state", opId);
  if (stateRow) {
    try {
      const state = JSON.parse(stateRow.value);
      // pi-agent-core operation states: if the operation has pending
      // tool calls (toolCalls array with entries that haven't been
      // resolved), or if status is not 'completed'/'failed', it's
      // a zombie.
      if (state.status && state.status !== "completed" && state.status !== "failed") {
        return true;
      }
      // Check for pending tool calls in the operation
      if (Array.isArray(state.toolCalls)) {
        const hasPending = state.toolCalls.some(
          (tc: Record<string, unknown>) => !tc.result && !tc.error,
        );
        if (hasPending) return true;
      }
    } catch { /* malformed state — treat as zombie */ return true; }
  }
  return false;
}

export function repairStaleLaneOperations(
  db: Database.Database,
  sessionId: string,
): number {
  let repaired = 0;
  try {
    const laneRows = db
      .prepare<[string, string], { key: string; value: string }>(
        `SELECT key, value FROM session_values
         WHERE session_id = ? AND namespace = ?`,
      )
      .all(sessionId, "pi.lane.state");
    for (const row of laneRows) {
      try {
        const parsed = JSON.parse(row.value);
        const opId = parsed.currentOperationId;
        if (!opId) continue;

        const metaRow = db
          .prepare<[string, string, string], { value: string }>(
            `SELECT value FROM session_values
             WHERE session_id = ? AND namespace = ? AND key = ?`,
          )
          .get(sessionId, "pi.op.meta", opId);

        let reason = "";
        if (!metaRow) {
          reason = "op.meta missing";
        } else if (isZombieOperation(db, sessionId, opId)) {
          reason = "zombie operation (interrupted mid-flight)";
        }

        if (reason) {
          log.warn(
            `[repair] stale operation ref session=${sessionId} lane=${row.key} operationId=${opId} (${reason})`,
          );
          parsed.currentOperationId = null;
          db.prepare(
            `UPDATE session_values SET value = ?
             WHERE session_id = ? AND namespace = ? AND key = ?`,
          ).run(JSON.stringify(parsed), sessionId, "pi.lane.state", row.key);

          // Also clean up the zombie operation's state and meta
          // to prevent confusion on subsequent turns.
          db.prepare(
            `DELETE FROM session_values
             WHERE session_id = ? AND namespace IN ('pi.op.meta', 'pi.op.state') AND key = ?`,
          ).run(sessionId, opId);

          repaired++;
        }
      } catch {
        // Malformed JSON in lane state — skip, harness will handle it.
      }
    }
  } catch (err) {
    log.warn(`lane-state repair failed session=${sessionId}`, err);
  }
  return repaired;
}
