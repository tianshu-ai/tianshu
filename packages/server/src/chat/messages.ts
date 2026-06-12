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

/**
 * Create a fresh `kind="worker"` session, owned by the requesting
 * user. Each task gets its own worker session so the message
 * history is bounded to one task's worth of work — this lets the
 * UI show "What did Worker X do for task T?" cleanly without a
 * bunch of unrelated turns leaking in.
 *
 * `parentSessionId` is the `kind='user'` session that requested
 * the worker (i.e. the orchestrator chat the user is talking to).
 * It's stored so a future `/admin/sessions` view can render the
 * worker session as a child of the user session.
 */
export function createWorkerSession(
  ctx: TenantContext,
  args: {
    userId: string;
    workerRole?: string | null;
    parentSessionId?: string | null;
    title?: string | null;
  },
): ChatSession {
  const id = `session_${randomUUID()}`;
  const now = Date.now();
  ctx.db
    .prepare<
      [string, string, string | null, string, string, string | null, string | null, number],
      unknown
    >(
      `INSERT INTO sessions
         (id, user_id, parent_id, status, kind, worker_role, title, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.userId,
      args.parentSessionId ?? null,
      "active",
      "worker",
      args.workerRole ?? null,
      args.title ?? null,
      now,
    );
  return {
    id,
    userId: args.userId,
    parentId: args.parentSessionId ?? null,
    status: "active",
    kind: "worker",
    title: args.title ?? null,
    createdAt: now,
  };
}

/** Mark a session archived (status='archived', ended_at=now). Used
 *  when a worker session finishes so it doesn't keep showing up as
 *  active in admin tooling. */
export function archiveSession(
  ctx: TenantContext,
  sessionId: string,
): void {
  ctx.db
    .prepare<[number, string], unknown>(
      `UPDATE sessions SET status = 'archived', ended_at = ? WHERE id = ?`,
    )
    .run(Date.now(), sessionId);
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
/**
 * Re-hydrate persisted rows from a SPECIFIC session into the
 * structured pi-ai Message log. Use this for the LLM hot path so
 * compacted (=archived) parent sessions don't bleed back into the
 * agent's context. The wider `loadAgentHistory(userId)` overload
 * exists for compatibility and now wraps this one against the
 * user's active session.
 */
export function loadAgentHistoryForSession(
  ctx: TenantContext,
  sessionId: string,
  defaults: {
    api: AssistantMessage["api"];
    provider: AssistantMessage["provider"];
    model: string;
  },
): { messages: Message[]; rows: ChatMessage[] } {
  const rows = listMessagesForSession(ctx, sessionId);
  const out: Message[] = [];
  for (const r of rows) {
    const parsed = tryParseMessage(r.content);
    if (
      parsed &&
      (parsed.role === "user" ||
        parsed.role === "assistant" ||
        parsed.role === "toolResult")
    ) {
      out.push(parsed);
      continue;
    }
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
  }
  return { messages: out, rows };
}

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
/** Per-session, chronological. Used by the chat hot path (which
 *  must not pull in messages from compacted parent sessions). */
export function listMessagesForSession(
  ctx: TenantContext,
  sessionId: string,
): ChatMessage[] {
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
      `SELECT id, session_id, role, content, created_at
       FROM messages
       WHERE session_id = ?
       ORDER BY created_at ASC`,
    )
    .all(sessionId)
    .map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role as ChatMessage["role"],
      content: r.content,
      createdAt: r.created_at,
    }));
}

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

/** Hard caps on page size. Server enforces; clients can request
 *  smaller. The 500 ceiling is generous — most chat UIs render at
 *  most ~50 at a time — but caps catastrophic misuse. */
export const HISTORY_PAGE_DEFAULT = 100;
export const HISTORY_PAGE_MAX = 500;

export interface MessagePage {
  /** Oldest-first slice of the user's transcript. */
  messages: ChatMessage[];
  /** True when at least one message older than the slice exists.
   *  Drives the "Load earlier" button on the client. */
  hasMore: boolean;
}

/**
 * Return the most recent `limit` messages for `userId`, optionally
 * walking back from a `before` cursor (exclusive).
 *
 * The query trick: we sort DESC + LIMIT to pick the right slice,
 * then reverse in JS so the public API stays oldest-first (the
 * format the chat UI prepends / appends without re-sorting).
 *
 * `hasMore` is computed by asking for one extra row; if the DB
 * returned `limit + 1`, there's more older content and we drop
 * the spare. This is one round-trip with one index seek.
 */
export function listMessagesForUserPage(
  ctx: TenantContext,
  userId: string,
  opts: { limit?: number; before?: string } = {},
): MessagePage {
  const requested = Number.isFinite(opts.limit)
    ? Math.max(1, Math.min(HISTORY_PAGE_MAX, Number(opts.limit)))
    : HISTORY_PAGE_DEFAULT;
  const probe = requested + 1;

  // Resolve `before` to a (created_at, id) tuple so we can do a
  // strict "older than" comparison that survives same-ms inserts.
  // If `before` doesn't resolve to an existing row we ignore the
  // cursor and return the latest page — stale ids come up when
  // the user follows a deep link to a deleted message.
  //
  // Note we filter by `s.kind = 'user'` everywhere here. The chat
  // UI is for the user's chat sessions only; worker sessions
  // (kind='worker') belong to the workboard plugin's transcript
  // surface and have their own viewer (`/tasks/:id/history`).
  // Mixing them here used to surface empty assistant messages
  // from worker LLM runs in the user's chat scrollback.
  let cursor: { ts: number; id: string } | null = null;
  if (opts.before) {
    const row = ctx.db
      .prepare<[string, string], { id: string; created_at: number }>(
        `SELECT m.id, m.created_at FROM messages m
         JOIN sessions s ON m.session_id = s.id
         WHERE m.id = ? AND s.user_id = ? AND s.kind = 'user'`,
      )
      .get(opts.before, userId);
    if (row) cursor = { ts: row.created_at, id: row.id };
  }

  const rows = cursor
    ? ctx.db
        .prepare<
          [string, number, number, string, number],
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
           WHERE s.user_id = ? AND s.kind = 'user'
             AND (m.created_at < ?
                  OR (m.created_at = ? AND m.id < ?))
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT ?`,
        )
        .all(userId, cursor.ts, cursor.ts, cursor.id, probe)
    : ctx.db
        .prepare<
          [string, number],
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
           WHERE s.user_id = ? AND s.kind = 'user'
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT ?`,
        )
        .all(userId, probe);

  const hasMore = rows.length > requested;
  const sliced = hasMore ? rows.slice(0, requested) : rows;
  // Public API returns oldest-first.
  sliced.reverse();
  return {
    hasMore,
    messages: sliced.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role as ChatMessage["role"],
      content: r.content,
      createdAt: r.created_at,
    })),
  };
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
