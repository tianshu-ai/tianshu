/**
 * Token usage analytics API — super-admin only.
 *
 * Aggregates usage from assistant messages in each tenant's DB.
 * GET /api/admin/usage?tenantId=demo&days=30
 */

import { type Express, type Request, type Response } from "express";
import { requireSuperAdmin } from "./routes-auth.js";

interface UsageRow {
  userId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  messageCount: number;
}

export function mountUsageRoutes(
  app: Express,
  deps: {
    listTenants: () => string[];
    getTenantDb: (tenantId: string) => import("better-sqlite3").Database | null;
  },
): void {
  // Per-user usage breakdown for a tenant
  app.get("/api/admin/usage", requireSuperAdmin, (req: Request, res: Response) => {
    const tenantId = String(req.query.tenantId ?? req.ctx?.tenant.tenantId ?? "");
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? "30"), 10) || 30, 1), 365);

    const db = deps.getTenantDb(tenantId);
    if (!db) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }

    const sinceMs = Date.now() - days * 86400_000;

    // Extract usage from the JSON content of assistant messages.
    // SQLite json_extract works on the stored pi-ai Message JSON.
    try {
      const rows = db.prepare<[number], {
        user_id: string;
        model: string;
        input_tokens: number;
        output_tokens: number;
        total_tokens: number;
        msg_count: number;
      }>(`
        SELECT
          s.user_id,
          COALESCE(json_extract(m.content, '$.model'), 'unknown') as model,
          COALESCE(SUM(json_extract(m.content, '$.usage.input')), 0) as input_tokens,
          COALESCE(SUM(json_extract(m.content, '$.usage.output')), 0) as output_tokens,
          COALESCE(SUM(json_extract(m.content, '$.usage.totalTokens')), 0) as total_tokens,
          COUNT(*) as msg_count
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        WHERE m.role = 'assistant'
          AND m.created_at > ?
          AND m.content LIKE '{%'
          AND json_valid(m.content)
          AND json_extract(m.content, '$.usage') IS NOT NULL
        GROUP BY s.user_id, json_extract(m.content, '$.model')
        ORDER BY total_tokens DESC
      `).all(sinceMs);

      // Resolve user display names
      const userNames = new Map<string, string>();
      try {
        const nameRows = db.prepare(`SELECT id, display_name FROM users WHERE display_name IS NOT NULL AND display_name != ''`)
          .all() as Array<{ id: string; display_name: string }>;
        for (const nr of nameRows) userNames.set(nr.id, nr.display_name);
      } catch { /* best effort */ }

      // Also get per-user totals
      const userTotals = new Map<string, { input: number; output: number; total: number; messages: number }>();
      for (const r of rows) {
        const existing = userTotals.get(r.user_id) ?? { input: 0, output: 0, total: 0, messages: 0 };
        existing.input += r.input_tokens;
        existing.output += r.output_tokens;
        existing.total += r.total_tokens;
        existing.messages += r.msg_count;
        userTotals.set(r.user_id, existing);
      }

      // Daily breakdown for trend chart
      // Daily breakdown grouped by model for stacked bar chart
      const dailyModelRows = db.prepare<[number], {
        day: string; model: string; total_tokens: number; msg_count: number;
      }>(`
        SELECT
          date(m.created_at/1000, 'unixepoch') as day,
          COALESCE(json_extract(m.content, '$.model'), 'unknown') as model,
          COALESCE(SUM(json_extract(m.content, '$.usage.totalTokens')), 0) as total_tokens,
          COUNT(*) as msg_count
        FROM messages m
        WHERE m.role = 'assistant' AND m.created_at > ?
          AND m.content LIKE '{%' AND json_valid(m.content)
          AND json_extract(m.content, '$.usage') IS NOT NULL
        GROUP BY day, model ORDER BY day
      `).all(sinceMs);

      // Pivot: each day becomes { day, totalTokens, [model1]: tokens, [model2]: tokens, ... }
      const dayMap = new Map<string, Record<string, number>>();
      const allModels = new Set<string>();
      for (const r of dailyModelRows) {
        allModels.add(r.model);
        const entry = dayMap.get(r.day) ?? { totalTokens: 0 };
        entry[r.model] = (entry[r.model] ?? 0) + r.total_tokens;
        entry.totalTokens = (entry.totalTokens ?? 0) + r.total_tokens;
        dayMap.set(r.day, entry);
      }
      const dailyRows = Array.from(dayMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, data]) => ({ day, ...data }));

      // Model breakdown
      const modelRows = db.prepare<[number], {
        model: string; total_tokens: number; msg_count: number;
      }>(`
        SELECT
          COALESCE(json_extract(m.content, '$.model'), 'unknown') as model,
          COALESCE(SUM(json_extract(m.content, '$.usage.totalTokens')), 0) as total_tokens,
          COUNT(*) as msg_count
        FROM messages m
        WHERE m.role = 'assistant' AND m.created_at > ?
          AND m.content LIKE '{%' AND json_valid(m.content)
          AND json_extract(m.content, '$.usage') IS NOT NULL
        GROUP BY model ORDER BY total_tokens DESC
      `).all(sinceMs);

      res.json({
        tenantId,
        days,
        daily: dailyRows,
        models: Array.from(allModels),
        byModel: modelRows.map((r) => ({
          model: r.model,
          totalTokens: r.total_tokens,
          messageCount: r.msg_count,
        })),
        byUser: Array.from(userTotals.entries()).map(([userId, t]) => ({
          userId,
          displayName: userNames.get(userId) || undefined,
          ...t,
        })).sort((a, b) => b.total - a.total),
        byUserModel: rows.map((r) => ({
          userId: r.user_id,
          model: r.model,
          totalTokens: r.total_tokens,
          messageCount: r.msg_count,
        })),
        totals: {
          inputTokens: rows.reduce((s, r) => s + r.input_tokens, 0),
          outputTokens: rows.reduce((s, r) => s + r.output_tokens, 0),
          totalTokens: rows.reduce((s, r) => s + r.total_tokens, 0),
          messageCount: rows.reduce((s, r) => s + r.msg_count, 0),
        },
      });
    } catch (e) {
      console.error(`[usage] query failed for tenant ${tenantId}:`, e);
      res.status(500).json({ error: `query failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  });

  // List tenants with basic usage stats
  app.get("/api/admin/usage/overview", requireSuperAdmin, (_req: Request, res: Response) => {
    const tenants = deps.listTenants();
    const sinceMs = Date.now() - 30 * 86400_000;
    const overview = tenants.map((tid) => {
      const db = deps.getTenantDb(tid);
      if (!db) return { tenantId: tid, totalTokens: 0, messageCount: 0 };
      try {
        const row = db.prepare<[number], { total_tokens: number; msg_count: number }>(`
          SELECT
            COALESCE(SUM(json_extract(m.content, '$.usage.totalTokens')), 0) as total_tokens,
            COUNT(*) as msg_count
          FROM messages m
          WHERE m.role = 'assistant'
            AND m.created_at > ?
            AND m.content LIKE '{%'
            AND json_valid(m.content)
            AND json_extract(m.content, '$.usage') IS NOT NULL
        `).get(sinceMs);
        return { tenantId: tid, totalTokens: row?.total_tokens ?? 0, messageCount: row?.msg_count ?? 0 };
      } catch {
        return { tenantId: tid, totalTokens: 0, messageCount: 0 };
      }
    });
    res.json({ overview, days: 30 });
  });

  // Drill-down: messages for a specific day
  app.get("/api/admin/usage/messages", requireSuperAdmin, (req: Request, res: Response) => {
    const tenantId = String(req.query.tenantId ?? req.ctx?.tenant.tenantId ?? "");
    const day = String(req.query.day ?? "");
    const userId = req.query.userId ? String(req.query.userId) : undefined;
    if (!day.match(/^\d{4}-\d{2}-\d{2}$/)) {
      res.status(400).json({ error: "day must be YYYY-MM-DD" });
      return;
    }
    const db = deps.getTenantDb(tenantId);
    if (!db) { res.status(404).json({ error: "tenant_not_found" }); return; }

    try {
      // Get all assistant messages for the day with usage
      const dayStart = new Date(day + "T00:00:00Z").getTime();
      const dayEnd = dayStart + 86400_000;
      const params: unknown[] = [dayStart, dayEnd];
      let userFilter = "";
      if (userId) {
        userFilter = " AND s.user_id = ?";
        params.push(userId);
      }

      const rows = db.prepare(`
        SELECT
          m.id as message_id,
          m.session_id,
          s.user_id,
          m.created_at,
          COALESCE(json_extract(m.content, '$.model'), 'unknown') as model,
          COALESCE(json_extract(m.content, '$.usage.input'), 0) as input_tokens,
          COALESCE(json_extract(m.content, '$.usage.output'), 0) as output_tokens,
          COALESCE(json_extract(m.content, '$.usage.totalTokens'), 0) as total_tokens,
          COALESCE(json_extract(m.content, '$.usage.cacheRead'), 0) as cache_read,
          COALESCE(json_extract(m.content, '$.usage.cacheWrite'), 0) as cache_write,
          LENGTH(m.content) as content_bytes
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        WHERE m.role = 'assistant'
          AND m.created_at >= ? AND m.created_at < ?
          AND m.content LIKE '{%' AND json_valid(m.content)
          AND json_extract(m.content, '$.usage') IS NOT NULL
          ${userFilter}
        ORDER BY m.created_at DESC
      `).all(...params) as Array<{
        message_id: string; session_id: string; user_id: string;
        created_at: number; model: string;
        input_tokens: number; output_tokens: number; total_tokens: number;
        cache_read: number; cache_write: number; content_bytes: number;
      }>;

      res.json({
        day,
        tenantId,
        messages: rows.map((r) => ({
          messageId: r.message_id,
          sessionId: r.session_id,
          userId: r.user_id,
          createdAt: r.created_at,
          model: r.model,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          totalTokens: r.total_tokens,
          cacheRead: r.cache_read,
          cacheWrite: r.cache_write,
          contentBytes: r.content_bytes,
        })),
      });
    } catch (e) {
      console.error(`[usage] messages query failed:`, e);
      res.status(500).json({ error: `query failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  });

  // Drill-down: session context around a specific message
  app.get("/api/admin/usage/message/:messageId", requireSuperAdmin, (req: Request, res: Response) => {
    const tenantId = String(req.query.tenantId ?? req.ctx?.tenant.tenantId ?? "");
    const { messageId } = req.params;
    const db = deps.getTenantDb(tenantId);
    if (!db) { res.status(404).json({ error: "tenant_not_found" }); return; }

    try {
      // Get the target message
      const target = db.prepare(`
        SELECT m.*, s.user_id
        FROM messages m JOIN sessions s ON m.session_id = s.id
        WHERE m.id = ?
      `).get(messageId) as { id: string; session_id: string; role: string; content: string; created_at: number; user_id: string } | undefined;

      if (!target) { res.status(404).json({ error: "message_not_found" }); return; }

      // Get surrounding messages in the same session (5 before, 5 after)
      const context = db.prepare(`
        SELECT id, role, created_at, LENGTH(content) as content_bytes,
          CASE 
            WHEN role = 'assistant' AND content LIKE '{%' AND json_valid(content) 
              THEN json_extract(content, '$.usage.totalTokens')
            ELSE NULL
          END as total_tokens,
          CASE
            WHEN content LIKE '{%' AND json_valid(content)
              THEN substr(json_extract(content, '$.content'), 1, 200)
            ELSE substr(content, 1, 200)
          END as preview
        FROM messages
        WHERE session_id = ?
          AND created_at BETWEEN ? - 300000 AND ? + 300000
        ORDER BY created_at
        LIMIT 20
      `).all(target.session_id, target.created_at, target.created_at) as Array<{
        id: string; role: string; created_at: number; content_bytes: number;
        total_tokens: number | null; preview: string;
      }>;

      // Parse the target message's usage
      let usage = null;
      try {
        const parsed = JSON.parse(target.content);
        usage = parsed.usage ?? null;
      } catch { /* ignore */ }

      res.json({
        messageId,
        sessionId: target.session_id,
        userId: target.user_id,
        createdAt: target.created_at,
        usage,
        contentBytes: target.content.length,
        context: context.map((r) => ({
          id: r.id,
          role: r.role,
          createdAt: r.created_at,
          contentBytes: r.content_bytes,
          totalTokens: r.total_tokens,
          preview: r.preview,
          isCurrent: r.id === messageId,
        })),
      });
    } catch (e) {
      console.error(`[usage] message detail failed:`, e);
      res.status(500).json({ error: `query failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  });
}
