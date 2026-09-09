/**
 * Tool-result truncation & aging utilities.
 *
 * Two layers of context-cost control:
 *
 *   1. **Write-time truncation** (`truncateToolResult`):
 *      Applied immediately when a tool returns its result, before
 *      the result is stored in the session tree. Caps individual
 *      results to a configurable byte limit using middle-truncation
 *      (keep head + tail, drop middle) — the strategy Codex uses.
 *
 *   2. **History aging / prune** (`pruneOldToolResults`):
 *      Applied before compaction summarisation. Walks the message
 *      branch back-to-front and replaces old tool results with a
 *      placeholder once cumulative tool-output size exceeds a
 *      threshold. Inspired by OpenCode's `SessionCompaction.prune`.
 *
 * Both are configurable via `ToolResultConfig` (exposed in the
 * tenant config under `models.toolResults`).
 */

// ── Configuration ─────────────────────────────────────────────────

export interface ToolResultConfig {
  /** Max characters per tool result at write time.
   *  Default: 30000 (~30KB, ~7.5K tokens). Results exceeding this
   *  are middle-truncated. Set 0 to disable. */
  maxResultChars?: number;

  /** Characters to keep from the head of a truncated result.
   *  Default: 40% of maxResultChars. */
  headChars?: number;

  /** Characters to keep from the tail of a truncated result.
   *  Default: 40% of maxResultChars. */
  tailChars?: number;

  /** When aging old tool results in the branch, protect the most
   *  recent N tool results from pruning. Default: 6 (≈ last 3
   *  user turns if each turn uses 2 tools). */
  pruneProtectRecent?: number;

  /** Cumulative character budget for all tool results in the
   *  branch. Once exceeded, older results are replaced with a
   *  placeholder. Default: 80000 (~80KB). Set 0 to disable. */
  pruneBudgetChars?: number;
}

const DEFAULTS = {
  maxResultChars: 30_000,
  headRatio: 0.4,
  tailRatio: 0.4,
  pruneProtectRecent: 6,
  pruneBudgetChars: 80_000,
} as const;

// ── Write-time truncation ─────────────────────────────────────────

const TRUNCATION_MARKER =
  "\n\n⚠️ [Output truncated: showing first {head} + last {tail} of {total} characters. " +
  "Use targeted reads (offset/limit) for the full content.]\n\n";

/**
 * Middle-truncate a tool result string if it exceeds the configured
 * limit. Keeps the beginning and end (most useful context for the
 * model) and inserts a truncation marker in the middle.
 *
 * Returns the original string unchanged if within limits.
 */
export function truncateToolResult(
  text: string,
  config?: ToolResultConfig,
): string {
  const maxChars = config?.maxResultChars ?? DEFAULTS.maxResultChars;
  if (maxChars <= 0 || text.length <= maxChars) return text;

  const headChars = config?.headChars ?? Math.floor(maxChars * DEFAULTS.headRatio);
  const tailChars = config?.tailChars ?? Math.floor(maxChars * DEFAULTS.tailRatio);

  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const marker = TRUNCATION_MARKER
    .replace("{head}", String(headChars))
    .replace("{tail}", String(tailChars))
    .replace("{total}", String(text.length));

  return head + marker + tail;
}

// ── History aging (prune) ─────────────────────────────────────────

/** Placeholder that replaces old tool results after pruning. */
export const PRUNED_MARKER =
  "[Tool output cleared — old result exceeded context budget. " +
  "Re-run the tool if you need this information.]";

export interface PrunableMessage {
  role: string;
  content?: unknown;
}

/**
 * Walk a message array (as returned by session.buildContext()) and
 * replace old tool-result text with PRUNED_MARKER when cumulative
 * tool-output size exceeds the budget.
 *
 * Works on the serialised message array that pi-agent-core sees;
 * does NOT mutate the session tree — the pruning is applied
 * transiently when building the LLM prompt, so the original data
 * is preserved.
 *
 * Returns the number of messages pruned (for logging).
 */
export function pruneOldToolResults(
  messages: PrunableMessage[],
  config?: ToolResultConfig,
): number {
  const budget = config?.pruneBudgetChars ?? DEFAULTS.pruneBudgetChars;
  if (budget <= 0) return 0;
  const protectRecent = config?.pruneProtectRecent ?? DEFAULTS.pruneProtectRecent;

  // Find all tool-result messages and their text lengths.
  interface ToolEntry {
    index: number;
    textLength: number;
  }
  const toolEntries: ToolEntry[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "toolResult" && msg.role !== "tool") continue;
    const textLen = extractToolTextLength(msg);
    if (textLen > 0) {
      toolEntries.push({ index: i, textLength: textLen });
    }
  }

  if (toolEntries.length === 0) return 0;

  // Walk from newest to oldest, accumulating text. Once we exceed
  // the budget, everything older gets pruned.
  let cumulative = 0;
  let pruneFromIdx = -1; // index into toolEntries

  for (let i = toolEntries.length - 1; i >= 0; i--) {
    // Protect the N most recent tool results.
    const reversePos = toolEntries.length - 1 - i;
    if (reversePos < protectRecent) {
      cumulative += toolEntries[i]!.textLength;
      continue;
    }
    cumulative += toolEntries[i]!.textLength;
    if (cumulative > budget) {
      pruneFromIdx = i;
      break;
    }
  }

  if (pruneFromIdx < 0) return 0;

  // Replace text in all tool entries from 0..pruneFromIdx (inclusive).
  let pruned = 0;
  for (let i = 0; i <= pruneFromIdx; i++) {
    const entry = toolEntries[i]!;
    const msg = messages[entry.index]!;
    replaceToolText(msg, PRUNED_MARKER);
    pruned++;
  }

  return pruned;
}

// ── Internal helpers ──────────────────────────────────────────────

function extractToolTextLength(msg: PrunableMessage): number {
  const content = msg.content;
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let len = 0;
    for (const block of content) {
      if (block && typeof block === "object" && "text" in block && typeof (block as { text: string }).text === "string") {
        len += (block as { text: string }).text.length;
      }
    }
    return len;
  }
  return 0;
}

function replaceToolText(msg: PrunableMessage, replacement: string): void {
  const content = msg.content;
  if (typeof content === "string") {
    (msg as { content: string }).content = replacement;
    return;
  }
  if (Array.isArray(content)) {
    // Replace text blocks, keep non-text blocks (e.g. images).
    let replaced = false;
    for (const block of content) {
      if (block && typeof block === "object" && "text" in block && typeof (block as { text: string }).text === "string") {
        if (!replaced) {
          (block as { text: string }).text = replacement;
          replaced = true;
        } else {
          // Subsequent text blocks: empty them out.
          (block as { text: string }).text = "";
        }
      }
    }
  }
}
