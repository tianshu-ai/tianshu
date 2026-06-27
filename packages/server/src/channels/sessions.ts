// Channel-session helpers.
//
// A "channel session" is a session row tagged with channel_id /
// channel_chat_id / channel_binding_id. We treat one chat-on-platform
// as one persistent session — for DMs that's a 1:1 conversation with
// the remote user; for groups it's the whole group's history.
//
// `ensureChannelSession` is the workhorse: given an inbound envelope
// describing the (binding, channel, chat) tuple, it finds the
// existing session or creates a fresh one.
//
// Like `ensureActiveSession`, we stamp `created_under_app_version`
// so the tool-delta detector treats channel sessions consistently.

import { randomUUID } from "node:crypto";
import { getPackageVersion } from "../setup/repo-root.js";
import type { TenantContext } from "../core/index.js";
import type { ChatSession } from "../chat/messages.js";

export interface EnsureChannelSessionInput {
  /** Binding the message arrived through. Same binding ⇒ same
   *  session space, so multiple Telegram bots maintain separate
   *  conversations with the same chat id. */
  bindingId: string;
  /** Channel id ("feishu" / "telegram" / "wechat" / ...). */
  channelId: string;
  /** Platform-native chat handle. */
  chatId: string;
  /** Whether this is a 1:1 DM with the bot. Stored for the chat
   *  shell sidebar's "group vs DM" cue. */
  isDirect: boolean;
  /** Display name the adapter resolved. Used to label the session
   *  if we end up creating one. */
  senderName?: string;
}

interface ChannelSessionRow {
  id: string;
  user_id: string;
  parent_id: string | null;
  status: string;
  kind: string;
  title: string | null;
  created_at: number;
  channel_id: string | null;
  channel_chat_id: string | null;
  channel_binding_id: string | null;
}

/** Find the existing channel session for (binding, channel, chat),
 *  or create one. The owner user_id is the tenant's primary user
 *  (first non-deleted row in `users`) — channel messages aren't
 *  authored by an internal user but every session row needs one
 *  to satisfy the foreign-key. */
export function ensureChannelSession(
  ctx: TenantContext,
  input: EnsureChannelSessionInput,
): ChatSession {
  const existing = ctx.db
    .prepare<[string, string, string], ChannelSessionRow>(
      `SELECT id, user_id, parent_id, status, kind, title, created_at,
              channel_id, channel_chat_id, channel_binding_id
         FROM sessions
        WHERE channel_binding_id = ?
          AND channel_id = ?
          AND channel_chat_id = ?
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(input.bindingId, input.channelId, input.chatId);
  if (existing) {
    return {
      id: existing.id,
      userId: existing.user_id,
      parentId: existing.parent_id,
      status: existing.status as ChatSession["status"],
      kind: existing.kind as ChatSession["kind"],
      title: existing.title,
      createdAt: existing.created_at,
    };
  }

  // Create new. Owner = the binding's `owner_user_id`. Channel
  // bindings are personal credentials; sessions inherit that
  // scope so they only surface in the binding-owner's sidebar.
  // Falls back to the tenant's first user when no binding row
  // exists (development paths that synthesise envelopes without
  // a real binding).
  const bindingRow = ctx.db
    .prepare<[string], { owner_user_id: string }>(
      `SELECT owner_user_id FROM channel_bindings WHERE id = ?`,
    )
    .get(input.bindingId);
  let ownerId = bindingRow?.owner_user_id;
  if (!ownerId) {
    const fallback = ctx.db
      .prepare<[], { id: string }>(
        `SELECT id FROM users ORDER BY created_at ASC LIMIT 1`,
      )
      .get();
    if (!fallback) {
      throw new Error(
        `[channel-session] tenant ${ctx.tenantId} has no users; cannot create channel session`,
      );
    }
    ownerId = fallback.id;
  }
  const ownerRow = { id: ownerId };
  const id = `session_${randomUUID()}`;
  const now = Date.now();
  const title = buildChannelSessionTitle(input);
  const appVersion = getPackageVersion();
  ctx.db
    .prepare<
      [string, string, string, string, number, string, string, string, string, string | null],
      unknown
    >(
      `INSERT INTO sessions
         (id, user_id, status, kind, created_at, title,
          channel_id, channel_chat_id, channel_binding_id,
          created_under_app_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ownerRow.id,
      "active",
      "user",
      now,
      title,
      input.channelId,
      input.chatId,
      input.bindingId,
      appVersion,
    );
  return {
    id,
    userId: ownerRow.id,
    parentId: null,
    status: "active",
    kind: "user",
    title,
    createdAt: now,
  };
}

/** Compose a human-readable session title. The chat shell uses this
 *  in the sidebar so an admin can tell channel sessions apart at
 *  a glance. Format: `<channelId>:<dm|group>:<senderName or chatId>`. */
function buildChannelSessionTitle(input: EnsureChannelSessionInput): string {
  const peer = input.senderName?.trim() || input.chatId;
  return `${input.channelId}:${input.isDirect ? "dm" : "group"}:${peer}`;
}
