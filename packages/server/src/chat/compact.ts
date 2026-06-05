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

import { completeSimple } from "@earendil-works/pi-ai";
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
import { appendMessage } from "./messages.js";
import type { ChatMessage, ChatSession } from "./messages.js";

/** Trigger threshold: compact when estimated input ≥ this fraction
 *  of the active model's context window. Per Yu's call (2026-06-05). */
export const COMPACT_THRESHOLD = 0.5;

/** Minimum number of messages to keep verbatim at the tail. */
const KEEP_TAIL_MIN = 2;

const SUMMARY_PROMPT = `You are a conversation-compaction assistant. Below is a chat history between a user and an AI agent (including tool calls). Produce a structured summary so a fresh agent can pick up seamlessly.

Requirements:
1. Address the next agent in the second person ("you previously …").
2. **MUST preserve**:
   - The user's core goals, constraints, preferences
   - Decisions already made (technology choices, plans, parameters)
   - Files and paths visited / created / modified (give exact paths)
   - Key commands run and their salient results (do not paste full output)
   - Open / in-progress tasks, todos
   - Errors and pitfalls (so they aren't repeated)
   - The most recent turn's specifics (what the user just said; what you were about to do)
3. **You may drop**: greetings, repetition, verbose tool-mid-output, long file dumps, UI chrome
4. Use Markdown headings, e.g. ## Goal / ## Decisions / ## Files / ## Progress / ## Caveats / ## Current State
5. Output ONLY the summary itself (no preamble, no sign-off)
6. Match the original conversation's language (Chinese conversation → Chinese summary, otherwise English)
7. Aim for 600–1500 words. Shorter is better when the conversation is short.`;

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
  if (pi.length <= KEEP_TAIL_MIN) {
    return { toSummarise: [], keep: pi, keepRows: rows };
  }
  // Find the last user message; keep from there to the end. Falls
  // back to KEEP_TAIL_MIN tail when no user message is in range.
  let lastUser = -1;
  for (let i = pi.length - 1; i >= 0; i--) {
    if (pi[i]!.role === "user") {
      lastUser = i;
      break;
    }
  }
  const fromIdx =
    lastUser >= 0
      ? Math.min(lastUser, pi.length - KEEP_TAIL_MIN)
      : pi.length - KEEP_TAIL_MIN;
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
): Promise<{ summary: string; durationMs: number }> {
  const transcript = buildTranscript(toSummarise);
  if (!transcript.trim()) {
    return { summary: "(empty conversation)", durationMs: 0 };
  }
  const model = buildModel(modelInfo);
  const apiKey = resolveApiKey(modelInfo);
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
  const result = (await completeSimple(model, ctx, {
    signal,
    apiKey,
  })) as AssistantMessage;
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

  // Seed: history-summary user msg + ack assistant msg.
  const seedTime = Date.now();
  appendMessage(ctx, newSession, {
    role: "user",
    content: `[Conversation summary — generated at ${new Date(seedTime).toISOString()}]\n\n${summary}`,
  });
  appendMessage(ctx, newSession, {
    role: "assistant",
    content:
      "Understood — I have the prior context and will continue from where we left off.",
  });

  // Re-persist the kept tail rows. Copy the original `content` JSON
  // verbatim so attachments / structured tool turns survive.
  for (const r of plan.keepRows) {
    const id = `msg_${randomUUID()}`;
    ctx.db
      .prepare<
        [string, string, string, string, number],
        unknown
      >(
        `INSERT INTO messages (id, session_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, newSession.id, r.role, r.content, Date.now());
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

// ─── transcript helpers ───────────────────────────────────────────

const MAX_TOOL_RESULT_CHARS = 600;

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
