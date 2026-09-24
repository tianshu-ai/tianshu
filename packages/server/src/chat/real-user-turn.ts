// Single source of truth for "is this a real user turn?"
//
// Tianshu injects several kinds of role='user' rows that are NOT
// real user turns: plugin-lifecycle notices, [system note] recovery
// stubs, etc. Turn-boundary consumers (progressive-history,
// recall_range, structured-compaction, migration 017 back-fill) all
// need to agree on which rows count so turn numbers stay stable
// end-to-end.
//
// Two projections of the same rule:
//   - `isRealUserAgentMessage(msg)` — over pi-ai's AgentMessage
//     (used inside toProviderMessages / progressive-history).
//   - `isRealUserRawJson(json)` — over a JSON blob just read from
//     DB `messages.content` (used by recall_range's row scan,
//     storage's insert-path counter, and migration 017's back-fill).
//
// Rule: role='user' AND the first text chunk (after trimStart) does
// NOT start with any SYSTEM_INJECTED_USER_PREFIXES entry. Rows with
// no text content are treated as real turns (conservative — the
// only known no-text user rows are attachments, which are real).
//
// If you add another site that writes system-owned rows under
// role='user', append its prefix here.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

/**
 * Prefixes that mark a role='user' row as tianshu-injected system
 * content rather than a real user turn. Kept public for tests +
 * future call sites; do NOT edit past entries — they anchor a
 * historical DB.
 */
export const SYSTEM_INJECTED_USER_PREFIXES = [
  "[plugin-system]",
  "[system note]",
  // Legacy fork-based compactSession (compact.ts) seeds a new session
  // with a role='user' row starting `[Conversation summary — generated
  // at <ISO>]`. That row is not a real user turn — it's a system-
  // generated summary that opens the forked session. Excluded so it
  // doesn't consume turn 1 in the fork's turn_number sequence.
  "[Conversation summary — generated at",
];

/** Narrow AgentMessage to a pi-ai Message the checker understands.
 *  Plugin-defined custom messages fall through as "not a user turn". */
export function isKnownMessage(msg: AgentMessage): msg is Message {
  if (!msg || typeof msg !== "object") return false;
  const role = (msg as { role?: unknown }).role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

/** Extract the first text chunk of a message payload, wherever it hides.
 *  Supports string content, pi-ai array content, and the legacy shape
 *  `content: [{type:"text", text:"..."}]` produced by pre-0.85 storage. */
function firstTextOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const p of content) {
      if (p && typeof p === "object" && "type" in p && (p as { type: string }).type === "text") {
        const t = (p as { text?: unknown }).text;
        if (typeof t === "string") return t;
      }
    }
  }
  return null;
}

/** True when a pi-ai AgentMessage counts as a real user turn. */
export function isRealUserAgentMessage(msg: AgentMessage): boolean {
  if (!isKnownMessage(msg)) return false;
  if (msg.role !== "user") return false;
  const firstText = firstTextOf(msg.content);
  if (firstText === null) return true; // conservative: no text ⇒ real
  const head = firstText.trimStart();
  for (const prefix of SYSTEM_INJECTED_USER_PREFIXES) {
    if (head.startsWith(prefix)) return false;
  }
  return true;
}

/** True when a DB row (already parsed as JSON) counts as a real user
 *  turn. The input is the object obtained from `JSON.parse(row.content)`;
 *  callers that hold the raw string should parse first. */
export function isRealUserRawJson(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const j = json as { role?: unknown; content?: unknown };
  if (j.role !== "user") return false;
  const firstText = firstTextOf(j.content);
  if (firstText === null) return true;
  const head = firstText.trimStart();
  for (const prefix of SYSTEM_INJECTED_USER_PREFIXES) {
    if (head.startsWith(prefix)) return false;
  }
  return true;
}

/** Convenience: given a stored row's `content` string, parse and test. */
export function isRealUserContent(contentJson: string): boolean {
  try {
    return isRealUserRawJson(JSON.parse(contentJson));
  } catch {
    return false;
  }
}
