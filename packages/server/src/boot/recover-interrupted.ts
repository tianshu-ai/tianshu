// Startup recovery: scan recently-active sessions for interrupted
// agent turns and resume them via session inbox.
//
// Three interrupt patterns:
//   1. Dangling user message — user's prompt persisted, agent never
//      completed a reply.
//   2. Dangling tool result / assistant with pending toolCalls —
//      agent was mid-turn when killed.
//   3. Zombie lane operation — lane state has a currentOperationId
//      that will never complete.
//
// For all cases we enqueue a system_note into the session inbox.
// The idle-runner picks it up and fires a background runPrompt turn,
// invisible to the user (no user-visible message bubble).

import { enqueue } from "../chat/session-inbox.js";
import type { GlobalOps } from "../core/global-ops.js";

export interface RecoverDeps {
  globalOps: GlobalOps;
}

interface InterruptedSession {
  tenantId: string;
  sessionId: string;
  kind: "dangling_user" | "dangling_tool" | "zombie_op";
}

function assistantRowFailed(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { stopReason?: string };
    return parsed.stopReason === "error" || parsed.stopReason === "aborted";
  } catch {
    return false;
  }
}

function assistantHasPendingToolCalls(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as {
      content?: Array<{ type?: string }>;
    };
    if (!Array.isArray(parsed.content)) return false;
    return parsed.content.some((b) => b.type === "toolCall");
  } catch {
    return false;
  }
}

function getInterruptKind(
  db: import("better-sqlite3").Database,
  sessionId: string,
): "dangling_user" | "dangling_tool" | "zombie_op" | null {
  const rows = db
    .prepare<
      [string],
      { role: string; content: string }
    >(
      `SELECT role, content
         FROM messages
        WHERE session_id = ? AND entry_type IN ('message', 'fork_tail')
        ORDER BY created_at DESC, rowid DESC
        LIMIT 10`,
    )
    .all(sessionId);

  if (rows.length > 0) {
    const newest = rows[0];
    if (newest.role === "tool") return "dangling_tool";
    if (newest.role === "user") return "dangling_user";
    if (newest.role === "assistant") {
      if (newest.content.trim().length === 0) return "dangling_user";
      if (assistantRowFailed(newest.content)) return "dangling_user";
      if (assistantHasPendingToolCalls(newest.content)) return "dangling_tool";
    }
  }

  const laneRows = db
    .prepare<[string, string], { value: string }>(
      `SELECT value FROM session_values
       WHERE session_id = ? AND namespace = ?`,
    )
    .all(sessionId, "pi.lane.state");

  for (const row of laneRows) {
    try {
      const parsed = JSON.parse(row.value);
      if (parsed.currentOperationId) return "zombie_op";
    } catch { /* skip */ }
  }

  return null;
}

function findInterruptedSessions(globalOps: GlobalOps): InterruptedSession[] {
  const results: InterruptedSession[] = [];
  const recentCutoff = Date.now() - 60 * 60 * 1000;

  for (const tenantId of globalOps.list()) {
    const ctx = globalOps.open(tenantId);
    const sessions = ctx.db
      .prepare<[number], { id: string }>(
        `SELECT DISTINCT s.id
         FROM sessions s
         JOIN messages m ON m.session_id = s.id
         WHERE s.status IN ('active', 'compacted')
           AND s.kind = 'user'
           AND m.created_at > ?`,
      )
      .all(recentCutoff);

    for (const session of sessions) {
      const kind = getInterruptKind(ctx.db, session.id);
      if (kind) {
        results.push({ tenantId, sessionId: session.id, kind });
      }
    }
  }
  return results;
}

/** Call once at boot. */
export function recoverInterruptedTurns(deps: RecoverDeps): void {
  const { globalOps } = deps;

  const interrupted = findInterruptedSessions(globalOps);
  if (interrupted.length === 0) return;

  console.info(
    `[recover] found ${interrupted.length} interrupted session(s), resuming via inbox...`,
  );

  for (const entry of interrupted) {
    const { tenantId, sessionId, kind } = entry;
    const ctx = globalOps.open(tenantId);

    // Clean up the last broken message before recovery.
    // Delete orphaned tool results and assistant messages with
    // pending tool calls that will never complete.
    try {
      const last = ctx.db
        .prepare<[string], { id: string; role: string; content: string }>(
          `SELECT id, role, content FROM messages
           WHERE session_id = ? AND entry_type IN ('message', 'fork_tail')
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(sessionId);
      if (last) {
        console.info(`[recover] last message: role=${last.role} id=${last.id} content=${last.content.slice(0, 200)} session=${sessionId}`);
        let shouldDelete = false;
        if (last.role === "tool") {
          shouldDelete = true;
        } else if (last.role === "assistant") {
          try {
            const parsed = JSON.parse(last.content);
            const blocks = Array.isArray(parsed.content) ? parsed.content : [];
            const hasToolCall = blocks.some((b: any) => b.type === "toolCall" || b.type === "tool_use");
            console.info(`[recover] assistant blocks=${blocks.length} hasToolCall=${hasToolCall}`);
            shouldDelete = hasToolCall;
          } catch (e) {
            console.info(`[recover] assistant content parse failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (shouldDelete) {
          ctx.db.prepare(`DELETE FROM messages WHERE id = ?`).run(last.id);
          console.info(`[recover] deleted broken ${last.role} message id=${last.id} session=${sessionId}`);
        } else {
          console.info(`[recover] last message not broken, skipping cleanup`);
        }
      }
    } catch { /* best effort */ }

    const text =
      kind === "dangling_user"
        ? "The server was restarted while processing your last message. Re-process the user's message and respond — do NOT ask the user to retry, do NOT mention the restart, just seamlessly handle their request as if nothing happened."
        : "The server was restarted while the agent was mid-turn. Continue EXACTLY where you left off — do NOT ask the user whether to continue, do NOT summarize what happened, just seamlessly resume the task as if nothing happened.";

    enqueue(ctx, sessionId, { kind: "system_note", text, meta: { internal: true } }).catch((err) => {
      console.error(
        `[recover] failed to enqueue for ${tenantId}/${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

    console.info(`[recover] enqueued ${kind} resume for ${tenantId}/${sessionId}`);
  }
}
