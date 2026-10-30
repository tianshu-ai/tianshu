// Experience Harvester API routes — two manual steps.
//
// POST /api/experience/organise — Step 1: segment & classify → events/
// POST /api/experience/analyse  — Step 2: compare & extract  → insights/
// GET  /api/experience/status   — current state of both dirs

import type { Express, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "../setup/logger.js";
import { organiseEvents, getHarvestStatus, getHarvestProgress, getInsightHistory, rollbackInsights, setProgress } from "../chat/experience-harvester.js";
import { resolveSessionChain } from "../chat/session-chain.js";
import { getDefaultModel } from "../core/index.js";
import { runPrompt } from "../chat/handler.js";
import type { PluginRegistry } from "../core/plugins/registry.js";
import type { ServerMsg } from "../chat/ws-protocol.js";
import type { Database } from "better-sqlite3";

const log = createLogger("routes-experience");

export function mountExperienceRoutes(app: Express, deps: { pluginRegistry: PluginRegistry }): void {
  const { pluginRegistry } = deps;

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

    // ALL sessions (active + compacted), oldest first.
    // Follow parent_id chains: a compacted chain A→B→C should be
    // merged into one transcript using the chain-head (leaf) session id.
    const rows = ctx.db.prepare(
      `SELECT id, parent_id, status FROM sessions
       WHERE user_id = ? AND kind = 'user' AND channel_id IS NULL
       ORDER BY created_at ASC`
    ).all(userId) as { id: string; parent_id: string | null; status: string }[];

    log.info("organise session scan", { totalSessions: rows.length });

    // Each session is an independent conversation segment.
    // turn_number in DB is already chain-absolute, so turns are
    // globally unique even across compacted sessions.
    //
    // Non-root sessions (with parent_id) contain seeded messages from
    // compaction (summary + tail from parent). To avoid duplicates,
    // only include messages with turn_number > parent's max turn.
    const sessions: Array<{ sessionId: string; transcript: string }> = [];
    for (const row of rows) {
      let minTurn = 0;
      if (row.parent_id) {
        // Find parent's max turn to skip seeded tail messages
        const parentMax = ctx.db.prepare<[string], { mt: number | null }>(
          `SELECT MAX(turn_number) AS mt FROM messages WHERE session_id = ?`,
        ).get(row.parent_id);
        minTurn = parentMax?.mt ?? 0;
      }
      const transcript = buildChainTranscript(ctx.db, [row.id], minTurn);
      if (transcript) {
        sessions.push({ sessionId: row.id, transcript });
      }
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
  // Step 2: run tianshu agent in a temporary session to analyse events
  app.post("/api/experience/analyse", async (req: Request, res: Response) => {
    const rctx = req.ctx;
    if (!rctx) { res.status(401).json({ error: "auth required" }); return; }
    const ctx = rctx.tenant;
    const userId = rctx.userId;
    const { fresh = false } = (req.body ?? {}) as { fresh?: boolean };

    const userHome = ctx.userHomeDir(userId);
    const eventsDir = path.join(userHome, "knowledgeBase", "harness2", "events");
    const insightsDir = path.join(userHome, "knowledgeBase", "harness2", "insights");

    if (!fs.existsSync(eventsDir)) {
      res.json({ ok: true, totalEvents: 0, rulesGenerated: 0, skipped: true, reason: "no events" });
      return;
    }

    // Fresh: clear existing insights
    if (fresh) {
      if (fs.existsSync(insightsDir)) {
        for (const f of fs.readdirSync(insightsDir).filter(f => f.endsWith(".md"))) {
          fs.unlinkSync(path.join(insightsDir, f));
        }
      }
    }

    // Load event files as context
    const eventFiles = fs.readdirSync(eventsDir).filter(f => f.endsWith(".md"));
    const eventsSummary = eventFiles.map(f => {
      try { return fs.readFileSync(path.join(eventsDir, f), "utf8"); } catch { return ""; }
    }).filter(Boolean).join("\n\n---\n\n");

    if (!eventsSummary.trim()) {
      res.json({ ok: true, totalEvents: 0, rulesGenerated: 0, skipped: true, reason: "empty events" });
      return;
    }

    // Read existing insights for iterative refinement
    const existingInsights = fs.existsSync(path.join(insightsDir, "agent-rules.md"))
      ? fs.readFileSync(path.join(insightsDir, "agent-rules.md"), "utf8") : "";

    // Create temporary session
    const tmpSessionId = `session_harvest_${randomUUID()}`;
    ctx.db.prepare(
      `INSERT INTO sessions (id, user_id, status, kind, created_at) VALUES (?, ?, 'active', 'system', ?)`,
    ).run(tmpSessionId, userId, Date.now());

    const tmpSession = {
      id: tmpSessionId,
      userId,
      parentId: null,
      status: "active" as const,
      kind: "system" as const,
      createdAt: Date.now(),
      lastModelId: null,
      title: null,
      channelId: null,
    };

    // Build the user prompt
    const userPrompt = [
      `You are analysing real work events from conversation history to optimize your own future behavior.`,
      ``,
      `Your task:`,
      `1. Read all the event files below carefully`,
      `2. Review your current skills, USER.md, and worker configs (use read_file if needed)`,
      `3. Write an improved behavioral skill to \`knowledgeBase/harness2/insights/agent-rules.md\``,
      `4. If you discover durable user preferences not yet in USER.md, write proposals to \`knowledgeBase/harness2/insights/user-md-proposals.md\``,
      ``,
      `The skill should be written as direct instructions to yourself (imperative voice).`,
      `Focus on: task delegation strategy, tool/worker choice, error recovery, efficiency.`,
      `Only include rules that would CHANGE your behavior — skip things you already do well.`,
      existingInsights ? `\n--- EXISTING INSIGHTS (refine, don't start from scratch) ---\n${existingInsights}` : "",
      ``,
      `--- EVENT FILES ---`,
      eventsSummary.slice(0, 80000), // cap to avoid blowing context
    ].join("\n");

    setProgress(userId, { step: "analyse", current: 1, total: 1, label: "agent analysing…" });

    // Collect agent output
    const ac = new AbortController();
    let assistantText = "";

    try {
      await runPrompt({
        ctx,
        userId,
        send: (msg: ServerMsg) => {
          // Collect streamed text for logging
          if (msg.type === "stream_delta" && (msg as any).text) {
            assistantText += (msg as any).text;
          }
        },
        content: userPrompt,
        signal: ac.signal,
        pluginRegistry,
        session: tmpSession,
      });

      // The agent should have written files via its tools.
      // Check if insights were generated.
      fs.mkdirSync(insightsDir, { recursive: true });
      const rulesExist = fs.existsSync(path.join(insightsDir, "agent-rules.md"));

      setProgress(userId, { step: "idle", current: 0, total: 0 });
      res.json({ ok: true, totalEvents: eventFiles.length, rulesGenerated: rulesExist ? 1 : 0, skipped: false });
    } catch (err) {
      log.error("analyse failed", { error: String(err) });
      setProgress(userId, { step: "idle", current: 0, total: 0 });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      // Clean up temporary session
      try {
        ctx.db.prepare("DELETE FROM messages WHERE session_id = ?").run(tmpSessionId);
        ctx.db.prepare("DELETE FROM sessions WHERE id = ?").run(tmpSessionId);
      } catch { /* best effort */ }
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

// ── Chain-aware transcript builder ────────────────────────────────
// Reads raw messages with turn_number directly from DB across the
// entire session chain.  turn_number is chain-absolute (set by
// session-chain.ts / migration 017), so Turn 1 = the very first
// user message in the root session.

const MAX_TOOL_RESULT_CHARS = 800;
const MAX_TRANSCRIPT_CHARS = 120_000;

interface RawRow {
  role: string;
  content: string;
  turn_number: number | null;
}

function buildChainTranscript(db: Database, chain: string[], minTurn = 0): string | null {
  if (chain.length === 0) return null;
  const placeholders = chain.map(() => "?").join(",");
  const rows = db.prepare<string[], RawRow>(
    `SELECT role, content, turn_number
     FROM messages
     WHERE session_id IN (${placeholders})
       AND turn_number IS NOT NULL AND turn_number > ${minTurn}
     ORDER BY turn_number ASC, created_at ASC`,
  ).all(...chain);

  // Skip leading compaction summary messages (from non-root forks)
  const isCompactionSummary = (content: string): boolean => {
    try {
      const j = JSON.parse(content);
      if (j.role === "assistant" && Array.isArray(j.content)) {
        const text = j.content.find((p: any) => p.type === "text");
        if (text?.text?.startsWith("[Conversation summary")) return true;
      }
    } catch { /* not JSON, check raw */ }
    return content.startsWith("[Conversation summary");
  };

  const lines: string[] = [];
  let lastTurn: number | null = null;
  let skippedSummary = false;

  for (const row of rows) {
    // Skip compaction summaries (they appear at turn boundaries after forks)
    if (!skippedSummary && row.role === "assistant" && isCompactionSummary(row.content)) {
      continue; // only skip the first one per chain; after that they're real messages
    }

    const turnLabel = row.turn_number != null ? `[Turn ${row.turn_number}] ` : "";

    let parsed: any = null;
    try { parsed = JSON.parse(row.content); } catch { /* raw text */ }

    if (row.role === "user" || parsed?.role === "user") {
      const text = extractUserText(parsed ?? row.content);
      if (text) lines.push(`### ${turnLabel}USER\n${text}`);
      skippedSummary = true; // after first real message, stop checking
    } else if (row.role === "assistant" || parsed?.role === "assistant") {
      const text = extractAssistantText(parsed ?? row.content);
      if (text) lines.push(`### ${turnLabel}ASSISTANT\n${text}`);
      skippedSummary = true;
    } else if (row.role === "tool" || parsed?.role === "toolResult") {
      const text = extractToolText(parsed ?? row.content);
      if (text) {
        const trimmed = text.length > MAX_TOOL_RESULT_CHARS
          ? text.slice(0, MAX_TOOL_RESULT_CHARS) + `\n...(+${text.length - MAX_TOOL_RESULT_CHARS} chars)`
          : text;
        lines.push(`### ${turnLabel}TOOL_RESULT\n${trimmed}`);
      }
    }
  }

  if (lines.length === 0) return null;

  const raw = lines.join("\n\n");
  if (raw.length <= MAX_TRANSCRIPT_CHARS) return raw;
  return raw.slice(0, MAX_TRANSCRIPT_CHARS) + `\n\n### [transcript truncated at ${MAX_TRANSCRIPT_CHARS} chars]`;
}

function extractUserText(parsed: any): string {
  if (typeof parsed === "string") return parsed;
  if (parsed?.content && typeof parsed.content === "string") return parsed.content;
  if (Array.isArray(parsed?.content)) {
    return parsed.content
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n");
  }
  return "";
}

function extractAssistantText(parsed: any): string {
  if (typeof parsed === "string") return parsed;
  const parts: string[] = [];
  if (Array.isArray(parsed?.content)) {
    for (const c of parsed.content) {
      if (c.type === "text" && c.text) parts.push(c.text);
      else if (c.type === "toolCall") {
        const args = JSON.stringify(c.arguments ?? {}).slice(0, 400);
        parts.push(`[tool:${c.name} args=${args}]`);
      }
    }
  }
  return parts.join("\n");
}

function extractToolText(parsed: any): string {
  if (typeof parsed === "string") return parsed;
  if (Array.isArray(parsed?.content)) {
    return parsed.content
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n");
  }
  return "";
}
