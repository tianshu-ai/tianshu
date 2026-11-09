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
import { ensureActiveSession, appendMessage } from "./messages.js";
import { toWire } from "./ws-protocol.js";

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
    attachments?: Array<{ path: string; mimeType: string; name?: string; size?: number }>;
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
    // Batch drain: take all queued entries at once and merge them
    // into a single prompt so the agent responds to everything in
    // one turn instead of processing messages one by one.
    const batch = uq.entries.splice(0);
    if (batch.length === 0) return;
    broadcastQueue(tenantId, userId);
    console.info(`[message-queue] backgroundDrain: batch of ${batch.length} message(s)`);

    const session = ensureActiveSession(ctx, userId);
    drainInboxPending(ctx, session.id);

    // Persist first N-1 messages as user bubbles (no agent turn).
    // Collect attachments from all entries — they'll be sent with
    // the final runPrompt so the agent can see them all.
    let allAttachments: QueueEntry["attachments"] = [];
    for (let i = 0; i < batch.length - 1; i++) {
      const entry = batch[i]!;
      const content = buildQueuePromptContent(entry);
      const piMsg = JSON.stringify({
        role: "user",
        content: [{ type: "text", text: content }],
        timestamp: entry.createdAt,
      });
      const row = appendMessage(ctx, session, { role: "user", content: piMsg });
      broadcastToUser(tenantId, userId, { type: "message_added", message: toWire(row) } as any);
      if (entry.attachments?.length) {
        allAttachments = [...(allAttachments || []), ...entry.attachments];
      }
      console.info(`[message-queue] persisted queue entry ${entry.id} as user bubble ${row.id}`);
    }

    // Last message triggers the actual agent turn via runPrompt.
    // All collected attachments from earlier entries are merged in.
    const last = batch[batch.length - 1]!;
    const lastContent = buildQueuePromptContent(last);
    if (last.attachments?.length) {
      allAttachments = [...(allAttachments || []), ...last.attachments];
    }
    const controller = new AbortController();
    try {
      await deps.runPrompt({
        ctx,
        userId,
        send: (msg) => broadcastToUser(tenantId, userId, msg),
        content: lastContent,
        signal: controller.signal,
        pluginRegistry: deps.pluginRegistry,
        homeDir: ctx.workspaceDir,
        skipInboxDrain: true,
        ...(allAttachments?.length ? { attachments: allAttachments } : {}),
      });
    } catch (err) {
      console.warn(`[message-queue] backgroundDrain batch failed:`, err);
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
  // Source metadata as a visible prefix so the model knows the origin
  // and can follow routing instructions. Previously used HTML comments
  // (<!-- -->), but Markdown renderers hide those, making the user's
  // chat bubble appear empty.
  const label = entry.source.contactName
    ? `[${entry.source.type ?? "message"}] ${entry.source.contactName}`
    : "";
  const instruction = entry.source.instruction ? `\n${entry.source.instruction}` : "";
  return label ? `${label}: ${entry.content}${instruction}` : `${entry.content}${instruction}`;
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
