// Session health check.
//
// Scans all tenants, groups active sessions by channel, reports
// message counts, and flags oversized sessions that need compaction.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { CheckGroup } from "../render.js";
import { getTenantsRoot, getTianshuHome } from "../../core/paths.js";
import { GlobalOps } from "../../core/global-ops.js";

/** Sessions with more messages than this trigger a warning. */
const WARNING_THRESHOLD = 500;

export interface SessionCheckOpts {
  home?: string;
  threshold?: number;
}

export interface SessionInfo {
  sessionId: string;
  userId: string;
  status: string;
  parentId: string | null;
  channelId: string | null;
  channelBinding: string | null;
  messageCount: number;
  createdAt: number;
  newestMessage: number | null;
}

export interface ChannelGroup {
  channelId: string | null;
  channelBinding: string | null;
  sessions: SessionInfo[];
}

export interface TenantSessionReport {
  tenantId: string;
  channels: ChannelGroup[];
  totalSessions: number;
  totalMessages: number;
  oversizedCount: number;
}

export interface SessionCheckResult {
  title: string;
  lines: CheckGroup["lines"];
  tenants: TenantSessionReport[];
}

export function checkSessions(opts: SessionCheckOpts = {}): SessionCheckResult {
  const home = opts.home ?? getTianshuHome();
  const threshold = opts.threshold ?? WARNING_THRESHOLD;
  const lines: CheckGroup["lines"] = [];
  const tenants: TenantSessionReport[] = [];

  const tenantsRoot = getTenantsRoot(home);
  if (!fs.existsSync(tenantsRoot)) {
    lines.push({ severity: "ok", text: "no tenants yet" });
    return { title: "Session Health", lines, tenants };
  }

  let ops: GlobalOps;
  try {
    ops = new GlobalOps({ home });
  } catch {
    lines.push({ severity: "warning", text: "could not open GlobalOps" });
    return { title: "Session Health", lines, tenants };
  }

  for (const tenantId of ops.list()) {
    const dbPath = path.join(tenantsRoot, tenantId, "db.sqlite");
    if (!fs.existsSync(dbPath)) continue;

    let db: Database.Database;
    try {
      db = new Database(dbPath, { readonly: true });
    } catch {
      lines.push({ severity: "warning", text: `${tenantId}: cannot open db` });
      continue;
    }

    try {
      const report = scanTenant(db, tenantId, threshold);
      tenants.push(report);

      // Summary line for this tenant
      if (report.oversizedCount > 0) {
        lines.push({
          severity: "warning",
          text: `${tenantId}: ${report.oversizedCount} oversized session(s) (>${threshold} msgs) across ${report.channels.length} channel(s), ${report.totalSessions} total sessions, ${report.totalMessages} total messages`,
          detail: `Use compact_session to split oversized sessions.`,
        });
      } else {
        lines.push({
          severity: "ok",
          text: `${tenantId}: ${report.totalSessions} session(s), ${report.totalMessages} messages — all healthy`,
        });
      }
    } finally {
      db.close();
    }
  }

  if (lines.length === 0) {
    lines.push({ severity: "ok", text: "no tenants with sessions" });
  }

  return { title: "Session Health", lines, tenants };
}

// ─── Internal ─────────────────────────────────────────────────────

function scanTenant(
  db: Database.Database,
  tenantId: string,
  threshold: number,
): TenantSessionReport {
  // Query all sessions with message counts, grouped by channel
  const rows = db
    .prepare<
      [],
      {
        id: string;
        user_id: string;
        status: string;
        parent_id: string | null;
        channel_id: string | null;
        channel_binding: string | null;
        kind: string;
        created_at: number;
        msg_count: number;
        newest_msg: number | null;
      }
    >(
      `SELECT
         s.id,
         s.user_id,
         s.status,
         s.parent_id,
         s.channel_id,
         s.channel_chat_id AS channel_binding,
         s.kind,
         s.created_at,
         (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS msg_count,
         (SELECT MAX(m.created_at) FROM messages m WHERE m.session_id = s.id) AS newest_msg
       FROM sessions s
       WHERE s.status = 'active'
       ORDER BY s.channel_id, s.created_at`,
    )
    .all();

  // Group by channel
  const channelMap = new Map<string, ChannelGroup>();
  let totalMessages = 0;
  let oversizedCount = 0;

  for (const r of rows) {
    const key = r.channel_id ?? r.channel_binding ?? "(direct/no-channel)";
    if (!channelMap.has(key)) {
      channelMap.set(key, {
        channelId: r.channel_id,
        channelBinding: r.channel_binding,
        sessions: [],
      });
    }
    const info: SessionInfo = {
      sessionId: r.id,
      userId: r.user_id,
      status: r.status,
      parentId: r.parent_id,
      channelId: r.channel_id,
      channelBinding: r.channel_binding,
      messageCount: r.msg_count,
      createdAt: r.created_at,
      newestMessage: r.newest_msg,
    };
    channelMap.get(key)!.sessions.push(info);
    totalMessages += r.msg_count;
    if (r.msg_count > threshold) oversizedCount++;
  }

  return {
    tenantId,
    channels: Array.from(channelMap.values()),
    totalSessions: rows.length,
    totalMessages,
    oversizedCount,
  };
}
