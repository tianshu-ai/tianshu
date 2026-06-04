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
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
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

/**
 * Persist a structured pi-ai Message (assistant w/ tool calls,
 * toolResult, etc.). The full Message JSON goes into `content` and
 * the row's role tracks the pi-ai role mapping (`toolResult` →
 * `"tool"` so the existing role union covers it).
 *
 * Mirrors the closed-source repo's pattern of stuffing the entire
 * AgentMessage JSON into a single column — keeps the schema simple
 * and lets us re-hydrate the agent's exact message shape on resume.
 */
export function appendAgentMessage(
  ctx: TenantContext,
  session: ChatSession,
  msg: AssistantMessage | ToolResultMessage | UserMessage,
): ChatMessage {
  const id = `msg_${randomUUID()}`;
  const now = Date.now();
  const role: ChatMessage["role"] =
    msg.role === "toolResult" ? "tool" : msg.role;
  const content = JSON.stringify(msg);
  ctx.db
    .prepare<
      [string, string, string, string, number],
      unknown
    >(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, session.id, role, content, now);
  return { id, sessionId: session.id, role, content, createdAt: now };
}

/**
 * Re-hydrate persisted rows into the structured pi-ai Message log
 * the agent loop expects. Plain-text rows (role=user with non-JSON
 * content, the legacy form) are upgraded into pi-ai UserMessage/
 * AssistantMessage shells.
 */
export function loadAgentHistory(
  ctx: TenantContext,
  userId: string,
  defaults: {
    api: AssistantMessage["api"];
    provider: AssistantMessage["provider"];
    model: string;
  },
): Message[] {
  const rows = listMessagesForUser(ctx, userId);
  const out: Message[] = [];
  for (const r of rows) {
    const parsed = tryParseMessage(r.content);
    if (parsed && (parsed.role === "user" || parsed.role === "assistant" || parsed.role === "toolResult")) {
      out.push(parsed);
      continue;
    }
    // Legacy plain-text row (PR #21a and earlier).
    if (r.role === "user") {
      out.push({
        role: "user",
        content: [{ type: "text", text: r.content }],
        timestamp: r.createdAt,
      });
    } else if (r.role === "assistant") {
      out.push({
        role: "assistant",
        content: [{ type: "text", text: r.content }],
        api: defaults.api,
        provider: defaults.provider,
        model: defaults.model,
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: r.createdAt,
      });
    }
    // tool / system rows that aren't structured JSON are dropped —
    // they predate persistence support and have nothing to replay.
  }
  return out;
}

function tryParseMessage(content: string): Message | null {
  if (!content || content[0] !== "{") return null;
  try {
    const obj = JSON.parse(content) as { role?: unknown };
    if (
      obj &&
      typeof obj === "object" &&
      typeof obj.role === "string" &&
      (obj.role === "user" || obj.role === "assistant" || obj.role === "toolResult")
    ) {
      return obj as Message;
    }
    return null;
  } catch {
    return null;
  }
}

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
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
