// Read conversation sessions + their associated tasks from the tenant
// DB, for the session-driven wiki ingest.
//
// The wiki records with the SESSION as the unit of work: a user's
// sessions form the timeline of their interactions, and worker tasks
// hang off a session via tasks.parent_session_id. We walk that
// timeline oldest-first, hand the agent one session's full transcript
// + linked tasks (+ the tasks' own worker-session transcripts and the
// files they produced), and the agent distils it into wiki pages.
//
// The plugin closes over the tenant DB handle from activate(ctx.db).
// Everything is scoped by userId (multi-tenant: never read another
// user's sessions).

import type { TenantDbHandle } from "@tianshu-ai/plugin-sdk";

export interface SessionRow {
  id: string;
  user_id: string;
  parent_id: string | null;
  status: string;
  kind: string;
  title: string | null;
  project_slug: string | null;
  compacted_summary: string | null;
  created_at: number;
  ended_at: number | null;
}

/** A message joined with the session it belongs to, for the time-
 *  ordered cross-session walk. */
export interface TimedMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: number;
}

/** Local-timezone day key (YYYY-MM-DD) for an epoch-ms timestamp.
 *  Uses the host's local timezone (the deployment's "current
 *  timezone"), NOT UTC — so a day boundary matches the operator's
 *  wall clock. */
export function localDay(ms: number, tz?: string): string {
  const d = new Date(ms);
  // en-CA gives YYYY-MM-DD; honour an explicit tz when provided.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * All of a user's conversation messages with created_at > afterMs,
 * across every session (user + worker/task) EXCEPT the wiki-worker's
 * own sessions, ordered by time. This is the time-line the wiki walks:
 * a single chronological stream, not per-session. Capped at `limit`
 * rows so a huge backlog is paged by the caller.
 */
export function listMessagesAfter(
  db: TenantDbHandle,
  userId: string,
  afterMs: number,
  limit: number,
): TimedMessageRow[] {
  return db
    .prepare<[string, string, number, number], TimedMessageRow>(
      `SELECT m.id, m.session_id, m.role, m.content, m.created_at
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
        WHERE s.user_id = ?
          AND (s.worker_role IS NULL OR s.worker_role <> ?)
          AND m.created_at > ?
        ORDER BY m.created_at ASC
        LIMIT ?`,
    )
    .all(userId, WIKI_WORKER_ROLE, afterMs, limit);
}

/** Earliest + latest message time across the user's non-wiki sessions,
 *  for progress computation. Returns {min,max} in epoch ms (0 if none). */
export function messageTimeSpan(db: TenantDbHandle, userId: string): { min: number; max: number } {
  const r = db
    .prepare<[string, string], { min: number | null; max: number | null }>(
      `SELECT MIN(m.created_at) min, MAX(m.created_at) max
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
        WHERE s.user_id = ?
          AND (s.worker_role IS NULL OR s.worker_role <> ?)`,
    )
    .get(userId, WIKI_WORKER_ROLE);
  return { min: r?.min ?? 0, max: r?.max ?? 0 };
}

/** Tasks whose created_at falls in [startMs, endMs], across the user's
 *  sessions — so a day's tasks are handed over with that day's
 *  messages. */
export function tasksInRange(
  db: TenantDbHandle,
  userId: string,
  startMs: number,
  endMs: number,
): TaskRow[] {
  return db
    .prepare<[string, number, number], TaskRow>(
      `SELECT t.id, t.project_slug, t.title, t.description, t.status, t.result_summary,
              t.result_files, t.session_id, t.parent_session_id, t.created_at, t.ended_at
         FROM tasks t
         JOIN sessions s ON s.id = t.parent_session_id
        WHERE s.user_id = ?
          AND t.created_at >= ? AND t.created_at <= ?
        ORDER BY t.created_at ASC`,
    )
    .all(userId, startMs, endMs);
}

export interface MessageRow {
  id: string;
  role: string;
  content: string;
  created_at: number;
}

export interface TaskRow {
  id: string;
  project_slug: string | null;
  title: string;
  description: string | null;
  status: string;
  result_summary: string | null;
  result_files: string | null; // JSON array
  session_id: string | null; // worker's own session
  parent_session_id: string | null; // the session that spawned it
  created_at: number;
  ended_at: number | null;
}

/** worker_role stamped on the wiki's own background worker sessions,
 *  so the wiki analysis excludes itself (no self-referential loop:
 *  analysing "the session where I analysed the wiki"). Everything
 *  else — user conversations AND other worker/task sessions — is fair
 *  game for the wiki. */
export const WIKI_WORKER_ROLE = "wiki";

/**
 * List a user's sessions in timeline order (oldest first) for wiki
 * ingest. Includes conversation windows (kind='user') AND other
 * worker/task sessions (they carry real work worth recording) — but
 * EXCLUDES the wiki's own background worker sessions
 * (worker_role='wiki') to avoid a self-referential loop. Compacted +
 * active alike; the whole timeline is fair game.
 */
export function listUserSessions(db: TenantDbHandle, userId: string): SessionRow[] {
  return db
    .prepare<[string, string], SessionRow>(
      `SELECT id, user_id, parent_id, status, kind, title, project_slug,
              compacted_summary, created_at, ended_at
         FROM sessions
        WHERE user_id = ?
          AND (worker_role IS NULL OR worker_role <> ?)
        ORDER BY created_at ASC`,
    )
    .all(userId, WIKI_WORKER_ROLE);
}

/** All messages in a session, chronological. */
export function listSessionMessages(db: TenantDbHandle, sessionId: string): MessageRow[] {
  return db
    .prepare<[string], MessageRow>(
      `SELECT id, role, content, created_at
         FROM messages
        WHERE session_id = ?
        ORDER BY created_at ASC`,
    )
    .all(sessionId);
}

/** Tasks spawned from a given session (via parent_session_id). */
export function listSessionTasks(db: TenantDbHandle, parentSessionId: string): TaskRow[] {
  return db
    .prepare<[string], TaskRow>(
      `SELECT id, project_slug, title, description, status, result_summary,
              result_files, session_id, parent_session_id, created_at, ended_at
         FROM tasks
        WHERE parent_session_id = ?
        ORDER BY created_at ASC`,
    )
    .all(parentSessionId);
}

/** Render a message's stored JSON content down to plain text for the
 *  agent to read. Messages store a JSON blob (pi AgentMessage shape or
 *  a plain string); we extract text/tool-call gist, dropping heavy
 *  tool output. Best-effort — unknown shapes fall back to the raw
 *  string, truncated. */
export function messageToText(role: string, contentJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    // Plain-string content.
    return `${role}: ${truncate(contentJson, 4000)}`;
  }
  if (typeof parsed === "string") return `${role}: ${truncate(parsed, 4000)}`;

  const parts: string[] = [];
  const blocks = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { content?: unknown }).content)
      ? ((parsed as { content: unknown[] }).content)
      : null;
  if (!blocks) {
    // Object with a top-level text field, or unknown — stringify small.
    const t = (parsed as { text?: unknown }).text;
    if (typeof t === "string") return `${role}: ${truncate(t, 4000)}`;
    return `${role}: ${truncate(JSON.stringify(parsed), 1200)}`;
  }
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    const kind = (b as { type?: string }).type;
    if (kind === "text" && typeof (b as { text?: string }).text === "string") {
      parts.push((b as { text: string }).text);
    } else if (kind === "tool_call" || kind === "toolCall") {
      const name = (b as { name?: string }).name ?? "tool";
      parts.push(`[called ${name}]`);
    } else if (kind === "tool_result" || kind === "toolResult") {
      parts.push(`[tool result]`);
    }
  }
  const text = parts.join("\n").trim();
  return `${role}: ${truncate(text || "(no text)", 4000)}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + " …[truncated]" : s;
}

/** Parse tasks.result_files JSON into a string[] (best-effort). */
export function parseResultFiles(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
