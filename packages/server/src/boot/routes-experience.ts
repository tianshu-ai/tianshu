// Experience Harvester API routes — two manual steps.
//
// POST /api/experience/organise — Step 1: segment & classify → events/
// POST /api/experience/analyse  — Step 2: compare & extract  → insights/
// GET  /api/experience/status   — current state of both dirs

import type { Express, Request, Response } from "express";
import { createLogger } from "../setup/logger.js";
import { organiseEvents, analyseInsights, getHarvestStatus, getHarvestProgress, getInsightHistory, rollbackInsights } from "../chat/experience-harvester.js";
import { buildTranscript } from "../chat/compact.js";
import { loadAgentHistoryForSession } from "../chat/messages.js";
import { getDefaultModel } from "../core/index.js";

const log = createLogger("routes-experience");

export function mountExperienceRoutes(app: Express): void {

  // POST /api/experience/organise
  // Body: { sessionIds?: string[], limit?: number }
  // Step 1: segment sessions into events, save to harness2/events/
  app.post("/api/experience/organise", async (req: Request, res: Response) => {
    const rctx = req.ctx;
    if (!rctx) { res.status(401).json({ error: "auth required" }); return; }
    const ctx = rctx.tenant;
    const userId = rctx.userId;
    const { fresh = false } = (req.body ?? {}) as { fresh?: boolean };

    const modelInfo = getDefaultModel(ctx.config);
    if (!modelInfo) { res.status(500).json({ error: "no model configured" }); return; }

    // If fresh, wipe events dir first
    if (fresh) {
      const { clearEvents } = await import("../chat/experience-harvester.js");
      clearEvents(ctx.userHomeDir(userId));
    }

    // ALL sessions (active + compacted), oldest first
    const rows = ctx.db.prepare(
      `SELECT id FROM sessions
       WHERE user_id = ? AND kind = 'user' AND channel_id IS NULL
       ORDER BY created_at ASC`
    ).all(userId) as { id: string }[];
    const targetIds = rows.map(r => r.id);

    // Build transcripts
    const sessions: Array<{ sessionId: string; transcript: string }> = [];
    for (const sid of targetIds) {
      try {
        const { messages } = loadAgentHistoryForSession(ctx, sid, {
          api: modelInfo.api, provider: modelInfo.providerId, model: modelInfo.modelId,
        });
        if (messages.length > 0) {
          sessions.push({ sessionId: sid, transcript: buildTranscript(messages) });
        }
      } catch { /* skip */ }
    }

    try {
      const result = await organiseEvents({ ctx, userId, sessions, modelInfo });
      res.json({ ok: true, ...result });
    } catch (err) {
      log.error("organise failed", { error: String(err) });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/experience/analyse
  // Step 2: read events/, compare by category, write insights/
  app.post("/api/experience/analyse", async (req: Request, res: Response) => {
    const rctx = req.ctx;
    if (!rctx) { res.status(401).json({ error: "auth required" }); return; }
    const ctx = rctx.tenant;
    const userId = rctx.userId;

    const modelInfo = getDefaultModel(ctx.config);
    if (!modelInfo) { res.status(500).json({ error: "no model configured" }); return; }

    try {
      const result = await analyseInsights({ ctx, userId, modelInfo });
      res.json({ ok: true, ...result });
    } catch (err) {
      log.error("analyse failed", { error: String(err) });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/experience/status
  app.get("/api/experience/status", (req: Request, res: Response) => {
    const rctx = req.ctx;
    if (!rctx) { res.status(401).json({ error: "auth required" }); return; }
    const ctx = rctx.tenant;
    const userId = rctx.userId;
    const userHome = ctx.userHomeDir(userId);
    const progress = getHarvestProgress(userId);
    res.json({ ok: true, ...getHarvestStatus(userHome), progress });
  });

  // GET /api/experience/history
  app.get("/api/experience/history", async (req: Request, res: Response) => {
    const rctx = req.ctx;
    if (!rctx) { res.status(401).json({ error: "auth required" }); return; }
    const userHome = rctx.tenant.userHomeDir(rctx.userId);
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const history = await getInsightHistory(userHome, limit);
    res.json({ ok: true, history });
  });

  // POST /api/experience/rollback
  // Body: { oid: string }
  app.post("/api/experience/rollback", async (req: Request, res: Response) => {
    const rctx = req.ctx;
    if (!rctx) { res.status(401).json({ error: "auth required" }); return; }
    const userHome = rctx.tenant.userHomeDir(rctx.userId);
    const { oid } = (req.body ?? {}) as { oid?: string };
    if (!oid) { res.status(400).json({ error: "oid required" }); return; }
    const result = await rollbackInsights(userHome, oid);
    res.json(result);
  });

  log.info("mounted /api/experience routes");
}
