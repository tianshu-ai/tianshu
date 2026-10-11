// Conversation compaction.
//
// Two paths share the same LLM-summarisation core:
//
//   1. Auto-compact: kicked off before each turn when the projected
//      input tokens exceed `contextWindow * COMPACT_THRESHOLD` of the
//      active model.
//   2. Manual `/compact` slash command from the user.
//
// In both cases we:
//   1. Pick a tail of recent turns to keep verbatim.
//   2. Hand everything older to the active LLM with the SUMMARY_PROMPT
//      and let it produce one structured note.
//   3. Mark the OLD session `status='compacted'`, stash the summary on
//      `compacted_summary`.
//   4. Fork a new session under the same user, `parent_id` pointing
//      at the old one (per ADR-0001 §5: the chain is queryable, no
//      messages get deleted).
//   5. Seed the new session with a [history summary] user message and
//      an "understood" assistant ack, then re-add the kept tail.
//
// The old session's messages stay on disk untouched. The chat hot
// path uses `ensureActiveSession` which only returns the newly-forked
// active session, so future LLM calls see only the shorter history.

// pi 0.80: the global complete*/stream* dispatch moved behind the
// `/compat` entrypoint (the bare package now exposes the
// createModels()/createProvider() runtime). Types stay on the bare
// package — they are identical and re-exported by compat anyway.
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
  AssistantMessage,
  Context,
  Message,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import type { TenantContext } from "../core/index.js";
import {
  buildModel,
  resolveApiKey,
  type ResolvedModelInfo,
} from "../core/index.js";
import type { ModelResilienceConfig } from "../core/config.js";
import { resolveResilience, retryCompletion } from "../core/model-retry.js";
import { appendMessage } from "./messages.js";
import type { ChatMessage, ChatSession } from "./messages.js";

/** Trigger threshold: compact when estimated input ≥ this fraction
 *  of the active model's context window. Per Yu's call (2026-06-05). */
export const COMPACT_THRESHOLD = 0.5;

/** Minimum number of messages to keep verbatim at the tail. */
const KEEP_TAIL_MIN = 2;

/** Minimum messages required before we allow compaction. Prevents
 *  re-compacting a freshly forked session where the only content is
 *  a summary + a few tail messages — compacting that would lose
 *  significant detail from the previous summary for little gain. */
const MIN_MESSAGES_TO_COMPACT = 10;

const SUMMARY_PROMPT = `You are compacting a conversation into a structured summary that a future assistant will read as its only context for continuing the conversation.

Output ONE markdown document using the exact sections below. No preface, no commentary, no closing remark. Match the conversation's language. Never invent facts.

## Latest user request context
<What the user most recently asked or was working on. 1-3 sentences.>

## Decisions
- <Decision made and the reasoning, one per line>
- <Use exact identifiers: file paths, commit hashes, model names, URLs, version numbers>

## Open TODOs
- [ ] <Incomplete task with enough context to resume>
- [x] <Recently completed task worth noting>

## Constraints/Rules
- <Established rule, convention, or constraint that must be followed going forward>
- <Include technical constraints like "CSS variable X is transparent", "never do Y">

## Pending user asks
- <Things the user asked for that haven't been delivered yet>

## Exact identifiers
- <Key identifiers the assistant needs: session IDs, commit hashes, file paths, server addresses, version numbers>
- <Format: **label**: \`value\`>

## Recall anchors
<For each major topic discussed, provide a recall link so the assistant can fetch original messages:>
- **<topic>** (turns A-B): \`recall_range(A, B)\` — <what's there>
- **<topic>** (turns C-D): \`recall_range(C, D)\` — <what's there>

Rules:
- Every section is REQUIRED. Use "(none)" if a section is empty.
- Focus on durable facts that affect future work, not conversational fluff.
- Prefer verbatim identifiers over paraphrasing.
- The assistant has \`recall_range(startTurn, endTurn)\` to fetch original messages for any topic.
- Do NOT continue the conversation or address the user. Only produce the summary.`;

export interface CompactPlan {
  toSummarise: Message[];
  keep: Message[];
  /** Original ChatMessage rows for the kept tail (so we re-persist
   *  the exact JSON when forking; round-tripping through pi-ai
   *  shapes loses metadata like sibling `attachments`). */
  keepRows: ChatMessage[];
}

/** Decide how many tail turns to keep verbatim and split the message
 *  log accordingly. */
export function planCompact(
  pi: Message[],
  rows: ChatMessage[],
): CompactPlan {
  if (pi.length !== rows.length) {
    const n = Math.min(pi.length, rows.length);
    pi = pi.slice(0, n);
    rows = rows.slice(0, n);
  }
  if (pi.length <= KEEP_TAIL_MIN || pi.length < MIN_MESSAGES_TO_COMPACT) {
    return { toSummarise: [], keep: pi, keepRows: rows };
  }
  // Find the last user message; keep from there to the end. Falls
  // back to KEEP_TAIL_MIN tail when no user message is in range.
  // Ensure at least 1 message is available to summarise — if the
  // only user message is at position 0, fall back to keeping just
  // the last KEEP_TAIL_MIN messages so there is something to compact.
  let lastUser = -1;
  for (let i = pi.length - 1; i >= 0; i--) {
    if (pi[i]!.role === "user") {
      lastUser = i;
      break;
    }
  }
  let fromIdx =
    lastUser >= 0
      ? Math.min(lastUser, pi.length - KEEP_TAIL_MIN)
      : pi.length - KEEP_TAIL_MIN;
  // Guard: if fromIdx is 0 (e.g. only user message at the start),
  // fall back to keeping just the minimum tail so we have content
  // to summarise. This happens after a fork where the summary
  // placeholder sorts before the tail.
  if (fromIdx <= 0 && pi.length > KEEP_TAIL_MIN) {
    fromIdx = pi.length - KEEP_TAIL_MIN;
  }
  return {
    toSummarise: pi.slice(0, fromIdx),
    keep: pi.slice(fromIdx),
    keepRows: rows.slice(fromIdx),
  };
}

export interface CompactResult {
  summary: string;
  newSession: ChatSession;
  oldSessionId: string;
  summarisedCount: number;
  keptCount: number;
  durationMs: number;
}

export class CompactSkippedError extends Error {
  readonly code = "COMPACT_SKIPPED" as const;
  constructor(reason: string) {
    super(reason);
    this.name = "CompactSkippedError";
  }
}

/** Run a summarisation LLM call. Returns the plain text summary. */
export async function summarise(
  toSummarise: Message[],
  modelInfo: ResolvedModelInfo,
  signal?: AbortSignal,
  resilienceCfg?: ModelResilienceConfig,
): Promise<{ summary: string; durationMs: number }> {
  const transcript = buildTranscript(toSummarise);
  if (!transcript.trim()) {
    return { summary: "(empty conversation)", durationMs: 0 };
  }
  const model = buildModel(modelInfo);
  const apiKey = resolveApiKey(modelInfo);
  const resilience = resolveResilience(resilienceCfg);
  const ctx: Context = {
    systemPrompt: SUMMARY_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Please compact this conversation:\n\n${transcript}`,
          } as TextContent,
        ],
        timestamp: Date.now(),
      } as UserMessage,
    ],
  };
  const t0 = Date.now();
  const result = (await retryCompletion(
    (key) =>
      completeSimple(model, ctx, {
        signal,
        apiKey: key,
        // Retry policy lives in retryCompletion (auth re-resolve +
        // rate-limit aware); disable the SDK's own client retries so
        // the two layers don't compound backoff.
        maxRetries: 0,
      }) as Promise<AssistantMessage>,
    apiKey,
    {
      resilience,
      reResolveApiKey: () => resolveApiKey(modelInfo),
      label: `${modelInfo.providerId}/${modelInfo.modelId} (compact)`,
    },
  )) as AssistantMessage;
  const durationMs = Date.now() - t0;
  const text = result.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("compaction summariser returned empty content");
  return { summary: text, durationMs };
}

/**
 * End-to-end compact: summarise → mark old → fork new → seed new.
 */
export async function compactSession(args: {
  ctx: TenantContext;
  userId: string;
  oldSession: ChatSession;
  pi: Message[];
  rows: ChatMessage[];
  modelInfo: ResolvedModelInfo;
  signal?: AbortSignal;
}): Promise<CompactResult> {
  const { ctx, userId, oldSession, pi, rows, modelInfo, signal } = args;
  const plan = planCompact(pi, rows);
  if (plan.toSummarise.length === 0) {
    throw new CompactSkippedError(
      "nothing to summarise (≤ KEEP_TAIL_MIN messages)",
    );
  }

  const { summary, durationMs } = await summarise(
    plan.toSummarise,
    modelInfo,
    signal,
    ctx.config.models?.resilience,
  );

  // Mark the old session compacted + stash the summary for audit.
  ctx.db
    .prepare<[string, number, string], unknown>(
      `UPDATE sessions
         SET status='compacted', compacted_summary=?, ended_at=?
       WHERE id=?`,
    )
    .run(summary, Date.now(), oldSession.id);

  // Fork a new active session under the same user, parent pointing
  // at the old one.
  const newSession = forkSession(ctx, userId, oldSession);

  // Seed: summary then tail, both with fresh timestamps so they
  // appear on the first page of the new session (not buried months
  // ago at the original tail timestamps). Ordering: summary first,
  // then tail messages 1ms apart.
  const now = Date.now();
  const summaryId = `msg_${randomUUID()}`;
  ctx.db
    .prepare<[string, string, string, string, number], unknown>(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      summaryId,
      newSession.id,
      "assistant",
      `[Conversation summary \u2014 generated at ${new Date(now).toISOString()}]\n\n${summary}`,
      now,
    );

  // Re-persist the kept tail rows into the new session so the agent
  // has recent context. Mark them entry_type='fork_tail' so queries
  // that walk the full timeline (wiki indexer, listMessagesForUserPage)
  // can skip the duplicates — the originals remain in the compacted
  // session with entry_type='message'.
  let tailTs = now + 1;
  for (const r of plan.keepRows) {
    const id = `msg_${randomUUID()}`;
    ctx.db
      .prepare<
        [string, string, string, string, number],
        unknown
      >(
        `INSERT INTO messages (id, session_id, role, content, created_at, entry_type)
         VALUES (?, ?, ?, ?, ?, 'fork_tail')`,
      )
      .run(id, newSession.id, r.role, r.content, tailTs++);
  }

  return {
    summary,
    newSession,
    oldSessionId: oldSession.id,
    summarisedCount: plan.toSummarise.length,
    keptCount: plan.keep.length,
    durationMs,
  };
}

function forkSession(
  ctx: TenantContext,
  userId: string,
  parent: ChatSession,
): ChatSession {
  const id = `session_${randomUUID()}`;
  const now = Date.now();
  ctx.db
    .prepare<
      [string, string, string, string, string, number],
      unknown
    >(
      `INSERT INTO sessions (id, user_id, parent_id, status, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, parent.id, "active", "user", now);
  return {
    id,
    userId,
    parentId: parent.id,
    status: "active",
    kind: "user",
    title: null,
    createdAt: now,
  };
}

/**
 * Fork a session using a pre-computed summary (no LLM call).
 * Used by the pi-agent-core compact path which already generated
 * the summary in-memory — we only need the DB-side fork + persist.
 *
 * The kept tail is re-persisted from the current session's most
 * recent `keptCount` message rows so the fork has verbatim copies.
 */
export function forkWithSummary(args: {
  ctx: TenantContext;
  userId: string;
  oldSession: ChatSession;
  summary: string;
  keptCount: number;
  summarisedCount: number;
}): CompactResult {
  const { ctx, userId, oldSession, summary, keptCount, summarisedCount } = args;

  // Mark the old session compacted + stash the summary for audit.
  ctx.db
    .prepare<[string, number, string], unknown>(
      `UPDATE sessions
         SET status='compacted', compacted_summary=?, ended_at=?
       WHERE id=?`,
    )
    .run(summary, Date.now(), oldSession.id);

  // Fork a new active session.
  const newSession = forkSession(ctx, userId, oldSession);

  // Re-persist the kept tail from the old session's most recent rows
  // so the agent has recent context in the new session.
  //
  // IMPORTANT: copy by turn boundary, not by raw message count.
  // A single turn can span many messages (user → assistant w/ tool_call
  // → tool_result ×N → assistant).  Cutting in the middle leaves orphan
  // tool_result rows whose tool_call was summarised away — the LLM
  // then returns 400 "tool_call_id … is not found".
  //
  // Strategy: fetch more rows than keptCount, then trim from the front
  // to the nearest user-message turn boundary.
  const forkNow = Date.now();
  let tailTs = forkNow + 1;
  if (keptCount > 0) {
    // Fetch extra rows to have room to snap to a turn boundary.
    // A heavy tool turn can be 20+ messages, so 3× gives headroom.
    const fetchLimit = keptCount * 3;
    const tailRows = ctx.db
      .prepare<[string, number], { role: string; content: string; created_at: number }>(
        `SELECT role, content, created_at FROM messages
         WHERE session_id = ? AND entry_type IN ('message', 'fork_tail')
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(oldSession.id, fetchLimit);
    tailRows.reverse();

    // Find the turn boundary closest to keptCount from the end.
    const idealStart = Math.max(0, tailRows.length - keptCount);
    let turnStart = idealStart;
    while (turnStart < tailRows.length && tailRows[turnStart]!.role !== 'user') {
      turnStart++;
    }
    if (turnStart >= tailRows.length) {
      turnStart = idealStart;
      while (turnStart > 0 && tailRows[turnStart]!.role !== 'user') {
        turnStart--;
      }
    }
    const trimmed = tailRows.slice(turnStart);

    for (const r of trimmed) {
      const id = `msg_${randomUUID()}`;
      ctx.db
        .prepare<[string, string, string, string, number], unknown>(
          `INSERT INTO messages (id, session_id, role, content, created_at, entry_type)
           VALUES (?, ?, ?, ?, ?, 'fork_tail')`,
        )
        .run(id, newSession.id, r.role, r.content, tailTs++);
    }
  }

  // Seed: summary BEFORE tail (created_at = forkNow, tail starts at forkNow+1).
  const summaryId = `msg_${randomUUID()}`;
  ctx.db
    .prepare<[string, string, string, string, number], unknown>(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      summaryId,
      newSession.id,
      "assistant",
      `[Conversation summary \u2014 generated at ${new Date(forkNow).toISOString()}]\n\n${summary}`,
      forkNow,
    );

  return {
    summary,
    newSession,
    oldSessionId: oldSession.id,
    summarisedCount,
    keptCount,
    durationMs: 0,
  };
}

// ─── transcript helpers ───────────────────────────────────────────

const MAX_TOOL_RESULT_CHARS = 3000;

/** Build a plain-text transcript from pi-ai messages. Drops base64
 *  image bytes (replaced with a marker) and clamps long tool-result
 *  bodies so the summariser doesn't burn its own context on them. */
export function buildTranscript(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      lines.push(`### USER\n${userMessageToText(m as UserMessage)}`);
    } else if (m.role === "assistant") {
      const a = m as AssistantMessage;
      const parts: string[] = [];
      for (const c of a.content) {
        if (c.type === "text" && c.text) parts.push(c.text);
        else if (c.type === "toolCall") {
          const tc = c as ToolCall;
          const args = JSON.stringify(tc.arguments ?? {}).slice(0, 400);
          parts.push(`[tool:${tc.name} args=${args}]`);
        }
      }
      if (parts.length > 0) lines.push(`### ASSISTANT\n${parts.join("\n")}`);
    } else if (m.role === "toolResult") {
      const tr = m as ToolResultMessage;
      const text = tr.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (text) {
        const trimmed =
          text.length > MAX_TOOL_RESULT_CHARS
            ? text.slice(0, MAX_TOOL_RESULT_CHARS) +
              `\n...(+${text.length - MAX_TOOL_RESULT_CHARS} chars)`
            : text;
        lines.push(`### TOOL_RESULT (${tr.toolName})\n${trimmed}`);
      }
    }
  }
  return lines.join("\n\n");
}

function userMessageToText(u: UserMessage): string {
  if (typeof u.content === "string") return u.content;
  if (!Array.isArray(u.content)) return "";
  const parts: string[] = [];
  for (const c of u.content) {
    const p = c as { type?: string; text?: string; name?: string; path?: string };
    if (p.type === "text" && p.text) parts.push(p.text);
    else if (p.type === "image") {
      parts.push(`[image: ${p.name ?? p.path ?? "(no name)"}]`);
    }
  }
  return parts.join("\n");
}
