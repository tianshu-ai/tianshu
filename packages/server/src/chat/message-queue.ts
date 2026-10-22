// Pending message queue — extracted from handler.ts so plugins can
// push messages via the host.messageQueue capability.
//
// Keyed by "tenantId:userId" so the queue survives WS reconnects
// (page refresh, network blip). Only lost on server restart.
//
// Drain: when a new message is enqueued externally (plugin push),
// we schedule a background drain that pops entries one by one and
// runs each through runPrompt via the bound queue runner. This
// works regardless of whether a WS connection is open.

import type { QueueMessageSource } from "@tianshu-ai/plugin-sdk";
import { broadcastToUser, getActiveHarness } from "./active-harnesses.js";
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

// ── Background queue drain ──────────────────────────────────────
// Bound at startup by the host. Same as a user sending a message:
// find session → runPrompt.

import type { TenantContext } from "../core/index.js";
import type { PluginRegistry } from "../core/plugins/registry.js";

export interface QueueDrainDeps {
  globalOps: { list(): string[]; open(id: string): TenantContext };
  pluginRegistry: PluginRegistry;
  runPrompt: (args: {
    ctx: TenantContext;
    userId: string;
    send: (msg: ServerMsg) => void;
    content: string;
    signal: AbortSignal;
    pluginRegistry: PluginRegistry;
    homeDir: string;
  }) => Promise<void>;
}

let deps: QueueDrainDeps | null = null;

export function bindQueueDrain(d: QueueDrainDeps): void {
  deps = d;
}

const drainingInBackground = new Set<string>();

export function isDrainingInBackground(tenantId: string, userId: string): boolean {
  return drainingInBackground.has(queueKey(tenantId, userId));
}

async function backgroundDrain(tenantId: string, userId: string): Promise<void> {
  if (!deps) return;
  const key = queueKey(tenantId, userId);
  if (drainingInBackground.has(key)) return;
  drainingInBackground.add(key);

  const ctx = deps.globalOps.open(tenantId);
  const uq = getUserQueue(tenantId, userId);

  try {
    while (uq.entries.length > 0) {
      const entry = uq.entries.shift()!;
      broadcastQueue(tenantId, userId);
      console.info(`[message-queue] backgroundDrain: running ${entry.id}`);
      const controller = new AbortController();
      try {
        await deps.runPrompt({
          ctx,
          userId,
          send: (msg) => broadcastToUser(tenantId, userId, msg),
          content: entry.content,
          signal: controller.signal,
          pluginRegistry: deps.pluginRegistry,
          homeDir: ctx.workspaceDir,
        });
      } catch (err) {
        console.warn(`[message-queue] backgroundDrain failed for ${entry.id}:`, err);
      }
    }
  } finally {
    drainingInBackground.delete(key);
  }
}

/** Push a message into the user's pending queue. Returns the entry id. */
export function enqueueToUserQueue(
  tenantId: string,
  userId: string,
  content: string,
  source?: QueueMessageSource,
): string {
  const uq = getUserQueue(tenantId, userId);
  const wasEmpty = uq.entries.length === 0 && !uq.draining && !drainingInBackground.has(queueKey(tenantId, userId));
  const entry: QueueEntry = {
    id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    content,
    createdAt: Date.now(),
    source,
  };
  uq.entries.push(entry);
  broadcastQueue(tenantId, userId);
  // Trigger background drain — same as a user sending a message.
  if (wasEmpty && deps) {
    void backgroundDrain(tenantId, userId);
  }
  return entry.id;
}
