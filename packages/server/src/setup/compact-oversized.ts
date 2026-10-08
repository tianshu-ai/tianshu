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

const SEGMENT_SIZE = 400;
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
    segmentSize = SEGMENT_SIZE,
    onProgress,
  } = args;
  const t0 = Date.now();

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

  // Split into segments
  const segments: MessageRow[][] = [];
  for (let i = 0; i < allRows.length; i += segmentSize) {
    segments.push(allRows.slice(i, i + segmentSize));
  }

  onProgress?.("splitting", 0, segments.length);
  console.log(`[compact-oversized] phase 2: ${allRows.length} msgs → ${segments.length} segments`);

  // Summarise each segment
  const segmentSummaries: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    onProgress?.("summarising", i + 1, segments.length);
    console.log(`[compact-oversized] summarising segment ${i + 1}/${segments.length} (${segments[i].length} msgs)`);

    const transcript = buildTranscriptFromRows(segments[i]);
    const summary = await callLlm(
      SEGMENT_SUMMARY_PROMPT,
      `Summarise this conversation segment (${segments[i].length} messages):\n\n${transcript}`,
      modelInfo,
      signal,
    );
    segmentSummaries.push(summary);
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
