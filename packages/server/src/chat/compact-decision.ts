// Compaction-decision helpers.
//
// Pure functions that decide whether to run `harness.compact()` —
// kept separate from the WS/session-row plumbing in handler.ts so
// the worker agent-loop and unit tests can consume the same logic
// without dragging in chat-shell state. The actual compaction work
// (LLM summarisation + new session forking) lives in compact.ts;
// these helpers only answer "should we?" and run an optional
// harness.compact() if the answer is yes.
//
// Two paths converge here:
//   - main chat handler after every successful turn
//   - worker agent-loop on a configurable cadence so a long-running
//     worker can recover from runaway context growth instead of
//     stalling with `no_completion`
//
// Skipped on:
//   - the model has no `contextWindow` declared (we'd compact every
//     turn against an undefined window)
//   - DEFAULT_COMPACTION_SETTINGS.enabled is false (future-proofs a
//     per-tenant override even though today the constant is true)

import {
  AgentHarness,
  DEFAULT_COMPACTION_SETTINGS,
  Session as PiSession,
  estimateContextTokens,
  shouldCompact,
  type AgentMessage,
  type CompactionSettings,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";

// ─── compaction helpers ───────────────────────────────────────────────
//
// Auto-compaction:
//   - decision: shouldCompactBranch() decides whether the current
//     branch is over the context-window threshold pi defines.
//   - action: maybeAutoCompact() pulls the branch, asks the
//     decision helper, and on `true` calls harness.compact().
//
// Skipped on:
//   - the model has no `contextWindow` declared (we'd compact
//     every turn against an undefined window)
//   - DEFAULT_COMPACTION_SETTINGS.enabled is false (future-proofs
//     a per-tenant override even though today the constant is true)
//
// The user-driven `/compact` slash command still goes through the
// legacy `compactSession` helper, which forks a new session id;
// matches the previous behaviour the UI / DB already understands.
// Migrating /compact onto `harness.compact()` is a separate
// cleanup — same in-place semantics as auto-compact, but loses
// the fork-on-explicit-request pattern.

export interface ShouldCompactBranchInput {
  branch: SessionTreeEntry[];
  contextWindow: number | undefined;
  settings?: CompactionSettings;
}

/**
 * Pure decision function: given a branch (the entries pi's
 * harness sees as the active turn history) and the model's
 * context window, return whether the next turn should run
 * compaction first.
 *
 * Exported for tests; runtime callers go through
 * `maybeAutoCompact` which folds storage + harness in.
 */
export function shouldCompactBranch(
  input: ShouldCompactBranchInput,
): boolean {
  const settings = input.settings ?? DEFAULT_COMPACTION_SETTINGS;
  if (!settings.enabled) return false;
  if (!input.contextWindow || input.contextWindow <= 0) return false;
  const messages: AgentMessage[] = [];
  for (const entry of input.branch) {
    if (entry.type === "message") messages.push(entry.message);
  }
  if (messages.length === 0) return false;
  const usage = estimateContextTokens(messages);
  return shouldCompact(usage.tokens, input.contextWindow, settings);
}

/**
 * Pure-side-effect helper that drives one auto-compact decision
 * + (if needed) action against any AgentHarness, with no
 * dependency on the chat WebSocket or session-row plumbing.
 *
 * Reused by:
 *   - the main chat handler after every successful turn
 *   - the worker agent loop (agent-loop.ts) on a configurable
 *     cadence so a long-running worker can recover from runaway
 *     context growth instead of stalling with `no_completion`.
 *
 * Returns one of:
 *   - { compacted: false }                    — below threshold,
 *     no work done
 *   - { compacted: true,  tokensBefore: N }   — ran compact()
 *     successfully
 *   - { compacted: false, error: "..." }      — attempted but
 *     compact() threw; caller decides whether to surface this
 */
export interface AutoCompactDecision {
  compacted: boolean;
  tokensBefore?: number;
  error?: string;
}

export async function tryAutoCompact(args: {
  piSession: PiSession;
  harness: AgentHarness;
  contextWindow: number | undefined;
}): Promise<AutoCompactDecision> {
  const { piSession, harness, contextWindow } = args;
  let branch: SessionTreeEntry[];
  try {
    branch = await piSession.getBranch();
  } catch (err) {
    console.warn(
      `[chat] auto-compact decision failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { compacted: false };
  }
  if (!shouldCompactBranch({ branch, contextWindow })) {
    return { compacted: false };
  }
  try {
    const result = await harness.compact();
    return { compacted: true, tokensBefore: result.tokensBefore };
  } catch (err) {
    return {
      compacted: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
