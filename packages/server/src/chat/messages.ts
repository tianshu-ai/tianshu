// Per-tenant message persistence helpers.
//
// PR #21 implements the simplest possible "endless conversation" semantics
// promised by ADR-0001 §5:
//   - one active session per user at any time
//   - all messages live forever in the messages table
//   - compact / search_history come later
//
// Everything is synchronous (better-sqlite3) to keep the call sites
// readable. Indexes on (user_id, status) and (session_id, created_at)
// keep the hot paths fast.

import { randomUUID } from "node:crypto";
import type { TenantContext } from "../core/index.js";

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: number;
}

export interface ChatSession {
  id: string;
  userId: string;
  parentId: string | null;
  status: "active" | "compacted" | "archived";
  kind: "user" | "worker" | "system";
  title: string | null;
  createdAt: number;
}

/** Look up the user's currently-active session, creating one on demand. */
export function ensureActiveSession(ctx: TenantContext, userId: string): ChatSession {
  const existing = ctx.db
    .prepare<
      [string],
      {
        id: string;
        user_id: string;
        parent_id: string | null;
        status: string;
        kind: string;
        title: string | null;
        created_at: number;
      }
    >(
      `SELECT id, user_id, parent_id, status, kind, title, created_at
       FROM sessions
       WHERE user_id = ? AND status = 'active' AND kind = 'user'
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(userId);
  if (existing) {
    return rowToSession(existing);
  }
  const id = `session_${randomUUID()}`;
  const now = Date.now();
  ctx.db
    .prepare<[string, string, string, string, number], unknown>(
      `INSERT INTO sessions (id, user_id, status, kind, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, userId, "active", "user", now);
  return {
    id,
    userId,
    parentId: null,
    status: "active",
    kind: "user",
    title: null,
    createdAt: now,
  };
}

export function appendMessage(
  ctx: TenantContext,
  session: ChatSession,
  msg: { role: ChatMessage["role"]; content: string },
): ChatMessage {
  const id = `msg_${randomUUID()}`;
  const now = Date.now();
  ctx.db
    .prepare<
      [string, string, string, string, number],
      unknown
    >(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, session.id, msg.role, msg.content, now);
  return { id, sessionId: session.id, role: msg.role, content: msg.content, createdAt: now };
}

/** Return the user's full conversation, chronological. PR #21 keeps it simple. */
export function listMessagesForUser(ctx: TenantContext, userId: string): ChatMessage[] {
  return ctx.db
    .prepare<
      [string],
      {
        id: string;
        session_id: string;
        role: string;
        content: string;
        created_at: number;
      }
    >(
      `SELECT m.id, m.session_id, m.role, m.content, m.created_at
       FROM messages m
       JOIN sessions s ON m.session_id = s.id
       WHERE s.user_id = ?
       ORDER BY m.created_at ASC`,
    )
    .all(userId)
    .map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role as ChatMessage["role"],
      content: r.content,
      createdAt: r.created_at,
    }));
}

function rowToSession(r: {
  id: string;
  user_id: string;
  parent_id: string | null;
  status: string;
  kind: string;
  title: string | null;
  created_at: number;
}): ChatSession {
  return {
    id: r.id,
    userId: r.user_id,
    parentId: r.parent_id,
    status: r.status as ChatSession["status"],
    kind: r.kind as ChatSession["kind"],
    title: r.title,
    createdAt: r.created_at,
  };
}
