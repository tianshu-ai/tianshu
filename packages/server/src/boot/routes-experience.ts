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

    // Time-based cutoff: event files are named <sessionSlug>-<cutoffMs>.md.
    // Read the max cutoff from existing filenames to know where we left off.
    const eventsDir = path.join(ctx.userHomeDir(userId), "knowledgeBase", "harness2", "events");
    let lastOrganiseCutoff = 0;
    if (fs.existsSync(eventsDir)) {
      for (const f of fs.readdirSync(eventsDir).filter(f => f.endsWith(".md"))) {
        const m = f.match(/-(\d{13,})\.md$/);
        if (m) lastOrganiseCutoff = Math.max(lastOrganiseCutoff, Number(m[1]));
      }
    }
    const cutoffMs = Date.now();

    const rows = ctx.db.prepare(
      `SELECT id, parent_id, status FROM sessions
       WHERE user_id = ? AND kind = 'user' AND channel_id IS NULL
       ORDER BY created_at ASC`
    ).all(userId) as { id: string; parent_id: string | null; status: string }[];

    log.info("organise session scan", { totalSessions: rows.length, cutoffMs });

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
      const transcript = buildChainTranscript(ctx.db, [row.id], minTurn, cutoffMs, lastOrganiseCutoff);
      if (transcript) {
        sessions.push({ sessionId: row.id, transcript });
      }
    }

    try {
      const result = await organiseEvents({ ctx, userId, sessions, modelInfo, cutoffMs });
      res.json({ ok: true, ...result, cutoffMs });
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

    // List event files — agent will read them via read_file
    const eventFiles = fs.readdirSync(eventsDir).filter(f => f.endsWith(".md"));
    if (eventFiles.length === 0) {
      res.json({ ok: true, totalEvents: 0, rulesGenerated: 0, skipped: true, reason: "no events" });
      return;
    }

    // Find last analysis cutoff from changelog filenames (changelog-<epoch>.md)
    let lastCutoff = 0;
    if (fs.existsSync(insightsDir)) {
      const changelogs = fs.readdirSync(insightsDir)
        .filter(f => f.startsWith("changelog-") && f.endsWith(".md"));
      for (const f of changelogs) {
        const m = f.match(/^changelog-(\d+)\.md$/);
        if (m) lastCutoff = Math.max(lastCutoff, Number(m[1]));
      }
    }

    // Filter events: only include files modified after the last cutoff
    const cutoffMs = lastCutoff;
    const newEventFiles = eventFiles.filter(f => {
      try {
        return fs.statSync(path.join(eventsDir, f)).mtimeMs > cutoffMs;
      } catch { return true; }
    });

    if (newEventFiles.length === 0) {
      res.json({ ok: true, totalEvents: 0, rulesGenerated: 0, skipped: true, reason: "no new events since last analysis" });
      return;
    }

    const eventFileList = newEventFiles.map(f => `- knowledgeBase/harness2/events/${f}`).join("\n");
    const nowTs = Date.now();

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
      `You are reviewing your own work history to improve your skills, user profile, and worker configuration.`,
      ``,
      `This is an INCREMENTAL review. ${lastCutoff
        ? `Previous analysis was done on ${new Date(lastCutoff).toISOString()}. Skills and USER.md were already updated based on events before that time. Focus ONLY on the new event files listed below — do not re-review patterns already addressed in previous changelogs.`
        : `This is the first analysis — review all events.`
      }`,
      ``,
      `Below are event files from real sessions. Your job is NOT to list app improvements or tool tips.`,
      `Instead, do the following:`,
      ``,
      `## Step 1: Review each of your skills`,
      `Use read_file to read each of your SKILL.md files one by one.`,
      `For each skill, check against the events:`,
      `- Does this skill already cover the patterns seen in events? If yes, skip it.`,
      `- Could this skill be improved based on failure patterns in the events?`,
      `- Are there missing instructions that would have prevented observed mistakes?`,
      `If a skill needs changes, write the improved version using write_file.`,
      ``,
      `## Step 2: Check if new skills are needed`,
      `Are there recurring patterns in the events that no existing skill covers?`,
      `If yes, create a new skill file under the tenant skills directory.`,
      ``,
      `## Step 3: Review USER.md`,
      `Use read_file to read the current USER.md.`,
      `Are there durable user preferences revealed by the events that aren't captured yet?`,
      `(e.g., preferred communication style, tool preferences, workflow habits)`,
      `If yes, use edit_file to add them to USER.md.`,
      ``,
      `## Step 4: Review worker configs`,
      `Check if any worker's toolsAllow or SOUL.md should be adjusted based on observed failures.`,
      `(e.g., a worker that failed because it lacked a required tool)`,
      ``,
      `## Step 5: Write a summary`,
      `APPEND (do not overwrite) a new section to \`knowledgeBase/harness2/insights/changelog.md\`.`,
      `Write the summary to \`knowledgeBase/harness2/insights/changelog-${nowTs}.md\`.`,
      `This filename's timestamp marks the cutoff — future runs will only review events newer than this.`,
      ``,
      `IMPORTANT:`,
      `- Do NOT write generic "behavioral rules" or "app usage tips" — those belong in skills.`,
      `- BIAS TOWARD ACTION: if you find a pattern, write it into a skill. A dedicated skill is more precise`,
      `  and maintainable than relying on the system prompt to "probably cover it".`,
      `- "System prompt already covers this" is NOT a reason to skip. Skills are more targeted than system prompts.`,
      `  If a pattern caused a real mistake or inefficiency, it deserves its own skill rule.`,
      `- Create new skills for recurring patterns even if they seem minor — minor patterns compound.`,
      `- Fix dead references, stale configs, and missing tool permissions directly — don't defer to "future pass".`,
      `- Review worker SOUL.md content, not just toolsAllow lists.`,
      existingInsights ? `\n--- PREVIOUS CHANGELOG ---\n${existingInsights}` : "",
      ``,
      `## Event files to review (use read_file for each):`,
      eventFileList,
      ``,
      `Read each event file carefully before making any conclusions.`,
      `Some files are large — focus on the event summaries and turn transcripts that show problems.`,
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

function buildChainTranscript(db: Database, chain: string[], minTurn = 0, beforeMs?: number, afterMs?: number): string | null {
  if (chain.length === 0) return null;
  const placeholders = chain.map(() => "?").join(",");
  const timeCond = (beforeMs != null ? ` AND created_at < ${beforeMs}` : "")
    + (afterMs ? ` AND created_at >= ${afterMs}` : "");
  const rows = db.prepare<string[], RawRow>(
    `SELECT role, content, turn_number
     FROM messages
     WHERE session_id IN (${placeholders})
       AND turn_number IS NOT NULL AND turn_number > ${minTurn}${timeCond}
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
