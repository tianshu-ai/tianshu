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

/** Push a message into the user's pending queue. Returns the entry id.
 *  The caller is responsible for triggering drain if the agent is idle. */
export function enqueueToUserQueue(
  tenantId: string,
  userId: string,
  content: string,
  source?: QueueMessageSource,
): string {
  const uq = getUserQueue(tenantId, userId);
  const entry: QueueEntry = {
    id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    content,
    createdAt: Date.now(),
    source,
  };
  uq.entries.push(entry);
  broadcastQueue(tenantId, userId);
  return entry.id;
}
