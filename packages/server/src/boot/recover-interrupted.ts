// Startup recovery: scan all sessions for interrupted agent turns and
// resume them automatically. Runs once at boot, after the server is
// ready to accept connections.
//
// Two interrupt patterns:
//   1. Dangling user message — the user's prompt was persisted but
//      the agent never completed a reply (crash/restart mid-stream).
//   2. Zombie lane operation — the agent was mid-tool-call (lane
//      state has a currentOperationId that will never complete).
//
// For both cases we fire a background runPrompt. The idle-runner's
// broadcastToUser / channelHub delivery paths push output to
// connected clients (or queue it for reconnect).

import { runPrompt } from "../chat/handler.js";
import { broadcastToUser } from "../chat/active-harnesses.js";
import { findSessionById } from "../chat/messages.js";
import type { GlobalOps } from "../core/global-ops.js";
import type { PluginRegistry } from "../core/plugins/registry.js";
import type { ServerMsg } from "../chat/ws-protocol.js";

export interface RecoverDeps {
  globalOps: GlobalOps;
  pluginRegistry: PluginRegistry;
}

interface InterruptedSession {
  tenantId: string;
  sessionId: string;
  userId: string;
  kind: "dangling_user" | "dangling_tool" | "zombie_op";
  lastModelId: string | null;
}

/** True if a persisted assistant row's JSON has a failure stopReason. */
function assistantRowFailed(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { stopReason?: string };
    return parsed.stopReason === "error" || parsed.stopReason === "aborted";
  } catch {
    return false;
  }
}

/** True if the assistant message contains pending tool calls (agent
 *  loop was mid-flight and expected to continue after tool results). */
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

/**
 * Scan all tenants for sessions with interrupted turns.
 */
function findInterruptedSessions(globalOps: GlobalOps): InterruptedSession[] {
  const results: InterruptedSession[] = [];

  for (const tenantId of globalOps.list()) {
    const ctx = globalOps.open(tenantId);

    // Only scan sessions that were recently active (message within
    // the last hour). A server restart that interrupted a turn
    // will always have recent messages in the affected session.
    const recentCutoff = Date.now() - 60 * 60 * 1000;
    const sessions = ctx.db
      .prepare<
        [number],
        {
          id: string;
          user_id: string;
          last_model_id: string | null;
        }
      >(
        `SELECT DISTINCT s.id, s.user_id, s.last_model_id
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
        results.push({
          tenantId,
          sessionId: session.id,
          userId: session.user_id,
          kind,
          lastModelId: session.last_model_id,
        });
      }
    }
  }

  return results;
}

function getInterruptKind(
  db: import("better-sqlite3").Database,
  sessionId: string,
): "dangling_user" | "dangling_tool" | "zombie_op" | null {
  // Grab the tail of the conversation (newest first)
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

    // Case 1: last message is a tool result with no subsequent
    // assistant reply — agent got the tool result but was killed
    // before generating the next response.
    if (newest.role === "tool") return "dangling_tool";

    // Case 2: last message is a user prompt with no assistant reply,
    // or an empty/failed assistant partial.
    if (newest.role === "user") return "dangling_user";

    if (newest.role === "assistant") {
      if (newest.content.trim().length === 0) return "dangling_user";
      if (assistantRowFailed(newest.content)) return "dangling_user";
      // Case 3: assistant message contains toolCall blocks — the
      // agent loop was mid-flight (called a tool, expected to
      // continue after getting the result).
      if (assistantHasPendingToolCalls(newest.content)) return "dangling_tool";
    }
  }

  // Case 3: zombie lane operation (agent mid-flight when killed,
  // but repair-lane-state may have already cleared this)
  const laneRows = db
    .prepare<
      [string, string],
      { value: string }
    >(
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

/**
 * Recover all interrupted sessions. Call once at boot after
 * installIdleRunner and server.listen.
 */
export function recoverInterruptedTurns(deps: RecoverDeps): void {
  const { globalOps, pluginRegistry } = deps;

  const interrupted = findInterruptedSessions(globalOps);
  if (interrupted.length === 0) return;

  console.info(
    `[recover] found ${interrupted.length} interrupted session(s), resuming...`,
  );

  for (const entry of interrupted) {
    const { tenantId, sessionId, userId, kind, lastModelId } = entry;
    console.info(
      `[recover] resuming ${tenantId}/${sessionId} (${kind}) for user ${userId}`,
    );

    const ctx = globalOps.open(tenantId);
    const send = (msg: ServerMsg) => {
      broadcastToUser(tenantId, userId, msg);
    };

    const controller = new AbortController();
    // 5 minute deadline per recovery
    const deadline = setTimeout(() => controller.abort(), 5 * 60 * 1000);

    // Load the actual session so runPrompt targets it directly
    // (not whatever ensureActiveSession picks).
    const session = findSessionById(ctx, userId, sessionId);
    if (!session) {
      console.warn(`[recover] session ${sessionId} not found, skipping`);
      clearTimeout(deadline);
      continue;
    }

    const promptArgs = {
      ctx,
      userId,
      send,
      signal: controller.signal,
      pluginRegistry,
      homeDir: ctx.workspaceDir,
      session,
      ...(lastModelId ? { modelId: lastModelId } : {}),
    };

    const doRecover = async () => {
      try {
        if (kind === "dangling_user") {
          await runPrompt({
            ...promptArgs,
            content: "",
            retryLastTurn: true,
          });
        } else {
          // dangling_tool or zombie_op: the agent was mid-turn.
          // repair-lane-state runs inside runPrompt/harness creation.
          // Send a continuation prompt so the agent picks up.
          await runPrompt({
            ...promptArgs,
            content:
              "[system: the previous turn was interrupted by a server restart, please continue where you left off]",
          });
        }
      } catch (err) {
        console.error(
          `[recover] failed to resume ${tenantId}/${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        send({
          type: "stream_error",
          reason: `Recovery failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        clearTimeout(deadline);
      }
    };

    // Fire and forget — don't block boot
    doRecover();
  }
}
