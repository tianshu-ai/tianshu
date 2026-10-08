// Session health check.
//
// Scans all tenants, groups active sessions by channel, estimates
// token usage, and flags sessions that exceed the configured
// compaction threshold (compaction.triggerPercent * contextWindow).

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { CheckGroup } from "../render.js";
import { getTenantsRoot, getTianshuHome } from "../../core/paths.js";
import { GlobalOps } from "../../core/global-ops.js";
import { resolveTenantConfig } from "../../core/config.js";
import { getDefaultModel } from "../../core/llm.js";

/** Rough bytes-per-token for estimation (UTF-8 mix of code + natural language). */
const BYTES_PER_TOKEN = 4;

export interface SessionCheckOpts {
  home?: string;
}

export interface SessionInfo {
  sessionId: string;
  userId: string;
  status: string;
  parentId: string | null;
  channelId: string | null;
  channelChatId: string | null;
  messageCount: number;
  contentBytes: number;
  estimatedTokens: number;
  createdAt: number;
  newestMessage: number | null;
  /** True if this session exceeds the compaction threshold. */
  oversized: boolean;
}

export interface ChannelGroup {
  channelId: string | null;
  channelChatId: string | null;
  sessions: SessionInfo[];
}

export interface TenantSessionReport {
  tenantId: string;
  channels: ChannelGroup[];
  totalSessions: number;
  totalMessages: number;
  oversizedCount: number;
  /** Compaction config used for threshold calculation. */
  compactionConfig: {
    contextWindow: number | null;
    triggerPercent: number;
    thresholdTokens: number | null;
  };
}

export interface SessionCheckResult {
  title: string;
  lines: CheckGroup["lines"];
  tenants: TenantSessionReport[];
}

export function checkSessions(opts: SessionCheckOpts = {}): SessionCheckResult {
  const home = opts.home ?? getTianshuHome();
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
      // Resolve compaction config from tenant
      let contextWindow: number | null = null;
      let triggerPercent = 80; // default

      try {
        const config = resolveTenantConfig(tenantId, home);
        triggerPercent = (config as any).models?.compaction?.triggerPercent
          ?? (config as any).compaction?.triggerPercent ?? 80;
        const modelInfo = getDefaultModel(config);
        contextWindow = modelInfo?.contextWindow ?? null;
      } catch {
        // Config load failed — use defaults
      }

      const thresholdTokens = contextWindow != null
        ? Math.floor(contextWindow * triggerPercent / 100)
        : null;

      const report = scanTenant(db, tenantId, thresholdTokens);
      report.compactionConfig = { contextWindow, triggerPercent, thresholdTokens };
      tenants.push(report);

      if (report.oversizedCount > 0) {
        const thresholdDesc = thresholdTokens != null
          ? `${(thresholdTokens / 1000).toFixed(0)}K tokens (${triggerPercent}% of ${(contextWindow! / 1000).toFixed(0)}K context window)`
          : "unknown (no model context window configured)";
        lines.push({
          severity: "warning",
          text: `${tenantId}: ${report.oversizedCount} session(s) exceed compaction threshold (${thresholdDesc})`,
          detail: `${report.totalSessions} total sessions, ${report.totalMessages} total messages. Use compact_session to split oversized sessions.`,
        });
      } else {
        lines.push({
          severity: "ok",
          text: `${tenantId}: ${report.totalSessions} session(s), ${report.totalMessages} messages — all within compaction threshold`,
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
  thresholdTokens: number | null,
): TenantSessionReport {
  const rows = db
    .prepare<
      [],
      {
        id: string;
        user_id: string;
        status: string;
        parent_id: string | null;
        channel_id: string | null;
        channel_chat_id: string | null;
        kind: string;
        created_at: number;
        msg_count: number;
        content_bytes: number;
        newest_msg: number | null;
      }
    >(
      `SELECT
         s.id,
         s.user_id,
         s.status,
         s.parent_id,
         s.channel_id,
         s.channel_chat_id,
         s.kind,
         s.created_at,
         (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS msg_count,
         (SELECT COALESCE(SUM(LENGTH(m.content)), 0) FROM messages m WHERE m.session_id = s.id) AS content_bytes,
         (SELECT MAX(m.created_at) FROM messages m WHERE m.session_id = s.id) AS newest_msg
       FROM sessions s
       WHERE s.status = 'active'
       ORDER BY s.channel_id, s.created_at`,
    )
    .all();

  const channelMap = new Map<string, ChannelGroup>();
  let totalMessages = 0;
  let oversizedCount = 0;

  for (const r of rows) {
    const estimatedTokens = Math.ceil(r.content_bytes / BYTES_PER_TOKEN);
    const oversized = thresholdTokens != null
      ? estimatedTokens > thresholdTokens
      : r.msg_count > 2000; // fallback if no model config

    const key = r.channel_id
      ? `${r.channel_id}:${r.channel_chat_id ?? "default"}`
      : "(direct)";

    if (!channelMap.has(key)) {
      channelMap.set(key, {
        channelId: r.channel_id,
        channelChatId: r.channel_chat_id,
        sessions: [],
      });
    }

    const info: SessionInfo = {
      sessionId: r.id,
      userId: r.user_id,
      status: r.status,
      parentId: r.parent_id,
      channelId: r.channel_id,
      channelChatId: r.channel_chat_id,
      messageCount: r.msg_count,
      contentBytes: r.content_bytes,
      estimatedTokens,
      createdAt: r.created_at,
      newestMessage: r.newest_msg,
      oversized,
    };
    channelMap.get(key)!.sessions.push(info);
    totalMessages += r.msg_count;
    if (oversized) oversizedCount++;
  }

  return {
    tenantId,
    channels: Array.from(channelMap.values()),
    totalSessions: rows.length,
    totalMessages,
    oversizedCount,
    compactionConfig: {
      contextWindow: null,
      triggerPercent: 80,
      thresholdTokens,
    },
  };
}
