// Process-local registry of active AgentHarness instances by
// session id.
//
// Why we need this:
//   The session inbox (see session-inbox.ts + plugin-sdk's
//   SessionInboxCapability) needs to know "is the target session
//   currently mid-turn? if so, route the message through
//   `harness.followUp(...)` so the agent picks it up". Without a
//   registry, the inbox can only persist; agents would never see
//   messages until the user typed something else.
//
// Why this is process-local and not durable:
//   Harness instances are JS objects; they live exactly as long
//   as the in-flight WebSocket request that created them. There's
//   nothing to persist. The DB-backed inbox row is the durable
//   layer; this map is just the "fast path".
//
// Concurrency:
//   `register` returns an `unregister()` thunk. The chat handler
//   calls register before `harness.prompt(...)` and the
//   unregister inside its `finally`. There's no cross-tenant
//   concern because session ids are globally unique within a
//   tenant DB; same-id collisions across tenants would be a
//   schema bug.
//
// Multi-process / cluster:
//   Out of scope. If we run multiple host processes one day, the
//   inbox dispatcher will need a cross-process bus (NATS, Redis,
//   …) to find the live harness. The DB persistence path keeps
//   working unchanged.

import type { AgentHarness } from "@earendil-works/pi-agent-core";
import type { ServerMsg } from "./ws-protocol.js";

const active = new Map<string, AgentHarness>();

/**
 * userId → set of `send` thunks for every open chat WebSocket
 * for that user. Keyed by user (not session) because we want
 * inbox-driven background turns to push their stream events to
 * any open tab the user has — they may be looking at a
 * different session card while the inbox runs.
 *
 * Each `send` is a closure created by handler.ts that owns its
 * own ws.send + JSON.stringify; we don't ref the raw ws here so
 * tests don't need a real WebSocket.
 */
const userSendChannels = new Map<string, Set<(msg: ServerMsg) => void>>();

/**
 * Register an active harness for a session. Returns a thunk the
 * caller MUST run when the harness is no longer reachable (turn
 * complete, abort, exception path).
 */
export function registerActiveHarness(
  sessionId: string,
  harness: AgentHarness,
): () => void {
  active.set(sessionId, harness);
  return () => {
    // Only delete if still pointing at the same instance — guards
    // against a stale unregister thunk fired after the slot was
    // re-claimed by a new harness for the same session.
    if (active.get(sessionId) === harness) {
      active.delete(sessionId);
    }
  };
}

/**
 * Look up the active harness for a session, if any. Callers must
 * be defensive: even when this returns a value, the harness may
 * be in the process of shutting down. Use `harness.followUp(...)`
 * inside try/catch.
 */
export function getActiveHarness(sessionId: string): AgentHarness | undefined {
  return active.get(sessionId);
}

/**
 * Register a `send` thunk for `userId`. handler.ts calls this
 * once per inbound chat WebSocket. Returns an unregister thunk
 * the caller MUST run on socket close.
 */
export function registerUserSendChannel(
  userId: string,
  send: (msg: ServerMsg) => void,
): () => void {
  let set = userSendChannels.get(userId);
  if (!set) {
    set = new Set();
    userSendChannels.set(userId, set);
  }
  set.add(send);
  return () => {
    const cur = userSendChannels.get(userId);
    if (!cur) return;
    cur.delete(send);
    if (cur.size === 0) userSendChannels.delete(userId);
  };
}

/**
 * Best-effort fan-out a server event to every chat WebSocket
 * the user has open. Used by the session-inbox idle runner to
 * stream tool calls / deltas of a background turn so any open
 * tab still feels live.
 *
 * A throwing send is logged + skipped — we never want a single
 * bad socket to break the broadcast loop.
 */
export function broadcastToUser(userId: string, msg: ServerMsg): void {
  const set = userSendChannels.get(userId);
  if (!set) return;
  for (const send of set) {
    try {
      send(msg);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[active-harnesses] broadcast send failed for ${userId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/** Test-only: drop everything. Not exported through the package barrel. */
export function _resetActiveHarnesses(): void {
  active.clear();
  userSendChannels.clear();
}
