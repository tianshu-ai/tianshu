// Return-size cap for tool results that hand raw file content back to
// the model (`read_file`, `tenant_config_read`, ...).
//
// Why this exists as a separate concept from `MAX_TEXT_BYTES`:
//
//   - `MAX_TEXT_BYTES` limits **how much we read** — the data a caller
//     can reach through offset/limit paging. It must stay generous so
//     large-but-legitimate files (a 200 KB source file, a big log) can
//     still be read end to end.
//   - `MAX_RETURN_CHARS` limits **how much the model sees in one tool
//     result** — a context-budget concern, not a data-reachability
//     one. A single 500 KB UTF-8 blob is rough  125K tokens, far past
//     any model's comfortable turn budget.
//
// Conflating the two (as the earlier implementation did, by setting a
// 500 KB read cap and no return cap) leaves the real failure mode
// unguarded: a mis-decoded binary (e.g. a PDF whose first 4 KB has no
// NUL byte) becomes hundreds of thousands of U+FFFD characters that
// blow the context in a single turn.
//
// Strategy: middle-truncation (keep head + tail, fold the middle)
// with a marker that tells the model how to page for the rest. Head
// and tail are where the useful signals live — imports/exports and
// log headers at the top, final results and error tails at the
// bottom.

/** Max characters of file content returned in a single tool result.
 *  Aligned with the server's `models.toolResults.maxResultChars`
 *  default so the two layers agree. */
export const MAX_RETURN_CHARS = 30_000;

/** Fraction of the budget kept from the head of the text. */
const HEAD_RATIO = 0.4;
/** Fraction of the budget kept from the tail of the text. */
const TAIL_RATIO = 0.4;

export interface TruncateOptions {
  /** Override the character budget. Defaults to MAX_RETURN_CHARS. */
  maxChars?: number;
  /** Optional hint appended to the marker, e.g. the byte offset to
   *  resume reading from. Callers that page by bytes should pass
   *  this so the model knows exactly where to continue. */
  resumeHint?: string;
}

export interface TruncatedText {
  /** The (possibly truncated) text to return to the model. */
  text: string;
  /** True when the input exceeded the budget and was folded. */
  truncated: boolean;
  /** Character count of the original input. */
  originalChars: number;
}

/**
 * Middle-truncate `text` to `maxChars`, keeping HEAD_RATIO of the
 * budget from the front and TAIL_RATIO from the back. Returns the
 * original string untouched when it already fits (or when the budget
 * is disabled with a value <= 0).
 */
export function truncateForReturn(
  text: string,
  opts?: TruncateOptions,
): TruncatedText {
  const maxChars = opts?.maxChars ?? MAX_RETURN_CHARS;
  const originalChars = text.length;
  if (maxChars <= 0 || originalChars <= maxChars) {
    return { text, truncated: false, originalChars };
  }

  const headChars = Math.floor(maxChars * HEAD_RATIO);
  const tailChars = Math.floor(maxChars * TAIL_RATIO);
  const droppedChars = originalChars - headChars - tailChars;

  const resume = opts?.resumeHint ? ` ${opts.resumeHint}` : "";
  const marker =
    `\n\n⚠️ [Output truncated: showing first ${headChars} + last ${tailChars} ` +
    `of ${originalChars} characters (${droppedChars} dropped from the middle). ` +
    `Use targeted reads (offset/limit) for the full content.]${resume}\n\n`;

  return {
    text: text.slice(0, headChars) + marker + text.slice(-tailChars),
    truncated: true,
    originalChars,
  };
}