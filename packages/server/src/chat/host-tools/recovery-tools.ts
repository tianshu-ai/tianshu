// Host-owned tools for the session-recovery agent.
//
// These are NOT visible to regular agents (recovery's
// toolsAllow filter pulls them in by name; everyone else's
// implicit allow-list doesn't mention them). They live here
// instead of in a plugin because they need direct DB access for
// session lookup and direct file-system access for log tailing
// \u2014 plugin sandboxing would just get in the way.
//
// Three tools:
//   - inspect_session   : read-only. recent messages + pending
//                         tools + stream_error rows for a session.
//   - read_session_log  : read-only. tails the dev-server log
//                         (TIANSHU_LOG_PATH or stderr) for lines
//                         tagged with the session id.
//   - nudge_session     : MUTATING. appends a system note to the
//                         broken session's inbox so the user (or
//                         their main agent) sees the recovery's
//                         conclusion on the next turn.

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";
import type { TenantContext } from "../../core/tenant-context.js";
import { enqueue as inboxEnqueue } from "../session-inbox.js";

/** Resolver the host wires into recovery-tool factories. We pull
 *  the tenant id off the per-call AgentToolContext and call this
 *  to get a TenantContext (DB + paths). The host owns the
 *  lifecycle; tools shouldn't open/close DBs themselves. */
type OpenTenantFn = (tenantId: string) => TenantContext;

interface MessageRow {
  id: string;
  role: string;
  content: string;
  entry_type: string;
  created_at: number;
}

export const INSPECT_SESSION_TOOL_NAME = "inspect_session";
export const READ_SESSION_LOG_TOOL_NAME = "read_session_log";
export const NUDGE_SESSION_TOOL_NAME = "nudge_session";

/** Maximum length of the message-content preview we return per row.
 *  Recovery doesn't need full transcripts; a head slice is enough
 *  to understand what was happening. */
const PREVIEW_CHARS = 600;

/** Default minutes-back window for read_session_log. Wide enough to
 *  catch the crash + the events leading up to it, narrow enough
 *  that the tail doesn't include unrelated noise. */
const DEFAULT_LOG_WINDOW_MIN = 15;

interface DbRecoveryToolsCtx {
  /** Open the tenant whose db the tool needs to read or write.
   *  Recovery tools are tenant-scoped because every chat session
   *  lives in exactly one tenant's DB. */
  openTenant: OpenTenantFn;
}

// \u2500\u2500\u2500 inspect_session \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function buildInspectSessionTool(
  rc: DbRecoveryToolsCtx,
): AgentTool {
  return {
    schema: {
      name: INSPECT_SESSION_TOOL_NAME,
      description:
        "Read-only diagnostic dump of a chat session. Returns the session's current status, its last ~10 messages (role, role-type, head-preview, timestamp), any tool calls that were still in flight when the session was last touched, and whether there are unread inbox rows.\n\nUse this as your FIRST diagnostic step when the recovery initial prompt didn't tell you enough about what crashed. The transcript head + stream_error rows usually point at the cause; if not, follow up with read_session_log for stack traces.",
      parameters: Type.Object({
        sessionId: Type.String({
          description:
            "Target chat session id (e.g. 'sess_abc123'). Use the id from the recovery's initial prompt.",
        }),
      }),
    },

    async execute(args, agentCtx: AgentToolContext) {
      const sessionId = String((args as { sessionId?: unknown }).sessionId ?? "").trim();
      if (!sessionId) {
        return { ok: false, error: "sessionId is required" };
      }
      const ctx = rc.openTenant(agentCtx.tenantId);
      const sessionRow = ctx.db
        .prepare<
          [string],
          {
            id: string;
            user_id: string;
            status: string;
            kind: string;
            title: string | null;
            project_slug: string | null;
            created_at: number;
            ended_at: number | null;
          }
        >(
          `SELECT id, user_id, status, kind, title, project_slug, created_at, ended_at
             FROM sessions WHERE id = ?`,
        )
        .get(sessionId);
      if (!sessionRow) {
        return { ok: false, error: `session not found: ${sessionId}` };
      }
      const messages = ctx.db
        .prepare<[string], MessageRow>(
          `SELECT id, role, content, entry_type, created_at
             FROM messages
             WHERE session_id = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT 10`,
        )
        .all(sessionId);
      // Reverse to chronological order for easier reading.
      messages.reverse();

      const pendingInbox = ctx.db
        .prepare<[string], { n: number }>(
          `SELECT COUNT(*) as n FROM session_inbox
             WHERE target_session_id = ? AND status = 'pending'`,
        )
        .get(sessionId)?.n ?? 0;

      // Look for stream_error rows in the last 30 minutes. These
      // are stored as entry_details on system rows in tianshu's
      // current schema; if the schema later breaks them out into
      // their own table, swap this query.
      const since = Date.now() - 30 * 60_000;
      const recentErrors = ctx.db
        .prepare<
          [string, number],
          { id: string; content: string; created_at: number }
        >(
          `SELECT id, content, created_at FROM messages
             WHERE session_id = ?
               AND created_at >= ?
               AND (role = 'system' AND content LIKE '%stream_error%')
             ORDER BY created_at DESC
             LIMIT 5`,
        )
        .all(sessionId, since);

      return {
        ok: true,
        session: {
          id: sessionRow.id,
          userId: sessionRow.user_id,
          status: sessionRow.status,
          kind: sessionRow.kind,
          title: sessionRow.title,
          projectSlug: sessionRow.project_slug,
          createdAt: new Date(sessionRow.created_at).toISOString(),
          endedAt:
            sessionRow.ended_at === null
              ? null
              : new Date(sessionRow.ended_at).toISOString(),
        },
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          entryType: m.entry_type,
          createdAt: new Date(m.created_at).toISOString(),
          preview: truncate(m.content, PREVIEW_CHARS),
        })),
        pendingInbox,
        recentErrors: recentErrors.map((e) => ({
          id: e.id,
          createdAt: new Date(e.created_at).toISOString(),
          preview: truncate(e.content, PREVIEW_CHARS),
        })),
        hint:
          recentErrors.length > 0
            ? "stream_error rows present \u2014 read their preview field."
            : messages.length === 0
              ? "session has no messages \u2014 may be freshly created or wiped."
              : "no recent stream_error rows visible; check read_session_log for stack traces.",
      };
    },
  };
}

// \u2500\u2500\u2500 read_session_log \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function buildReadSessionLogTool(): AgentTool {
  return {
    schema: {
      name: READ_SESSION_LOG_TOOL_NAME,
      description:
        "Read-only. Tails the dev-server log and returns lines tagged with the given session id (or matching a free-form pattern). Use when inspect_session didn't give you enough \u2014 stack traces and unhandled exceptions land here, not in the session transcript.\n\nThe log file is selected from the TIANSHU_LOG_PATH env var (production tianshu starts) or a couple of well-known paths under ~/.tianshu/logs/. If no log file is found the tool returns 'no log available' and the recovery agent should fall back to inspect_session + heuristics.",
      parameters: Type.Object({
        sessionId: Type.Optional(
          Type.String({
            description:
              "Session id to grep for. Recommended; without it we'll grep on a free-form pattern instead.",
          }),
        ),
        pattern: Type.Optional(
          Type.String({
            description:
              "Optional substring to filter for (e.g. 'compact', 'ECONNRESET'). Combined with sessionId via AND.",
          }),
        ),
        minutesBack: Type.Optional(
          Type.Number({
            description:
              "Look back this many minutes. Default 15. Max 240 (4 hours).",
            minimum: 1,
            maximum: 240,
          }),
        ),
        maxLines: Type.Optional(
          Type.Number({
            description:
              "Cap the number of matched lines returned (head of match). Default 50. Max 500.",
            minimum: 1,
            maximum: 500,
          }),
        ),
      }),
    },

    async execute(args) {
      const sessionId = typeof (args as { sessionId?: unknown }).sessionId === "string"
        ? (args as { sessionId: string }).sessionId.trim()
        : "";
      const pattern = typeof (args as { pattern?: unknown }).pattern === "string"
        ? (args as { pattern: string }).pattern.trim()
        : "";
      const minutesBack = Math.min(
        240,
        Math.max(
          1,
          Number((args as { minutesBack?: unknown }).minutesBack) || DEFAULT_LOG_WINDOW_MIN,
        ),
      );
      const maxLines = Math.min(
        500,
        Math.max(1, Number((args as { maxLines?: unknown }).maxLines) || 50),
      );

      if (!sessionId && !pattern) {
        return {
          ok: false,
          error: "Pass at least one of sessionId or pattern.",
        };
      }

      const logPath = resolveLogPath();
      if (!logPath) {
        return {
          ok: false,
          reason: "no_log_available",
          hint:
            "No dev-server log file found at TIANSHU_LOG_PATH or ~/.tianshu/logs/server.log. The server may be logging to stderr only; check the terminal you started tianshu in.",
        };
      }

      const sinceMs = Date.now() - minutesBack * 60_000;
      const matched: string[] = [];
      try {
        // Stream-read; the log can be large. We don't need fancy
        // indexing because we only keep matching lines and cap
        // them at maxLines.
        const content = fs.readFileSync(logPath, "utf8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          // Best-effort timestamp filter: tianshu's pino log
          // prefixes ISO timestamps; if a line doesn't have one
          // we don't bother time-filtering it (some lines wrap
          // from previous stack traces).
          const ts = parseLeadingTimestamp(line);
          if (ts !== null && ts < sinceMs) continue;
          if (sessionId && !line.includes(sessionId)) continue;
          if (pattern && !line.includes(pattern)) continue;
          matched.push(line);
          if (matched.length >= maxLines) break;
        }
      } catch (err) {
        return {
          ok: false,
          error: `read ${logPath}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      return {
        ok: true,
        logPath,
        windowMinutes: minutesBack,
        matchedCount: matched.length,
        truncated: matched.length >= maxLines,
        lines: matched,
      };
    },
  };
}

// \u2500\u2500\u2500 nudge_session \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function buildNudgeSessionTool(
  rc: DbRecoveryToolsCtx,
): AgentTool {
  return {
    schema: {
      name: NUDGE_SESSION_TOOL_NAME,
      description:
        "Post a recovery system-note to the broken session's inbox. The user (or their main agent) sees it on the next turn. ONE nudge per recovery; pick your wording carefully:\n\n  - Lead with what failed in one sentence.\n  - State what (if anything) you fixed.\n  - Tell the user what to do next (\"type 'retry' to continue\", \"restart the gateway\", or just \"investigate manually\").\n  - DON'T paste stack traces. Reference inspect_session / read_session_log instead.\n\nThe note posts as an `inbox_recovery_note` kind so the chat handler renders it differently from a normal task_done notification \u2014 the user knows it came from automated recovery.",
      parameters: Type.Object({
        sessionId: Type.String({
          description:
            "Target session id (the broken session from your initial prompt).",
        }),
        text: Type.String({
          description:
            "Short markdown body. 2\u20133 sentences. No stack traces.",
          minLength: 1,
          maxLength: 2_000,
        }),
      }),
    },

    async execute(args, agentCtx: AgentToolContext) {
      const sessionId = String((args as { sessionId?: unknown }).sessionId ?? "").trim();
      const text = String((args as { text?: unknown }).text ?? "").trim();
      if (!sessionId || !text) {
        return { ok: false, error: "sessionId and text are required" };
      }
      const ctx = rc.openTenant(agentCtx.tenantId);
      const exists = ctx.db
        .prepare<[string], { id: string }>(
          `SELECT id FROM sessions WHERE id = ?`,
        )
        .get(sessionId);
      if (!exists) {
        return { ok: false, error: `session not found: ${sessionId}` };
      }
      try {
        const id = await inboxEnqueue(ctx, sessionId, {
          kind: "inbox_recovery_note",
          text,
        });
        return { ok: true, inboxId: id };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

// \u2500\u2500\u2500 helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function truncate(s: string, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n) + "\u2026";
}

function resolveLogPath(): string | null {
  const explicit = process.env.TIANSHU_LOG_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [
    path.join(
      process.env.HOME ?? "",
      ".tianshu",
      "logs",
      "server.log",
    ),
    path.join(
      process.env.HOME ?? "",
      ".tianshu",
      "server.log",
    ),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function parseLeadingTimestamp(line: string): number | null {
  // Match ISO-ish timestamps at line start: pino default is
  // {"level":...,"time":<ms>...}; openclaw-style logs prefix
  // [YYYY-MM-DDTHH:mm:ss.sssZ]. We try both shapes; if neither
  // matches we return null (don't time-filter).
  if (line.startsWith("{")) {
    try {
      const parsed = JSON.parse(line) as { time?: unknown };
      if (typeof parsed.time === "number") return parsed.time;
    } catch {
      /* fall through to bracket match */
    }
  }
  const m = /^\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\]?/.exec(line);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}
