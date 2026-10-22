// Pending message queue — extracted from handler.ts so plugins can
// push messages via the host.messageQueue capability.
//
// Keyed by "tenantId:userId" so the queue survives WS reconnects
// (page refresh, network blip). Only lost on server restart.

import type { QueueMessageSource } from "@tianshu-ai/plugin-sdk";
import { broadcastToUser } from "./active-harnesses.js";
import type { ServerMsg } from "./ws-protocol.js";

export interface QueueEntry {
  id: string;
  content: string;
  createdAt: number;
  source?: QueueMessageSource;
}

export interface UserQueue {
  entries: QueueEntry[];
  draining: boolean;
}

const userQueues = new Map<string, UserQueue>();

function queueKey(tenantId: string, userId: string): string {
  return `${tenantId}:${userId}`;
}

export function getUserQueue(tenantId: string, userId: string): UserQueue {
  const key = queueKey(tenantId, userId);
  let q = userQueues.get(key);
  if (!q) {
    q = { entries: [], draining: false };
    userQueues.set(key, q);
  }
  return q;
}

/** Broadcast the full queue state to all WS tabs for this user. */
export function broadcastQueue(tenantId: string, userId: string): void {
  const uq = getUserQueue(tenantId, userId);
  const msg = {
    type: "queue_update",
    queue: uq.entries.map((e) => ({
      id: e.id,
      content: e.content,
      createdAt: e.createdAt,
      source: e.source,
    })),
  } as ServerMsg;
  broadcastToUser(tenantId, userId, msg);
}

/**
 * Per-user drain callbacks. The chat handler registers one when a
 * WS connection attaches; it fires drainQueue for that user's
 * session. Multiple tabs → last registered wins (fine: they share
 * the same module-level queue and drainQueue is idempotent).
 */
export type DrainCallback = () => void;
const drainCallbacks = new Map<string, DrainCallback>();

export function registerDrainCallback(tenantId: string, userId: string, cb: DrainCallback): void {
  drainCallbacks.set(queueKey(tenantId, userId), cb);
}

export function unregisterDrainCallback(tenantId: string, userId: string): void {
  drainCallbacks.delete(queueKey(tenantId, userId));
}

/** Push a message into the user's pending queue. Returns the entry id.
 *  If an idle-drain callback is registered and the queue was previously
 *  empty, fires it so the agent processes the message without waiting
 *  for user input. */
export function enqueueToUserQueue(
  tenantId: string,
  userId: string,
  content: string,
  source?: QueueMessageSource,
): string {
  const uq = getUserQueue(tenantId, userId);
  const wasEmpty = uq.entries.length === 0 && !uq.draining;
  const entry: QueueEntry = {
    id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    content,
    createdAt: Date.now(),
    source,
  };
  uq.entries.push(entry);
  broadcastQueue(tenantId, userId);
  // Trigger drain if agent is idle and this is the first queued message.
  if (wasEmpty) {
    const cb = drainCallbacks.get(queueKey(tenantId, userId));
    if (cb) {
      try { cb(); } catch { /* best-effort */ }
    }
  }
  return entry.id;
}
