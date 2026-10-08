// Compact an oversized session by splitting it into segments,
// summarising each segment independently, then combining segment
// summaries into one final summary and forking the session.
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

/** Max messages per segment for individual summarisation. */
const SEGMENT_SIZE = 400;

/** How many recent messages to keep verbatim in the fork. */
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

export interface CompactOversizedResult {
  oldSessionId: string;
  newSessionId: string;
  totalMessages: number;
  segments: number;
  keptTail: number;
  summary: string;
  durationMs: number;
}

// ─── Main entry point ─────────────────────────────────────────────

export async function compactOversizedSession(args: {
  ctx: TenantContext;
  userId: string;
  session: ChatSession;
  modelInfo: ResolvedModelInfo;
  signal?: AbortSignal;
  segmentSize?: number;
  keepTail?: number;
  onProgress?: (stage: string, current: number, total: number) => void;
}): Promise<CompactOversizedResult> {
  const {
    ctx, userId, session, modelInfo, signal,
    segmentSize = SEGMENT_SIZE,
    keepTail = KEEP_TAIL,
    onProgress,
  } = args;
  const t0 = Date.now();

  // 1. Load all message rows.
  const allRows: MessageRow[] = ctx.db
    .prepare<[string], MessageRow>(
      `SELECT id, role, content, created_at FROM messages
       WHERE session_id = ? AND (entry_type IS NULL OR entry_type = 'message')
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(session.id);

  const totalMessages = allRows.length;
  if (totalMessages <= keepTail) {
    throw new Error(`Session only has ${totalMessages} messages, below keepTail=${keepTail}`);
  }

  // 2. Split: everything except tail → segments for summarisation.
  const toSummarise = allRows.slice(0, allRows.length - keepTail);
  const tail = allRows.slice(allRows.length - keepTail);
  const segments: MessageRow[][] = [];
  for (let i = 0; i < toSummarise.length; i += segmentSize) {
    segments.push(toSummarise.slice(i, i + segmentSize));
  }

  onProgress?.("splitting", 0, segments.length);
  console.log(`[compact-oversized] ${totalMessages} messages → ${segments.length} segments + ${tail.length} tail`);

  // 3. Summarise each segment independently.
  const segmentSummaries: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    onProgress?.("summarising", i + 1, segments.length);
    console.log(`[compact-oversized] summarising segment ${i + 1}/${segments.length} (${segments[i].length} messages)`);

    const transcript = buildTranscriptFromRows(segments[i]);
    const summary = await callLlm(
      SEGMENT_SUMMARY_PROMPT,
      `Summarise this conversation segment (${segments[i].length} messages):\n\n${transcript}`,
      modelInfo,
      signal,
    );
    segmentSummaries.push(summary);
  }

  // 4. Merge segment summaries into one final summary.
  onProgress?.("merging", 0, 1);
  console.log(`[compact-oversized] merging ${segmentSummaries.length} segment summaries`);

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

  // 5. Fork session: mark old as compacted, create new with summary + tail.
  onProgress?.("forking", 0, 1);
  console.log(`[compact-oversized] forking session`);

  ctx.db
    .prepare<[string, number, string], unknown>(
      `UPDATE sessions
         SET status='compacted', compacted_summary=?, ended_at=?
       WHERE id=?`,
    )
    .run(finalSummary, Date.now(), session.id);

  const newSessionId = `session_${randomUUID()}`;
  const now = Date.now();
  ctx.db
    .prepare<[string, string, string, string, string, number], unknown>(
      `INSERT INTO sessions (id, user_id, parent_id, status, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(newSessionId, userId, session.id, "active", "user", now);

  const newSession: ChatSession = {
    id: newSessionId,
    userId,
    parentId: session.id,
    status: "active",
    kind: "user",
    title: null,
    createdAt: now,
  };

  appendMessage(ctx, newSession, {
    role: "user",
    content: `[Conversation summary — generated at ${new Date(now).toISOString()}]\n\n${finalSummary}`,
  });
  appendMessage(ctx, newSession, {
    role: "assistant",
    content: "Understood — I have the prior context and will continue from where we left off.",
  });

  for (const r of tail) {
    const id = `msg_${randomUUID()}`;
    ctx.db
      .prepare<[string, string, string, string, number], unknown>(
        `INSERT INTO messages (id, session_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, newSessionId, r.role, r.content, r.created_at);
  }

  const durationMs = Date.now() - t0;
  console.log(`[compact-oversized] done: old=${session.id} new=${newSessionId} (${durationMs}ms)`);

  return {
    oldSessionId: session.id,
    newSessionId,
    totalMessages,
    segments: segments.length,
    keptTail: tail.length,
    summary: finalSummary,
    durationMs,
  };
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
