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
import { drainPending as drainInboxPending } from "./session-inbox.js";
import { ensureActiveSession } from "./messages.js";

export interface QueueEntry {
  id: string;
  content: string;
  createdAt: number;
  source?: QueueMessageSource;
  attachments?: Array<{ path: string; mimeType: string; name?: string; size?: number }>;
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
      ...(e.attachments?.length ? { attachments: e.attachments } : {}),
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
    skipInboxDrain?: boolean;
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

  const ctx = deps.globalOps.open(tenantId);
  const uq = getUserQueue(tenantId, userId);

  // If a turn is already active for this user's session, don't drain.
  // The queue stays visible in the UI. The handler's post-turn logic
  // will call drainUserQueue() when the turn ends.
  const session = ensureActiveSession(ctx, userId);
  if (getActiveHarness(session.id)) {
    console.info(`[message-queue] active turn on ${session.id}, queue stays pending (${uq.entries.length} items)`);
    return;
  }

  drainingInBackground.add(key);

  try {
    while (uq.entries.length > 0) {
      const entry = uq.entries.shift()!;
      broadcastQueue(tenantId, userId);
      console.info(`[message-queue] backgroundDrain: running ${entry.id} (${uq.entries.length} remaining in queue)`);

      // Drain any pending inbox messages for this session BEFORE
      // runPrompt, so they don't get injected as system-note prefix
      // (which would duplicate the wechat message content).
      const session = ensureActiveSession(ctx, userId);
      drainInboxPending(ctx, session.id);

      const controller = new AbortController();
      try {
        const promptContent = buildQueuePromptContent(entry);
        await deps.runPrompt({
          ctx,
          userId,
          send: (msg) => broadcastToUser(tenantId, userId, msg),
          content: promptContent,
          signal: controller.signal,
          pluginRegistry: deps.pluginRegistry,
          homeDir: ctx.workspaceDir,
          skipInboxDrain: true,
        });
      } catch (err) {
        console.warn(`[message-queue] backgroundDrain failed for ${entry.id}:`, err);
      }
    }
  } finally {
    drainingInBackground.delete(key);
  }
}

/**
 * Build the prompt content for a queue entry. Embeds a
 * <!--messenger-source:...--> tag when the entry has external
 * source metadata, so toWire can extract it for the frontend.
 */
export function buildQueuePromptContent(entry: QueueEntry): string {
  if (!entry.source) return entry.content;
  const tag = `<!--messenger-source:${JSON.stringify({
    type: entry.source.type,
    contactName: entry.source.contactName,
    contactId: entry.source.contactId,
    instruction: entry.source.instruction,
  })}-->`;
  return tag + "\n" + entry.content;
}

/** Push a message into the user's pending queue. Returns the entry id. */
export function enqueueToUserQueue(
  tenantId: string,
  userId: string,
  content: string,
  source?: QueueMessageSource,
  attachments?: QueueEntry["attachments"],
): string {
  const uq = getUserQueue(tenantId, userId);
  const entry: QueueEntry = {
    id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    content,
    createdAt: Date.now(),
    source,
    ...(attachments?.length ? { attachments } : {}),
  };
  uq.entries.push(entry);
  broadcastQueue(tenantId, userId);
  // Try to drain — backgroundDrain will check for active turns
  // and skip if one is running.
  if (deps) {
    void backgroundDrain(tenantId, userId);
  }
  return entry.id;
}

/**
 * Drain the user's message queue. Called by the handler after a turn
 * ends (post-turn hook) to process any wechat/external messages that
 * arrived while the agent was busy.
 */
export function drainUserQueue(tenantId: string, userId: string): void {
  const uq = getUserQueue(tenantId, userId);
  if (uq.entries.length === 0) return;
  void backgroundDrain(tenantId, userId);
}
