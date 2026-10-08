// Compact an oversized session in two phases:
//
// Phase 1 (instant): Multi-level SQL fork — split one huge session
//   into a chain of compacted sessions, each within the compaction
//   threshold. The final link is the new active session with tail
//   messages. Returns instantly (no LLM).
//
// Phase 2 (async): LLM summarise — walk the fork chain, summarise
//   each compacted session independently (parallel). Each session
//   gets its own compacted_summary. The active session's summary
//   message is updated to be the most recent compacted parent's
//   summary.
//
// Designed for sessions with tens of thousands of messages that
// cannot fit in a single context window.

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

const BYTES_PER_TOKEN = 4;
/** Use 70% of context window for segment input */
const CONTEXT_USAGE_RATIO = 0.7;
const KEEP_TAIL = 100;
const FALLBACK_SEGMENT_SIZE = 2000;
const CONCURRENCY = 5;

const SEGMENT_SUMMARY_PROMPT = `You are a conversation-compaction assistant. Summarise this segment of a chat between a user and an AI agent. Preserve:
- Decisions, technology choices, architecture changes
- Files created/modified (exact paths)
- Commands run and key results
- Open tasks, errors, blockers
- The user's goals and preferences

Use Markdown headings. Output ONLY the summary (no preamble). 400-800 words.
Match the conversation's language (Chinese → Chinese, English → English).`;

// ─── Types ────────────────────────────────────────────────────────

interface MessageRow {
  id: string;
  role: string;
  content: string;
  created_at: number;
}

export interface ForkResult {
  oldSessionId: string;
  /** The new active session (tail of the chain). */
  newSessionId: string;
  totalMessages: number;
  keptTail: number;
  /** Number of compacted sessions created (chain links). */
  chainLength: number;
  /** All compacted session IDs in order (oldest first). */
  compactedSessionIds: string[];
  pendingSummary: boolean;
}

export interface SummariseResult {
  oldSessionId: string;
  newSessionId: string;
  segments: number;
  /** Number successfully summarised. */
  succeeded: number;
  /** Number that failed. */
  failed: number;
  durationMs: number;
}

// ─── Phase 1: Multi-level SQL fork ───────────────────────────────

/**
 * Split a huge session into a chain of compacted sessions.
 *
 * Given a session with N messages and a target segment size S:
 *   - Creates ceil(N/S) - 1 compacted sessions + 1 active session
 *   - Each compacted session owns one segment of messages (moved, not copied)
 *   - Sessions are chained via parent_id: seg1 → seg2 → ... → active
 *   - The original session ID becomes the first compacted link
 *   - The active session gets the last `keepTail` messages (copied)
 *
 * Messages are MOVED (UPDATE session_id) not copied — no duplication.
 */
export function forkOversizedSession(args: {
  db: import("better-sqlite3").Database;
  sessionId: string;
  userId: string;
  keepTail?: number;
  /** Messages per compacted session. Auto-computed from model if omitted. */
  segmentSize?: number;
  /** Model info for auto-computing segment size. */
  modelInfo?: ResolvedModelInfo;
}): ForkResult {
  const {
    db, sessionId, userId,
    keepTail = KEEP_TAIL,
    segmentSize: explicitSegmentSize,
    modelInfo,
  } = args;

  // Load all message IDs + timestamps (lightweight — no content for sizing)
  const allMsgIds = db
    .prepare<[string], { id: string; created_at: number; content: string }>(
      `SELECT id, created_at, content FROM messages
       WHERE session_id = ? AND (entry_type IS NULL OR entry_type = 'message')
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(sessionId);

  const totalMessages = allMsgIds.length;
  if (totalMessages === 0) {
    return {
      oldSessionId: sessionId,
      newSessionId: sessionId,
      totalMessages: 0,
      keptTail: 0,
      chainLength: 0,
      compactedSessionIds: [],
      pendingSummary: false,
    };
  }

  // Clean any garbage compaction markers from earlier bugs
  db.prepare(
    `DELETE FROM messages WHERE session_id = ? AND entry_type = 'compaction'`,
  ).run(sessionId);

  // Compute segment size
  let segmentSize: number;
  if (explicitSegmentSize) {
    segmentSize = explicitSegmentSize;
  } else if (modelInfo?.contextWindow) {
    // Sample transcript to estimate realistic tokens/msg
    const sampleRows: MessageRow[] = allMsgIds.slice(0, 100).map(r => ({
      id: r.id, role: "", content: r.content, created_at: r.created_at,
    }));
    // We need role for transcript building — load it
    const sampleWithRole = db
      .prepare<[string], MessageRow>(
        `SELECT id, role, content, created_at FROM messages
         WHERE session_id = ? AND (entry_type IS NULL OR entry_type = 'message')
         ORDER BY created_at ASC, rowid ASC
         LIMIT 100`,
      )
      .all(sessionId);
    const sampleTranscript = buildTranscriptFromRows(sampleWithRole);
    const avgBytesPerMsg = sampleTranscript.length / sampleWithRole.length;
    const avgTokensPerMsg = Math.max(10, avgBytesPerMsg / BYTES_PER_TOKEN);
    const targetTokens = Math.floor(modelInfo.contextWindow * CONTEXT_USAGE_RATIO);
    segmentSize = Math.max(200, Math.floor(targetTokens / avgTokensPerMsg));
    console.log(
      `[compact-oversized] segment size: ${modelInfo.contextWindow} window × ${CONTEXT_USAGE_RATIO} ` +
      `/ ${avgTokensPerMsg.toFixed(0)} tokens/msg = ${segmentSize} msgs`,
    );
  } else {
    segmentSize = FALLBACK_SEGMENT_SIZE;
  }

  // If session fits in one segment, do simple fork (no splitting needed)
  if (totalMessages <= segmentSize + keepTail) {
    return simpleFork(db, sessionId, userId, totalMessages, keepTail);
  }

  // Split message IDs into segments
  // Last segment's messages stay in the original session (which becomes
  // the first compacted link). Earlier segments get new session IDs.
  // The active session is a fresh one at the tail.
  const msgSegments: Array<{ id: string; created_at: number }[]> = [];
  for (let i = 0; i < totalMessages; i += segmentSize) {
    msgSegments.push(allMsgIds.slice(i, i + segmentSize));
  }

  console.log(
    `[compact-oversized] splitting ${totalMessages} msgs into ${msgSegments.length} segments ` +
    `(${segmentSize} msgs each) + active tail`,
  );

  const now = Date.now();
  const compactedSessionIds: string[] = [];

  // The original session becomes the first compacted link (keeps its messages)
  // We'll create new sessions for segments 2..N and move messages into them
  // Then create the active session at the end

  // Strategy:
  // - Segment 0: stays in original session (no message moves needed)
  // - Segment 1..N-1: create new compacted sessions, move messages
  // - Active session: create new, copy tail from last segment

  // First, mark original session as compacted
  const seg0 = msgSegments[0];
  const placeholder0 = `[Pending summary — ${seg0.length} messages, segment 1/${msgSegments.length}]`;
  db.prepare<[string, number, string], unknown>(
    `UPDATE sessions SET status='compacted', compacted_summary=?, ended_at=? WHERE id=?`,
  ).run(placeholder0, now, sessionId);
  compactedSessionIds.push(sessionId);

  // Move messages from segments 1+ out of original session into new sessions
  let prevSessionId = sessionId;
  for (let segIdx = 1; segIdx < msgSegments.length; segIdx++) {
    const seg = msgSegments[segIdx];
    const newSegId = `session_${randomUUID()}`;
    const placeholder = `[Pending summary — ${seg.length} messages, segment ${segIdx + 1}/${msgSegments.length}]`;

    // Create compacted session in the chain
    db.prepare(
      `INSERT INTO sessions (id, user_id, parent_id, status, kind, created_at)
       VALUES (?, ?, ?, 'compacted', 'user', ?)`,
    ).run(newSegId, userId, prevSessionId, now + segIdx);

    db.prepare<[string, string], unknown>(
      `UPDATE sessions SET compacted_summary = ? WHERE id = ?`,
    ).run(placeholder, newSegId);

    // Move messages from original session to this new session
    const msgIds = seg.map(m => m.id);
    const placeholders = msgIds.map(() => "?").join(",");
    db.prepare(
      `UPDATE messages SET session_id = ? WHERE id IN (${placeholders})`,
    ).run(newSegId, ...msgIds);

    compactedSessionIds.push(newSegId);
    prevSessionId = newSegId;
  }

  // Create the active session (tail of chain)
  const activeSessionId = `session_${randomUUID()}`;
  db.prepare(
    `INSERT INTO sessions (id, user_id, parent_id, status, kind, created_at)
     VALUES (?, ?, ?, 'active', 'user', ?)`,
  ).run(activeSessionId, userId, prevSessionId, now + msgSegments.length);

  // Seed summary placeholder in active session (assistant role so UI renders it correctly)
  db.prepare<[string, string, string, string, number], unknown>(
    `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    `msg_${randomUUID()}`,
    activeSessionId,
    "assistant",
    `[Conversation summary — pending generation. ${totalMessages} messages split into ${msgSegments.length} compacted sessions.]`,
    now + msgSegments.length + 1,
  );

  // Copy tail messages from the last compacted segment into active session
  const lastSegSessionId = compactedSessionIds[compactedSessionIds.length - 1];
  const tailRows = db
    .prepare<[string, number], { role: string; content: string; created_at: number }>(
      `SELECT role, content, created_at FROM messages
       WHERE session_id = ? AND (entry_type IS NULL OR entry_type = 'message')
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(lastSegSessionId, keepTail);
  tailRows.reverse();

  for (const r of tailRows) {
    db.prepare<[string, string, string, string, number], unknown>(
      `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(`msg_${randomUUID()}`, activeSessionId, r.role, r.content, r.created_at);
  }

  console.log(
    `[compact-oversized] fork chain: ${compactedSessionIds.length} compacted sessions → ` +
    `${activeSessionId} (active, ${tailRows.length} tail msgs)`,
  );

  return {
    oldSessionId: sessionId,
    newSessionId: activeSessionId,
    totalMessages,
    keptTail: tailRows.length,
    chainLength: compactedSessionIds.length,
    compactedSessionIds,
    pendingSummary: true,
  };
}

/**
 * Simple fork for sessions that fit in one segment — same as before.
 */
function simpleFork(
  db: import("better-sqlite3").Database,
  sessionId: string,
  userId: string,
  totalMessages: number,
  keepTail: number,
): ForkResult {
  const placeholder = `[Pending LLM summary — ${totalMessages} messages]`;
  const now = Date.now();

  db.prepare<[string, number, string], unknown>(
    `UPDATE sessions SET status='compacted', compacted_summary=?, ended_at=? WHERE id=?`,
  ).run(placeholder, now, sessionId);

  const newSessionId = `session_${randomUUID()}`;
  db.prepare(
    `INSERT INTO sessions (id, user_id, parent_id, status, kind, created_at)
     VALUES (?, ?, ?, 'active', 'user', ?)`,
  ).run(newSessionId, userId, sessionId, now);

  db.prepare<[string, string, string, string, number], unknown>(
    `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(`msg_${randomUUID()}`, newSessionId, "assistant",
    `[Conversation summary — pending generation. ${totalMessages} messages.]`, now);

  // Copy tail
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

  return {
    oldSessionId: sessionId,
    newSessionId,
    totalMessages,
    keptTail: tailRows.length,
    chainLength: 1,
    compactedSessionIds: [sessionId],
    pendingSummary: true,
  };
}

// ─── Phase 2: LLM summarise each compacted session ───────────────

/**
 * Summarise all compacted sessions in a fork chain.
 * Each session is summarised independently (parallel where possible).
 * Updates each session's compacted_summary and the active session's
 * summary message with the most recent summary.
 */
export async function summariseForkedSession(args: {
  db: import("better-sqlite3").Database;
  oldSessionId: string;
  newSessionId: string;
  modelInfo: ResolvedModelInfo;
  signal?: AbortSignal;
  /** Explicit compacted session IDs to summarise. If omitted, walks
   *  the parent chain from newSessionId to find all compacted sessions. */
  compactedSessionIds?: string[];
  onProgress?: (stage: string, current: number, total: number) => void;
}): Promise<SummariseResult> {
  const {
    db, oldSessionId, newSessionId, modelInfo, signal,
    onProgress,
  } = args;
  const t0 = Date.now();

  // Find all compacted sessions in the chain
  const chainIds = args.compactedSessionIds ?? discoverChain(db, newSessionId);
  if (chainIds.length === 0) {
    return { oldSessionId, newSessionId, segments: 0, succeeded: 0, failed: 0, durationMs: 0 };
  }

  // Ensure checkpoint table exists
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

  // Filter: skip sessions that already have a real summary
  const toSummarise = chainIds.filter(sid => {
    const row = db
      .prepare<[string], { compacted_summary: string | null }>(
        `SELECT compacted_summary FROM sessions WHERE id = ?`,
      )
      .get(sid);
    const summary = row?.compacted_summary ?? "";
    return !summary || summary.startsWith("[Pending") || summary === "(all segments failed to summarise)";
  });

  if (toSummarise.length === 0) {
    console.log(`[compact-oversized] all ${chainIds.length} sessions already summarised`);
    return {
      oldSessionId, newSessionId,
      segments: chainIds.length, succeeded: chainIds.length, failed: 0,
      durationMs: Date.now() - t0,
    };
  }

  console.log(`[compact-oversized] summarising ${toSummarise.length} compacted sessions (${chainIds.length} total in chain)`);

  let succeeded = 0;
  let failed = 0;

  const summariseSession = async (sid: string): Promise<void> => {
    // Check if already checkpointed
    const existing = db
      .prepare<[string], { summary: string }>(
        `SELECT summary FROM segment_summaries WHERE session_id = ? AND segment_index = 0`,
      )
      .get(sid);
    if (existing?.summary) {
      // Already done — just write it to the session
      db.prepare<[string, string], unknown>(
        `UPDATE sessions SET compacted_summary = ? WHERE id = ?`,
      ).run(existing.summary, sid);
      db.prepare(`DELETE FROM segment_summaries WHERE session_id = ?`).run(sid);
      succeeded++;
      console.log(`[compact-oversized] ${sid.slice(0, 20)}... restored from checkpoint`);
      return;
    }

    // Load messages for this session
    const rows = db
      .prepare<[string], MessageRow>(
        `SELECT id, role, content, created_at FROM messages
         WHERE session_id = ? AND (entry_type IS NULL OR entry_type = 'message')
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(sid);

    if (rows.length === 0) {
      db.prepare<[string, string], unknown>(
        `UPDATE sessions SET compacted_summary = ? WHERE id = ?`,
      ).run("(empty session)", sid);
      succeeded++;
      return;
    }

    const transcript = buildTranscriptFromRows(rows);
    console.log(
      `[compact-oversized] summarising ${sid.slice(0, 20)}... ` +
      `(${rows.length} msgs, ${(transcript.length / 1024).toFixed(0)}KB transcript)`,
    );

    const MAX_RETRIES = 2;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const summary = await callLlm(
          SEGMENT_SUMMARY_PROMPT,
          `Summarise this conversation segment (${rows.length} messages):\n\n${transcript}`,
          modelInfo,
          signal,
        );

        // Checkpoint
        db.prepare(
          `INSERT OR REPLACE INTO segment_summaries
            (session_id, segment_index, total_segments, summary, created_at)
            VALUES (?, 0, 1, ?, ?)`,
        ).run(sid, summary, Date.now());

        // Write to session
        db.prepare<[string, string], unknown>(
          `UPDATE sessions SET compacted_summary = ? WHERE id = ?`,
        ).run(summary, sid);

        // Clean checkpoint
        db.prepare(`DELETE FROM segment_summaries WHERE session_id = ?`).run(sid);

        succeeded++;
        console.log(`[compact-oversized] ${sid.slice(0, 20)}... done (${rows.length} msgs)`);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_RETRIES) {
          console.warn(`[compact-oversized] ${sid.slice(0, 20)}... attempt ${attempt} failed: ${msg}`);
        } else {
          console.error(`[compact-oversized] ${sid.slice(0, 20)}... failed: ${msg}`);
          failed++;
        }
      }
    }
  };

  // Process in batches of CONCURRENCY
  for (let i = 0; i < toSummarise.length; i += CONCURRENCY) {
    const batch = toSummarise.slice(i, i + CONCURRENCY);
    const batchNum = Math.floor(i / CONCURRENCY) + 1;
    console.log(`[compact-oversized] batch ${batchNum}: ${batch.length} sessions`);
    onProgress?.("summarising", i, toSummarise.length);
    await Promise.allSettled(batch.map(sid => summariseSession(sid)));
  }

  // Update the active session's summary message with the last compacted session's summary
  const lastCompactedId = chainIds[chainIds.length - 1];
  const lastSummaryRow = db
    .prepare<[string], { compacted_summary: string | null }>(
      `SELECT compacted_summary FROM sessions WHERE id = ?`,
    )
    .get(lastCompactedId);
  const lastSummary = lastSummaryRow?.compacted_summary ?? "(summary unavailable)";

  const summaryMsgRow = db
    .prepare<[string], { id: string } | undefined>(
      `SELECT id FROM messages
       WHERE session_id = ? AND role = 'assistant' AND content LIKE '%[Conversation summary%'
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(newSessionId);

  if (summaryMsgRow) {
    db.prepare<[string, string], unknown>(
      `UPDATE messages SET content = ? WHERE id = ?`,
    ).run(
      `[Conversation summary — ${chainIds.length} compacted sessions, generated at ${new Date().toISOString()}]\n\n${lastSummary}`,
      summaryMsgRow.id,
    );
  }

  const durationMs = Date.now() - t0;
  console.log(
    `[compact-oversized] summarise done: ${succeeded} succeeded, ${failed} failed, ${durationMs}ms`,
  );

  return {
    oldSessionId,
    newSessionId,
    segments: toSummarise.length,
    succeeded,
    failed,
    durationMs,
  };
}

/**
 * Walk parent chain from activeSessionId to discover compacted sessions.
 * Returns compacted session IDs in root-first order.
 */
function discoverChain(
  db: import("better-sqlite3").Database,
  activeSessionId: string,
): string[] {
  const chain: string[] = [];
  let current = activeSessionId;
  const MAX_DEPTH = 200;

  // Walk up parent chain
  while (chain.length < MAX_DEPTH) {
    const row = db
      .prepare<[string], { parent_id: string | null; status: string }>(
        `SELECT parent_id, status FROM sessions WHERE id = ?`,
      )
      .get(current);
    if (!row?.parent_id) break;
    current = row.parent_id;

    // Only include compacted sessions (skip archived etc)
    const parentRow = db
      .prepare<[string], { status: string }>(
        `SELECT status FROM sessions WHERE id = ?`,
      )
      .get(current);
    if (parentRow?.status === "compacted") {
      chain.push(current);
    }
  }

  chain.reverse(); // root-first
  return chain;
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
    segmentSize,
    modelInfo,
  });

  const summary = await summariseForkedSession({
    db: ctx.db,
    oldSessionId: fork.oldSessionId,
    newSessionId: fork.newSessionId,
    modelInfo,
    signal,
    compactedSessionIds: fork.compactedSessionIds,
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
