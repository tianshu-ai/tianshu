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
          AND json_extract(m.content, '$.usage') IS NOT NULL
        GROUP BY s.user_id, json_extract(m.content, '$.model')
        ORDER BY total_tokens DESC
      `).all(sinceMs);

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

      res.json({
        tenantId,
        days,
        byUserModel: rows.map((r) => ({
          userId: r.user_id,
          model: r.model,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          totalTokens: r.total_tokens,
          messageCount: r.msg_count,
        })),
        byUser: Array.from(userTotals.entries()).map(([userId, t]) => ({
          userId,
          ...t,
        })).sort((a, b) => b.total - a.total),
        totals: {
          inputTokens: rows.reduce((s, r) => s + r.input_tokens, 0),
          outputTokens: rows.reduce((s, r) => s + r.output_tokens, 0),
          totalTokens: rows.reduce((s, r) => s + r.total_tokens, 0),
          messageCount: rows.reduce((s, r) => s + r.msg_count, 0),
        },
      });
    } catch (e) {
      res.status(500).json({ error: `query failed: ${e}` });
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
            AND json_extract(m.content, '$.usage') IS NOT NULL
        `).get(sinceMs);
        return { tenantId: tid, totalTokens: row?.total_tokens ?? 0, messageCount: row?.msg_count ?? 0 };
      } catch {
        return { tenantId: tid, totalTokens: 0, messageCount: 0 };
      }
    });
    res.json({ overview, days: 30 });
  });
}
