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
const KEEP_TAIL_DEFAULT = 100;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const FALLBACK_SEGMENT_SIZE = 2000;
const CONCURRENCY = 5;

/**
 * Snap a tail message array to a complete turn boundary.
 * Drops leading messages until we hit a `user` role message,
 * so the tail always starts at a turn boundary (user → assistant →
 * toolResult → ... → user → ...). This prevents orphaned tool
 * results from a half-cut assistant turn.
 *
 * If no user message is found, returns the original array (better to
 * keep something than nothing).
 */
function snapToTurnBoundary(rows: Array<{ role: string; content: string; created_at: number }>): typeof rows {
  const firstUserIdx = rows.findIndex(r => r.role === "user");
  if (firstUserIdx <= 0) return rows; // already starts at user, or no user at all
  return rows.slice(firstUserIdx);
}

const SEGMENT_SUMMARY_PROMPT = `You are compacting one segment of a conversation. This segment is part of a larger conversation chain.

Output ONE markdown document using the exact sections below. No preface, no commentary. Match the conversation's language. Never invent facts.

## Decisions
- <Decision made and reasoning, one per line, with exact identifiers>

## Open TODOs
- [ ] <Incomplete task with context to resume>

## Constraints/Rules
- <Established rule or convention>

## Exact identifiers
- **<label>**: \`<value>\` (file paths, commits, versions, server addresses)

## Recall anchors
- **<topic>** (turns A-B): \`recall_range(A, B)\` — <what's there>

Rules:
- Every section is REQUIRED. Use "(none)" if empty.
- Focus on durable facts. Prefer verbatim identifiers.
- Do NOT continue the conversation or address the user.`;

const MERGE_SUMMARY_PROMPT = `You are merging per-segment conversation summaries into one cohesive summary.

Output ONE markdown document using these exact sections:

## Latest user request context
## Decisions
## Open TODOs
## Constraints/Rules
## Pending user asks
## Exact identifiers
## Recall anchors

Rules:
- Deduplicate overlapping facts but NEVER drop a recall anchor.
- Merge Open TODOs: mark completed items [x], keep open items [ ].
- Collect ALL exact identifiers across segments.
- "Latest user request context" comes from the LAST segment only.
- Match the conversation's language. Output ONLY the merged summary.`;

// ─── Types ────────────────────────────────────────────────────────

interface MessageRow {
  id: string;
  role: string;
  content: string;
  created_at: number;
  turn_number: number | null;
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
  /** Token budget for tail messages. Read from models.compaction.keepRecentTokens.
   *  When omitted, defaults to 20 000. Used to auto-compute keepTail when
   *  keepTail is not explicitly provided. */
  keepRecentTokens?: number;
  /** Messages per compacted session. Auto-computed from model if omitted. */
  segmentSize?: number;
  /** Model info for auto-computing segment size. */
  modelInfo?: ResolvedModelInfo;
}): ForkResult {
  const {
    db, sessionId, userId,
    keepTail: explicitKeepTail,
    keepRecentTokens = DEFAULT_KEEP_RECENT_TOKENS,
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

  // Compute segment size and keepTail.
  // Sample recent messages to estimate avg tokens/msg, then size the
  // tail so it stays within KEEP_TAIL_TOKENS (~20K tokens default).
  let segmentSize: number;
  let keepTail: number;

  // Sample transcript to estimate realistic tokens/msg
  const sampleWithRole = db
    .prepare<[string], MessageRow>(
      `SELECT id, role, content, created_at, turn_number FROM messages
       WHERE session_id = ? AND (entry_type IS NULL OR entry_type = 'message')
       ORDER BY created_at ASC, rowid ASC
       LIMIT 100`,
    )
    .all(sessionId);
  const { transcript: sampleTranscript } = buildTranscriptFromRows(sampleWithRole);
  const avgBytesPerMsg = sampleWithRole.length > 0
    ? sampleTranscript.length / sampleWithRole.length
    : 200;
  const avgTokensPerMsg = Math.max(10, avgBytesPerMsg / BYTES_PER_TOKEN);

  if (explicitSegmentSize) {
    segmentSize = explicitSegmentSize;
  } else if (modelInfo?.contextWindow) {
    const targetTokens = Math.floor(modelInfo.contextWindow * CONTEXT_USAGE_RATIO);
    segmentSize = Math.max(200, Math.floor(targetTokens / avgTokensPerMsg));
    console.log(
      `[compact-oversized] segment size: ${modelInfo.contextWindow} window × ${CONTEXT_USAGE_RATIO} ` +
      `/ ${avgTokensPerMsg.toFixed(0)} tokens/msg = ${segmentSize} msgs`,
    );
  } else {
    segmentSize = FALLBACK_SEGMENT_SIZE;
  }

  // keepTail: explicit > token-based estimate from keepRecentTokens > default
  if (explicitKeepTail != null) {
    keepTail = explicitKeepTail;
  } else {
    // Size tail to fit within keepRecentTokens budget
    keepTail = Math.max(10, Math.min(KEEP_TAIL_DEFAULT, Math.floor(keepRecentTokens / avgTokensPerMsg)));
    console.log(
      `[compact-oversized] keepTail: ${keepRecentTokens} token budget / ${avgTokensPerMsg.toFixed(0)} tokens/msg = ${keepTail} msgs`,
    );
  }

  // If session fits in one segment, do simple fork (no splitting needed)
  if (totalMessages <= segmentSize + keepTail) {
    return simpleFork(db, sessionId, userId, totalMessages, keepTail, modelInfo);
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

  // Copy tail messages from the last compacted segment into active session.
  // We copy BEFORE inserting the summary placeholder so we can set the
  // placeholder's created_at earlier than the tail — this ensures DB
  // ordering is [summary] → [tail], which planCompact needs to find
  // summarisable content before the kept tail.
  const lastSegSessionId = compactedSessionIds[compactedSessionIds.length - 1];
  const rawTailRows = db
    .prepare<[string, number], { role: string; content: string; created_at: number }>(
      `SELECT role, content, created_at FROM messages
       WHERE session_id = ? AND (entry_type IS NULL OR entry_type = 'message')
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(lastSegSessionId, keepTail);
  rawTailRows.reverse();
  // Snap to turn boundary so we don't start mid-assistant-turn
  const tailRows = snapToTurnBoundary(rawTailRows);

  // Summary placeholder BEFORE tail, both with fresh timestamps so
  // they appear on the first page (not buried at original tail times).
  const forkNow = Date.now();
  db.prepare<[string, string, string, string, number], unknown>(
    `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    `msg_${randomUUID()}`,
    activeSessionId,
    "assistant",
    `[Conversation summary \u2014 pending generation. ${totalMessages} messages split into ${msgSegments.length} compacted sessions.]`,
    forkNow,
  );

  // Mark tail messages as fork_tail with sequential timestamps after summary.
  let tailTs = forkNow + 1;
  for (const r of tailRows) {
    db.prepare<[string, string, string, string, number], unknown>(
      `INSERT INTO messages (id, session_id, role, content, created_at, entry_type) VALUES (?, ?, ?, ?, ?, 'fork_tail')`,
    ).run(`msg_${randomUUID()}`, activeSessionId, r.role, r.content, tailTs++);
  }

  const tailTokenEstimate = Math.round(tailRows.reduce((sum, r) => sum + r.content.length / BYTES_PER_TOKEN, 0));
  const ctxWindow = modelInfo?.contextWindow ?? 0;
  const ctxPercent = ctxWindow > 0 ? Math.round((tailTokenEstimate / ctxWindow) * 100) : -1;
  console.log(
    `[compact-oversized] fork chain: ${compactedSessionIds.length} compacted sessions → ` +
    `${activeSessionId} (active, ${tailRows.length} tail msgs` +
    `${rawTailRows.length !== tailRows.length ? `, snapped from ${rawTailRows.length}` : ""}` +
    `, ~${tailTokenEstimate} tokens, ~${ctxPercent}% of ${ctxWindow} context window)`,
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
  modelInfo?: ResolvedModelInfo,
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

  // Copy tail first so we know the earliest timestamp for the summary.
  const rawTailRows = db
    .prepare<[string, number], { role: string; content: string; created_at: number }>(
      `SELECT role, content, created_at FROM messages
       WHERE session_id = ? AND (entry_type IS NULL OR entry_type = 'message')
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(sessionId, keepTail);
  rawTailRows.reverse();
  const tailRows = snapToTurnBoundary(rawTailRows);

  // Summary then tail, fresh timestamps so they appear on the first page.
  const forkNow2 = Date.now();
  db.prepare<[string, string, string, string, number], unknown>(
    `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(`msg_${randomUUID()}`, newSessionId, "assistant",
    `[Conversation summary \u2014 pending generation. ${totalMessages} messages.]`, forkNow2);

  let tailTs2 = forkNow2 + 1;
  for (const r of tailRows) {
    db.prepare<[string, string, string, string, number], unknown>(
      `INSERT INTO messages (id, session_id, role, content, created_at, entry_type) VALUES (?, ?, ?, ?, ?, 'fork_tail')`,
    ).run(`msg_${randomUUID()}`, newSessionId, r.role, r.content, tailTs2++);
  }

  const tailTokenEstimate = Math.round(tailRows.reduce((sum, r) => sum + r.content.length / BYTES_PER_TOKEN, 0));
  const ctxWindow = modelInfo?.contextWindow ?? 0;
  const ctxPercent = ctxWindow > 0 ? Math.round((tailTokenEstimate / ctxWindow) * 100) : -1;
  console.log(
    `[compact-oversized] simple fork: ${sessionId} → ${newSessionId} ` +
    `(${tailRows.length} tail msgs` +
    `${rawTailRows.length !== tailRows.length ? `, snapped from ${rawTailRows.length}` : ""}` +
    `, ~${tailTokenEstimate} tokens, ~${ctxPercent}% of ${ctxWindow} context window)`,
  );

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
  compactedSessionIds?: string[];
  onProgress?: (stage: string, current: number, total: number) => void;
  force?: boolean;
}): Promise<SummariseResult> {
  const {
    db, oldSessionId, newSessionId, modelInfo, signal,
    onProgress,
  } = args;
  const t0 = Date.now();

  // Find all compacted sessions in the chain (root-first order)
  const chainIds = args.compactedSessionIds ?? discoverChain(db, newSessionId);
  if (chainIds.length === 0) {
    return { oldSessionId, newSessionId, segments: 0, succeeded: 0, failed: 0, durationMs: 0 };
  }

  // ── Core idea ──────────────────────────────────────────────────
  // Collect ALL original messages across the entire session chain
  // (ignoring previous compact summaries). Then fill the compaction
  // model's context window (× 70%) from newest → oldest. One LLM
  // call produces the summary — from raw messages, never from
  // "summary of a summary".
  // ────────────────────────────────────────────────────────────────

  // 1. Load all original messages across the chain (chronological)
  const allRows: MessageRow[] = [];
  for (const sid of chainIds) {
    const rows = db
      .prepare<[string], MessageRow>(
        `SELECT id, role, content, created_at, turn_number FROM messages
         WHERE session_id = ? AND (entry_type IS NULL OR entry_type = 'message')
         AND content NOT LIKE '[Conversation summary%'
         AND content NOT LIKE '[Pending%'
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(sid);
    allRows.push(...rows);
  }
  // Also include messages from the active session (excluding summary)
  const activeRows = db
    .prepare<[string], MessageRow>(
      `SELECT id, role, content, created_at, turn_number FROM messages
       WHERE session_id = ? AND (entry_type IS NULL OR entry_type = 'message')
       AND content NOT LIKE '[Conversation summary%'
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(newSessionId);
  allRows.push(...activeRows);

  // Sort by turn_number (then created_at as tiebreaker)
  allRows.sort((a, b) => {
    const ta = a.turn_number ?? 0;
    const tb = b.turn_number ?? 0;
    if (ta !== tb) return ta - tb;
    return a.created_at - b.created_at;
  });

  console.log(
    `[compact-oversized] collected ${allRows.length} messages across ` +
    `${chainIds.length} compacted sessions + active session`,
  );

  if (allRows.length === 0) {
    return { oldSessionId, newSessionId, segments: 0, succeeded: 0, failed: 0, durationMs: Date.now() - t0 };
  }

  // 2. Compute token budget from compaction model's context window
  const contextWindow = modelInfo.contextWindow ?? 128_000;
  const tokenBudget = Math.floor(contextWindow * CONTEXT_USAGE_RATIO);
  console.log(
    `[compact-oversized] model context: ${contextWindow}, ` +
    `token budget (${(CONTEXT_USAGE_RATIO * 100).toFixed(0)}%): ${tokenBudget}`,
  );

  // 3. Walk from newest → oldest, accumulate until budget full
  const selected: MessageRow[] = [];
  let tokensUsed = 0;
  for (let i = allRows.length - 1; i >= 0; i--) {
    const r = allRows[i];
    const msgTokens = r.content.length / BYTES_PER_TOKEN;
    if (tokensUsed + msgTokens > tokenBudget && selected.length > 0) break;
    selected.push(r);
    tokensUsed += msgTokens;
  }
  selected.reverse(); // chronological

  const totalMsgs = allRows.length;
  const selectedMsgs = selected.length;
  const cutoff = totalMsgs > selectedMsgs;
  const minTurn = selected[0]?.turn_number ?? 0;
  const maxTurn = selected[selected.length - 1]?.turn_number ?? 0;

  console.log(
    `[compact-oversized] selected ${selectedMsgs}/${totalMsgs} messages ` +
    `(turns ${minTurn}-${maxTurn}, ~${Math.round(tokensUsed)} tokens)` +
    (cutoff ? ` [CUTOFF: oldest ${totalMsgs - selectedMsgs} messages excluded]` : ""),
  );

  onProgress?.("summarising", 0, 1);

  // 4. Build transcript with turn numbers and summarise
  const { transcript } = buildTranscriptFromRows(selected);

  const cutoffNote = cutoff
    ? `\nNote: covers turns ${minTurn}-${maxTurn} (${selectedMsgs} of ${totalMsgs} total messages). Earlier messages excluded due to model context limits.\n`
    : "";

  let lastSummary = "(summary unavailable)";
  const MAX_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastSummary = await callLlm(
        SEGMENT_SUMMARY_PROMPT,
        `${cutoffNote}Summarise this conversation (${selectedMsgs} messages, turns ${minTurn}-${maxTurn}):\n\n${transcript}`,
        modelInfo,
        signal,
      );
      console.log(
        `[compact-oversized] summary generated: ${lastSummary.length} chars`,
      );
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES) {
        console.warn(`[compact-oversized] attempt ${attempt} failed: ${msg}`);
        continue;
      }
      console.error(`[compact-oversized] summarise failed: ${msg}`);
      return {
        oldSessionId, newSessionId,
        segments: chainIds.length, succeeded: 0, failed: 1,
        durationMs: Date.now() - t0,
      };
    }
  }

  // 5. Write summary to compacted sessions (audit) and active session
  for (const sid of chainIds) {
    db.prepare<[string, string], unknown>(
      `UPDATE sessions SET compacted_summary = ? WHERE id = ?`,
    ).run(lastSummary, sid);
  }

  // Update the summary message in the active session
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
      `[Conversation summary — ${chainIds.length} sessions, ${selectedMsgs} msgs, turns ${minTurn}-${maxTurn}, generated at ${new Date().toISOString()}]\n\n${lastSummary}`,
      summaryMsgRow.id,
    );
  }

  onProgress?.("summarising", 1, 1);
  const durationMs = Date.now() - t0;
  console.log(
    `[compact-oversized] done: ${chainIds.length} sessions, ` +
    `${selectedMsgs}/${totalMsgs} msgs, ${durationMs}ms`,
  );

  return {
    oldSessionId,
    newSessionId,
    segments: chainIds.length,
    succeeded: 1,
    failed: 0,
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
  keepRecentTokens?: number;
  onProgress?: (stage: string, current: number, total: number) => void;
}): Promise<ForkResult & SummariseResult> {
  const { ctx, userId, session, modelInfo, signal, segmentSize, keepTail, keepRecentTokens, onProgress } = args;

  const fork = forkOversizedSession({
    db: ctx.db,
    sessionId: session.id,
    userId,
    keepTail,
    keepRecentTokens,
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

/**
 * Build a numbered transcript from DB rows. Uses the persisted
 * `turn_number` from the messages table (set by migration 017)
 * so recall_range links in the summary match exactly what the
 * agent's recall_range tool will look up.
 *
 * Returns { transcript, maxTurn } so callers can log the range.
 */
function buildTranscriptFromRows(
  rows: MessageRow[],
): { transcript: string; maxTurn: number } {
  const lines: string[] = [];
  let maxTurn = 0;
  for (const r of rows) {
    const turn = r.turn_number ?? 0;
    if (turn > maxTurn) maxTurn = turn;
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(r.content); } catch { /* plain text */ }

    if (r.role === "user") {
      const text = extractText(parsed, r.content);
      if (text) lines.push(`### [Turn ${turn}] USER\n${text}`);
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
      if (parts.length > 0) lines.push(`### [Turn ${turn}] ASSISTANT\n${parts.join("\n")}`);
    } else if (r.role === "tool") {
      const text = extractText(parsed, r.content);
      if (text) {
        const trimmed = text.length > 3000
          ? text.slice(0, 3000) + `\n...(+${text.length - 3000} chars)`
          : text;
        lines.push(`### [Turn ${turn}] TOOL_RESULT\n${trimmed}`);
      }
    }
  }
  return { transcript: lines.join("\n\n"), maxTurn };
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
