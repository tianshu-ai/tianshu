// Structured compaction hook.
//
// Replaces pi's default free-form summary with a turn-numbered
// structured markdown block that names the ranges it collapsed and
// tells the model how to recall the originals.
//
// Why. pi 0.85+ compacts by rewriting session history: the pre-
// compaction turns leave model context, and only a summary + retained
// tail stay live. Without turn numbers in that summary, the model
// can't cite recall_range(from, to) — it doesn't know what "from"
// means. This hook writes the summary so the model always sees the
// exact turn coordinates and can archive-dive with confidence.
//
// Invariants (must hold end-to-end):
//   1. turn_number is session-absolute (see migration 017).
//   2. Every compaction summary starts with `[Compacted turns A-B]`
//      where A..B is a contiguous, disjoint range that never
//      overlaps an earlier compaction on the same lane.
//   3. Retained-tail messages are stored on the compaction entry
//      verbatim; A..B stops one turn before the smallest turn in
//      that tail.
//   4. Hook failures never block the run — fall through to pi's
//      default summarizer instead of throwing.
//
// Wire-up. handler.ts imports installStructuredCompactionHook and
// calls it once, right after AgentHarness.create() returns, passing
// the session id + tenant db handle + the model/apiKey used for
// summarization. The hook unsubscribe is captured in the same
// cleanup set as harness.events.on(...) subscriptions.

import type {
  AgentHarness,
  AgentMessage,
  CompactResult,
  CompactionPreparation,
} from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Context as PiAiContext,
  Message,
  Model,
  Api,
  TextContent,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { Database } from "better-sqlite3";
import { completeSimple } from "@earendil-works/pi-ai/compat";

import { buildTranscript } from "./compact.js";

/** Prompt used for structured compaction. The model gets the full
 *  history-to-summarize as one big user turn and must return the
 *  turn-partitioned markdown described below. Kept in this file
 *  so it lives next to the wrapping code that depends on its
 *  exact shape. */
const STRUCTURED_SUMMARY_SYSTEM = `You are compacting a conversation into a structured summary that a future assistant will read to recover context. Follow the format EXACTLY.

Output ONE markdown document. No preface, no commentary about your task, no closing remark. Just the sections below.

## turns A-B: <short topic label>

<2-6 sentence prose summary of what happened across turns A through B: what the user asked, what was decided, what code/files/PRs/URLs/entities came up, current state at the end of this range>

Key facts:
- <one-line durable fact>
- <one-line durable fact>
...

Recall keywords: <comma-separated terms to search wiki or grep code>

---

## turns C-D: <next topic label>

...

Rules:
- Cover EVERY turn in the input. Ranges must be contiguous (B+1 == C) and cover the full input range end to end.
- Use "turns N-N" (same number twice) for a single-turn section.
- 1-6 sections total. Group turns by topic shift; short off-topic turns fold into an adjacent section.
- Prefer verbatim identifiers (commit hashes, PR numbers, file paths, function names, error codes).
- Never invent facts. If unclear, write "unclear from record" for that section — don't fabricate.
- Do NOT continue the conversation, answer any question in it, or address the user. You are ONLY producing the summary.`;

interface CompactionRangeRow {
  turn_number: number | null;
  entry_type: string;
}

/**
 * Read the session's full message list in order and, given the
 * retainedTail length pi is planning to keep, compute the [A,B]
 * turn range that the summary will cover.
 *
 * Uses turn_number written by the sqlite-storage insert path (see
 * migration 017 + the isRealUserEntry counter). Returns null when
 * the range can't be determined — the hook then falls through to
 * pi's default summarizer.
 */
export function computeCompactionTurnRange(
  db: Database,
  sessionId: string,
  retainedTailLength: number,
): { turnStart: number; turnEnd: number } | null {
  // Only entry_type='message' rows carry the turn boundary; other
  // rows (compaction/branch_summary/custom) inherit turn. pi's
  // retainedTail count refers to AgentMessage entries, which map
  // 1:1 to message-type entries in normal operation.
  const rows = db
    .prepare<[string], CompactionRangeRow>(
      `SELECT turn_number, entry_type
         FROM messages
        WHERE session_id = ? AND entry_type = 'message'
        ORDER BY created_at, seq`,
    )
    .all(sessionId);

  if (rows.length === 0) return null;
  if (retainedTailLength >= rows.length) return null; // nothing to summarize

  const summarized = rows.slice(0, rows.length - retainedTailLength);
  let turnStart: number | null = null;
  let turnEnd: number | null = null;
  for (const r of summarized) {
    if (typeof r.turn_number !== "number") continue;
    if (r.turn_number <= 0) continue; // pre-first-user injected rows
    if (turnStart === null || r.turn_number < turnStart) turnStart = r.turn_number;
    if (turnEnd === null || r.turn_number > turnEnd) turnEnd = r.turn_number;
  }
  if (turnStart === null || turnEnd === null) return null;
  return { turnStart, turnEnd };
}

/** Wrap a raw model response in the canonical compacted-turn header
 *  that recall-aware consumers (progressive-history + agent prompt)
 *  look for. Doing the wrapping in code (not the prompt) means even
 *  a partially-obedient model produces a valid header. */
export function buildStructuredSummary(
  turnStart: number,
  turnEnd: number,
  modelBody: string,
  totalTurnsSummarized: number,
): string {
  const trimmed = modelBody.trim();
  const rangeLabel = `turns ${turnStart}-${turnEnd}`;
  const turnWord = totalTurnsSummarized === 1 ? "turn" : "turns";
  return (
    `[Compacted context — ${rangeLabel}, ${totalTurnsSummarized} ${turnWord}]\n\n` +
    trimmed +
    `\n\n---\n` +
    `Original transcripts for ${rangeLabel} remain in the session's DB and can be pulled back with recall_range(${turnStart}, ${turnEnd}). Individual archived tool calls remain accessible via recall_tool_call(id).`
  );
}

/** Filter AgentMessage[] down to plain pi-ai Message[] (the shape
 *  buildTranscript expects). Plugin-defined custom AgentMessage
 *  variants are skipped — they don't carry summarizable text. */
function toPlainMessages(messages: AgentMessage[]): Message[] {
  const known: Message[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const role = (m as { role?: unknown }).role;
    if (role === "user" || role === "assistant" || role === "toolResult") {
      known.push(m as Message);
    }
  }
  return known;
}

interface InstallOptions {
  harness: AgentHarness;
  session: { id: string };
  db: Database;
  model: Model<Api>;
  apiKey: string;
  /** Called when the hook opts out or fails; the caller should not
   *  treat this as a run-blocking error — pi will fall back to its
   *  default summarizer. Optional; useful for logging. */
  onFallback?: (reason: string) => void;
}

/**
 * Install the before_compaction hook on the given harness.
 *
 * Returns the unsubscribe function harness.hooks.on(...) yields;
 * the caller should invoke it in the same cleanup path used for
 * event subscriptions.
 */
export function installStructuredCompactionHook(opts: InstallOptions): () => void {
  const { harness, session, db, model, apiKey, onFallback } = opts;

  return harness.hooks.on("before_compaction", async (event) => {
    const { preparation } = event as { preparation: CompactionPreparation };
    try {
      const range = computeCompactionTurnRange(
        db,
        session.id,
        preparation.retainedTail.length,
      );
      if (!range) {
        onFallback?.("turn_range_unknown");
        return undefined; // fall through to pi default
      }
      const totalTurns = range.turnEnd - range.turnStart + 1;

      const plain = toPlainMessages(preparation.messagesToSummarize);
      if (plain.length === 0) {
        onFallback?.("empty_messages");
        return undefined;
      }

      const transcript = buildTranscript(plain);
      if (!transcript.trim()) {
        onFallback?.("empty_transcript");
        return undefined;
      }

      // pi-ai Context is separate from chord's harness Context; here
      // we build the transcript-request Context by hand, matching
      // compact.ts's proven shape.
      const promptText =
        `This range covers session turns ${range.turnStart} through ${range.turnEnd} (${totalTurns} turn${totalTurns === 1 ? "" : "s"}). Number your sections using those absolute turn IDs.\n\n` +
        `Conversation to compact:\n\n${transcript}`;

      const requestCtx: PiAiContext = {
        systemPrompt: STRUCTURED_SUMMARY_SYSTEM,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: promptText } as TextContent],
            timestamp: Date.now(),
          } as UserMessage,
        ],
      };

      const result = (await completeSimple(model, requestCtx, {
        apiKey,
        maxRetries: 0, // caller decides; hook stays cheap
      })) as AssistantMessage;

      const modelText = result.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();

      if (!modelText) {
        onFallback?.("empty_model_response");
        return undefined;
      }

      const structured = buildStructuredSummary(
        range.turnStart,
        range.turnEnd,
        modelText,
        totalTurns,
      );

      const compactResult: CompactResult = {
        summary: structured,
        tokensBefore: preparation.tokensBefore,
        retainedTail: preparation.retainedTail,
        usage: result.usage,
        details: {
          structured: true,
          turnStart: range.turnStart,
          turnEnd: range.turnEnd,
          totalTurns,
          read: Array.from(preparation.fileOps.read),
          written: Array.from(preparation.fileOps.written),
          edited: Array.from(preparation.fileOps.edited),
        },
      };

      return { compaction: compactResult };
    } catch (err) {
      onFallback?.(`hook_threw:${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  });
}

// Re-export helpers the test file uses.
export type { CompactionPreparation };
