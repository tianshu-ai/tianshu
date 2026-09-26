// Repair stale lane operation refs before AgentHarness.create().
//
// When a turn is interrupted (abort, crash, SIGTERM), the lane state
// in session_values may record a currentOperationId whose op.meta /
// op.state KV entries were never written. pi-agent-core's
// restoreLaneState treats this as a fatal SessionInvariantError →
// HarnessFault, permanently bricking the session.
//
// Fix: scan lane states and null out any currentOperationId that
// points to a missing op.meta. This is a runtime-state repair, not
// a history rewrite — the operation never completed, so clearing its
// ref is the correct recovery.

import type Database from "better-sqlite3";

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
        if (!metaRow) {
          console.warn(
            `[repair] stale operation ref session=${sessionId} lane=${row.key} operationId=${opId} (op.meta missing)`,
          );
          parsed.currentOperationId = null;
          db.prepare(
            `UPDATE session_values SET value = ?
             WHERE session_id = ? AND namespace = ? AND key = ?`,
          ).run(JSON.stringify(parsed), sessionId, "pi.lane.state", row.key);
          repaired++;
        }
      } catch {
        // Malformed JSON in lane state — skip, harness will handle it.
      }
    }
  } catch (err) {
    console.warn(`[repair] lane-state repair failed session=${sessionId}`, err);
  }
  return repaired;
}
