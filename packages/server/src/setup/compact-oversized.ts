// Compact an oversized session in two phases:
//
// Phase 1 (instant): SQL fork — new session gets last N messages,
//   old session marked compacted with placeholder summary.
//   Session is immediately usable.
//
// Phase 2 (async): LLM summarise — split old messages into segments,
//   summarise each, merge into final summary, update the placeholder.
//
// Designed for sessions with thousands of messages that cannot
// be summarised in a single LLM call.

import { randomUUID } from "node:crypto";
import type { TextContent } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { TenantContext } from "../core/index.js";
import {
  buildModel,
  resolveApiKey,
  type ResolvedModelInfo,
} from "../core/index.js";
import { appendMessage, type ChatSession } from "../chat/messages.js";

// ─── Constants ────────────────────────────────────────────────────

/**
 * Fallback segment size when model context window is unknown.
 * Actual segment size is computed from the model's context window:
 * each segment targets ~70% of the context window in estimated tokens,
 * leaving room for the system prompt and output.
 */
const FALLBACK_SEGMENT_SIZE = 2000;
const BYTES_PER_TOKEN = 4;
/** Use 70% of context window for input; 30% for system prompt + output */
const CONTEXT_USAGE_RATIO = 0.7;
const KEEP_TAIL = 100;

const SEGMENT_SUMMARY_PROMPT = `You are a conversation-compaction assistant. Summarise this segment of a chat between a user and an AI agent. Preserve:
- Decisions, technology choices, architecture changes
- Files created/modified (exact paths)
- Commands run and key results
- Open tasks, errors, blockers
- The user's goals and preferences

Use Markdown headings. Output ONLY the summary (no preamble). 400-800 words.
Match the conversation's language (Chinese → Chinese, English → English).`;

const MERGE_SUMMARY_PROMPT = `You are a conversation-compaction assistant. Below are summaries of consecutive conversation segments, oldest first. Merge them into ONE cohesive structured summary that a fresh agent can use to continue seamlessly.

Requirements:
1. Address the next agent in second person ("you previously …")
2. Preserve all decisions, file paths, commands, errors, open tasks
3. Use Markdown headings: ## Goal / ## Decisions / ## Files / ## Progress / ## Caveats / ## Current State
4. Deduplicate — later segments supersede earlier ones on the same topic
5. 600-1500 words
6. Match the original conversation's language`;

// ─── Types ────────────────────────────────────────────────────────

interface MessageRow {
  id: string;
  role: string;
  content: string;
  created_at: number;
}

export interface ForkResult {
  oldSessionId: string;
  newSessionId: string;
  totalMessages: number;
  keptTail: number;
  /** True = placeholder summary, needs phase 2. */
  pendingSummary: boolean;
}

export interface SummariseResult {
  oldSessionId: string;
  newSessionId: string;
  segments: number;
  summary: string;
  durationMs: number;
}

// ─── Phase 1: Instant SQL fork ────────────────────────────────────

/**
 * Fork a session immediately — no LLM call. The new session gets
 * the most recent `keepTail` messages; the old session is marked
 * compacted with a placeholder summary. Returns instantly.
 */
export function forkOversizedSession(args: {
  db: import("better-sqlite3").Database;
  sessionId: string;
  userId: string;
  keepTail?: number;
}): ForkResult {
  const { db, sessionId, userId, keepTail = KEEP_TAIL } = args;

  // Count messages
  const countRow = db
    .prepare<[string], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM messages
       WHERE session_id = ? AND (entry_type IS NULL OR entry_type = 'message')`,
    )
    .get(sessionId);
  const totalMessages = countRow?.cnt ?? 0;

  // Clean any garbage compaction markers from earlier bugs
  db.prepare(
    `DELETE FROM messages WHERE session_id = ? AND entry_type = 'compaction'`,
  ).run(sessionId);

  // Mark old session compacted
  const placeholder = `[Pending LLM summary — ${totalMessages} messages, forked at ${new Date().toISOString()}. Use compact_session phase 2 to generate real summary.]`;
  db.prepare<[string, number, string], unknown>(
    `UPDATE sessions SET status='compacted', compacted_summary=?, ended_at=? WHERE id=?`,
  ).run(placeholder, Date.now(), sessionId);

  // Create new session
  const newSessionId = `session_${randomUUID()}`;
  const now = Date.now();
  db.prepare<[string, string, string, string, string, number], unknown>(
    `INSERT INTO sessions (id, user_id, parent_id, status, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(newSessionId, userId, sessionId, "active", "user", now);

  // Seed: placeholder summary + ack
  db.prepare<[string, string, string, string, number], unknown>(
    `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    `msg_${randomUUID()}`,
    newSessionId,
    "user",
    `[Conversation summary — pending generation]\n\n${placeholder}`,
    now,
  );
  db.prepare<[string, string, string, string, number], unknown>(
    `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    `msg_${randomUUID()}`,
    newSessionId,
    "assistant",
    "Understood — I have the prior context and will continue from where we left off.",
    now + 1,
  );

  // Copy tail messages
  const tailRows = db
    .prepare<[string, number], { role: string; content: string; created_at: number }>(
      `SELECT role, content, created_at FROM messages
       WHERE session_id = ? AND (entry_type IS NULL OR entry_type = 'message')
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(sessionId, keepTail);
  tailRows.reverse();

  for (const r of tailRows) {
    db.prepare<[string, string, string, string, number], unknown>(
      `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(`msg_${randomUUID()}`, newSessionId, r.role, r.content, r.created_at);
  }

  console.log(`[compact-oversized] phase 1 fork: old=${sessionId} new=${newSessionId} (${totalMessages} msgs → ${tailRows.length} tail)`);

  return {
    oldSessionId: sessionId,
    newSessionId,
    totalMessages,
    keptTail: tailRows.length,
    pendingSummary: true,
  };
}

// ─── Phase 2: LLM summarise + update ─────────────────────────────

/**
 * Generate a real summary for a previously-forked session.
 * Reads old session messages, splits into segments, summarises
 * each, merges, and updates both the old session's
 * compacted_summary and the new session's summary message.
 */
export async function summariseForkedSession(args: {
  db: import("better-sqlite3").Database;
  oldSessionId: string;
  newSessionId: string;
  modelInfo: ResolvedModelInfo;
  signal?: AbortSignal;
  segmentSize?: number;
  onProgress?: (stage: string, current: number, total: number) => void;
}): Promise<SummariseResult> {
  const {
    db, oldSessionId, newSessionId, modelInfo, signal,
    segmentSize: explicitSegmentSize,
    onProgress,
  } = args;
  const t0 = Date.now();

  // Compute segment size from model context window if not explicitly set
  let segmentSize: number;
  if (explicitSegmentSize) {
    segmentSize = explicitSegmentSize;
  } else if (modelInfo.contextWindow) {
    // Target tokens per segment = 70% of context window
    const targetTokensPerSegment = Math.floor(modelInfo.contextWindow * CONTEXT_USAGE_RATIO);
    // Estimate average tokens per message from the session content
    // We'll refine after loading messages, but need a rough estimate for planning
    // Average message ~200 bytes → ~50 tokens
    const avgTokensPerMsg = 50;
    segmentSize = Math.max(100, Math.floor(targetTokensPerSegment / avgTokensPerMsg));
    console.log(`[compact-oversized] segment size from context window: ${modelInfo.contextWindow} tokens × ${CONTEXT_USAGE_RATIO} / ~${avgTokensPerMsg} tokens/msg ≈ ${segmentSize} msgs`);
  } else {
    segmentSize = FALLBACK_SEGMENT_SIZE;
    console.log(`[compact-oversized] no context window, using fallback segment size: ${segmentSize}`);
  }

  // Load old session messages (excluding the tail that was already copied)
  const allRows: MessageRow[] = db
    .prepare<[string], MessageRow>(
      `SELECT id, role, content, created_at FROM messages
       WHERE session_id = ? AND (entry_type IS NULL OR entry_type = 'message')
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(oldSessionId);

  if (allRows.length === 0) {
    return {
      oldSessionId,
      newSessionId,
      segments: 0,
      summary: "(empty session)",
      durationMs: Date.now() - t0,
    };
  }

  // Refine segment size using actual message content bytes
  if (!explicitSegmentSize && modelInfo.contextWindow) {
    const totalBytes = allRows.reduce((sum, r) => sum + (r.content?.length ?? 0), 0);
    const avgBytesPerMsg = totalBytes / allRows.length;
    const avgTokensPerMsg = Math.max(10, avgBytesPerMsg / BYTES_PER_TOKEN);
    const targetTokens = Math.floor(modelInfo.contextWindow * CONTEXT_USAGE_RATIO);
    segmentSize = Math.max(100, Math.floor(targetTokens / avgTokensPerMsg));
    console.log(`[compact-oversized] refined: avg ${avgBytesPerMsg.toFixed(0)} bytes/msg ≈ ${avgTokensPerMsg.toFixed(0)} tokens/msg → segment size ${segmentSize}`);
  }

  // Split into segments
  const segments: MessageRow[][] = [];
  for (let i = 0; i < allRows.length; i += segmentSize) {
    segments.push(allRows.slice(i, i + segmentSize));
  }

  onProgress?.("splitting", 0, segments.length);
  console.log(`[compact-oversized] phase 2: ${allRows.length} msgs → ${segments.length} segments`);

  // Ensure segment_summaries table exists for checkpoint/resume
  db.exec(`
    CREATE TABLE IF NOT EXISTS segment_summaries (
      session_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      total_segments INTEGER NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, segment_index)
    )
  `);

  // Load any previously completed segment summaries (resume support)
  const existingRows = db
    .prepare<[string], { segment_index: number; summary: string }>(
      `SELECT segment_index, summary FROM segment_summaries
       WHERE session_id = ? ORDER BY segment_index`,
    )
    .all(oldSessionId);
  const existingMap = new Map(existingRows.map(r => [r.segment_index, r.summary]));
  if (existingMap.size > 0) {
    console.log(`[compact-oversized] resuming: ${existingMap.size}/${segments.length} segments already done`);
  }

  // Summarise each segment (skip already-completed ones)
  const segmentSummaries: string[] = new Array(segments.length).fill("");
  // Fill in existing
  for (const [idx, sum] of existingMap) {
    if (idx < segments.length) segmentSummaries[idx] = sum;
  }

  // Parallel summarisation — run up to CONCURRENCY segments at once
  const CONCURRENCY = 5;
  const pending = segments
    .map((_, i) => i)
    .filter(i => !segmentSummaries[i]);

  let completed = existingMap.size;
  const total = segments.length;

  const summariseOne = async (i: number): Promise<void> => {
    const transcript = buildTranscriptFromRows(segments[i]);
    const summary = await callLlm(
      SEGMENT_SUMMARY_PROMPT,
      `Summarise this conversation segment (${segments[i].length} messages):\n\n${transcript}`,
      modelInfo,
      signal,
    );
    segmentSummaries[i] = summary;
    completed++;

    // Checkpoint: persist to DB so we can resume after interruption
    db.prepare(
      `INSERT OR REPLACE INTO segment_summaries
        (session_id, segment_index, total_segments, summary, created_at)
        VALUES (?, ?, ?, ?, ?)`,
    ).run(oldSessionId, i, segments.length, summary, Date.now());
    console.log(`[compact-oversized] segment ${i + 1}/${total} done (${completed}/${total})`);
    onProgress?.("summarising", completed, total);
  };

  // Process in batches of CONCURRENCY
  for (let batchStart = 0; batchStart < pending.length; batchStart += CONCURRENCY) {
    const batch = pending.slice(batchStart, batchStart + CONCURRENCY);
    console.log(`[compact-oversized] batch ${Math.floor(batchStart / CONCURRENCY) + 1}: segments [${batch.map(i => i + 1).join(", ")}]`);
    await Promise.all(batch.map(i => summariseOne(i)));
  }

  // Merge
  onProgress?.("merging", 0, 1);
  let finalSummary: string;
  if (segmentSummaries.length === 1) {
    finalSummary = segmentSummaries[0];
  } else {
    const mergeInput = segmentSummaries
      .map((s, i) => `## Segment ${i + 1}\n\n${s}`)
      .join("\n\n---\n\n");
    finalSummary = await callLlm(
      MERGE_SUMMARY_PROMPT,
      `Merge these ${segmentSummaries.length} segment summaries into one:\n\n${mergeInput}`,
      modelInfo,
      signal,
    );
  }

  // Clean up checkpoint data now that merge is done
  db.prepare(`DELETE FROM segment_summaries WHERE session_id = ?`).run(oldSessionId);

  // Update old session's compacted_summary
  db.prepare<[string, string], unknown>(
    `UPDATE sessions SET compacted_summary = ? WHERE id = ?`,
  ).run(finalSummary, oldSessionId);

  // Update the placeholder summary message in the new session
  const summaryMsgRow = db
    .prepare<[string], { id: string } | undefined>(
      `SELECT id FROM messages
       WHERE session_id = ? AND role = 'user' AND content LIKE '%[Conversation summary%'
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(newSessionId);

  if (summaryMsgRow) {
    db.prepare<[string, string], unknown>(
      `UPDATE messages SET content = ? WHERE id = ?`,
    ).run(
      `[Conversation summary — generated at ${new Date().toISOString()}]\n\n${finalSummary}`,
      summaryMsgRow.id,
    );
  }

  const durationMs = Date.now() - t0;
  console.log(`[compact-oversized] phase 2 done: ${segments.length} segments, ${durationMs}ms`);

  return {
    oldSessionId,
    newSessionId,
    segments: segments.length,
    summary: finalSummary,
    durationMs,
  };
}

// ─── Convenience: both phases in one call ─────────────────────────

export async function compactOversizedSession(args: {
  ctx: TenantContext;
  userId: string;
  session: ChatSession;
  modelInfo: ResolvedModelInfo;
  signal?: AbortSignal;
  segmentSize?: number;
  keepTail?: number;
  onProgress?: (stage: string, current: number, total: number) => void;
}): Promise<ForkResult & SummariseResult> {
  const { ctx, userId, session, modelInfo, signal, segmentSize, keepTail, onProgress } = args;

  const fork = forkOversizedSession({
    db: ctx.db,
    sessionId: session.id,
    userId,
    keepTail,
  });

  const summary = await summariseForkedSession({
    db: ctx.db,
    oldSessionId: fork.oldSessionId,
    newSessionId: fork.newSessionId,
    modelInfo,
    signal,
    segmentSize,
    onProgress,
  });

  return { ...fork, ...summary, pendingSummary: false };
}

// ─── Helpers ──────────────────────────────────────────────────────

function buildTranscriptFromRows(rows: MessageRow[]): string {
  const lines: string[] = [];
  for (const r of rows) {
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(r.content); } catch { /* plain text */ }

    if (r.role === "user") {
      const text = extractText(parsed, r.content);
      if (text) lines.push(`### USER\n${text}`);
    } else if (r.role === "assistant") {
      const parts: string[] = [];
      if (parsed && Array.isArray(parsed.content)) {
        for (const c of parsed.content as Array<Record<string, unknown>>) {
          if (c.type === "text" && typeof c.text === "string") {
            parts.push(c.text);
          } else if (c.type === "toolCall" || c.type === "tool_use") {
            const args = JSON.stringify(c.arguments ?? {}).slice(0, 300);
            parts.push(`[tool:${c.name} args=${args}]`);
          }
        }
      } else {
        const text = extractText(parsed, r.content);
        if (text) parts.push(text);
      }
      if (parts.length > 0) lines.push(`### ASSISTANT\n${parts.join("\n")}`);
    } else if (r.role === "tool") {
      const text = extractText(parsed, r.content);
      if (text) {
        const trimmed = text.length > 500
          ? text.slice(0, 500) + `\n...(+${text.length - 500} chars)`
          : text;
        lines.push(`### TOOL_RESULT\n${trimmed}`);
      }
    }
  }
  return lines.join("\n\n");
}

function extractText(parsed: Record<string, unknown> | null, raw: string): string {
  if (!parsed) return raw;
  if (typeof parsed.content === "string") return parsed.content;
  if (Array.isArray(parsed.content)) {
    return (parsed.content as Array<Record<string, unknown>>)
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
  }
  return raw;
}

async function callLlm(
  systemPrompt: string,
  userMessage: string,
  modelInfo: ResolvedModelInfo,
  signal?: AbortSignal,
): Promise<string> {
  const model = buildModel(modelInfo);
  const apiKey = resolveApiKey(modelInfo);
  const result = await completeSimple(
    model,
    {
      systemPrompt,
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text", text: userMessage } as TextContent],
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey, signal, maxRetries: 2 },
  );
  const text = (result as any)?.content
    ?.filter?.((c: any) => c.type === "text")
    ?.map?.((c: any) => c.text)
    ?.join?.("\n");
  return text || "(summary generation failed)";
}
