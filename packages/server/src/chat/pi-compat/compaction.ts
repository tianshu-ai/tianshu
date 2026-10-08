// Compaction decision helpers extracted from pi-agent-core 0.87.1.
//
// pi-agent-core 1.0 removed built-in compaction. These pure functions
// (estimateContextTokens, shouldCompact, etc.) are frozen here so
// tianshu's auto-compact decision logic keeps working unchanged.
//
// The LLM-driven summarisation (generateSummary, compact()) stays in
// tianshu's own compact.ts / structured-compaction.ts — only the
// decision + estimation math lives here.

import type { Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ─── CompactionSettings ───────────────────────────────────────

/** Compaction thresholds and retention settings. */
export interface CompactionSettings {
  /** Enable automatic compaction decisions. */
  enabled: boolean;
  /** Tokens reserved for summary prompt and output. */
  reserveTokens: number;
  /** Approximate recent-context tokens to keep after compaction. */
  keepRecentTokens: number;
}

/** Default compaction settings (formerly from the harness). */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

// ─── Token estimation ─────────────────────────────────────────

/** Calculate total context tokens from provider usage. */
export function calculateContextTokens(usage: Usage): number {
  return (
    usage.totalTokens ||
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  );
}

/** Estimated context-token usage for a message list. */
export interface ContextUsageEstimate {
  /** Estimated total context tokens. */
  tokens: number;
  /** Tokens reported by the most recent assistant usage block. */
  usageTokens: number;
  /** Estimated tokens after the most recent assistant usage block. */
  trailingTokens: number;
  /** Index of the message that provided usage, or null when none exists. */
  lastUsageIndex: number | null;
}

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(
  content: unknown,
): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && b.text) {
      chars += b.text.length;
    } else if (b.type === "image") {
      chars += ESTIMATED_IMAGE_CHARS;
    }
  }
  return chars;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: AgentMessage): number {
  let chars = 0;
  const msg = message as Record<string, unknown>;
  const role = msg.role as string;
  switch (role) {
    case "user": {
      chars = estimateTextAndImageContentChars(msg.content);
      return Math.ceil(chars / 4);
    }
    case "assistant": {
      const content = msg.content as
        | Array<{
            type: string;
            text?: string;
            thinking?: string;
            name?: string;
            arguments?: unknown;
          }>
        | undefined;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text") {
            chars += (block.text ?? "").length;
          } else if (block.type === "thinking") {
            chars += (block.thinking ?? "").length;
          } else if (block.type === "toolCall") {
            chars +=
              (block.name ?? "").length +
              safeJsonStringify(block.arguments).length;
          }
        }
      }
      return Math.ceil(chars / 4);
    }
    case "custom":
    case "toolResult": {
      chars = estimateTextAndImageContentChars(msg.content);
      return Math.ceil(chars / 4);
    }
    case "bashExecution": {
      const command = (msg.command as string) ?? "";
      const output = (msg.output as string) ?? "";
      chars = command.length + output.length;
      return Math.ceil(chars / 4);
    }
    case "branchSummary":
    case "compactionSummary": {
      const summary = (msg.summary as string) ?? "";
      chars = summary.length;
      return Math.ceil(chars / 4);
    }
  }
  return 0;
}

function getAssistantUsage(
  msg: AgentMessage,
): Usage | undefined {
  const m = msg as Record<string, unknown>;
  if (m.role !== "assistant" || !("usage" in m)) return undefined;
  const stopReason = m.stopReason as string | undefined;
  if (stopReason === "aborted" || stopReason === "error")
    return undefined;
  const usage = m.usage as Usage | undefined;
  if (!usage || calculateContextTokens(usage) <= 0) return undefined;
  return usage;
}

function getLastAssistantUsageInfo(
  messages: AgentMessage[],
): { usage: Usage; index: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = getAssistantUsage(messages[i]);
    if (usage) return { usage, index: i };
  }
  return undefined;
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(
  messages: AgentMessage[],
): ContextUsageEstimate {
  const usageInfo = getLastAssistantUsageInfo(messages);
  if (!usageInfo) {
    let estimated = 0;
    for (const message of messages) {
      estimated += estimateTokens(message);
    }
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null,
    };
  }
  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) {
    trailingTokens += estimateTokens(messages[i]);
  }
  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: usageInfo.index,
  };
}

/** Return whether context usage exceeds the configured compaction threshold. */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}

// ─── CompactResult / CompactionPreparation ────────────────────
//
// Data interfaces for compaction output. Used by
// structured-compaction.ts and compact-decision.ts.

/** Generated compaction data ready to be persisted as a compaction entry. */
export interface CompactResult<T = unknown> {
  /** Summary text that replaces compacted history in future context. */
  summary: string;
  /** Estimated context tokens before compaction. */
  tokensBefore: number;
  /** Usage from the LLM call(s) that generated this summary, if available. */
  usage?: Usage;
  /** Retained recent messages stored directly on the compaction entry. */
  retainedTail: AgentMessage[];
  /** Optional implementation-specific details stored with the compaction entry. */
  details?: T;
}

/** File-operation details tracked through compaction. */
export interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

/** Prepared inputs for a compaction run. */
export interface CompactionPreparation {
  /** Messages summarized into the history summary. */
  messagesToSummarize: AgentMessage[];
  /** Prefix messages summarized separately when compaction splits a turn. */
  turnPrefixMessages: AgentMessage[];
  /** Recent messages retained after compaction and stored on the compaction entry. */
  retainedTail: AgentMessage[];
  /** Whether compaction splits a turn. */
  isSplitTurn: boolean;
  /** Estimated context tokens before compaction. */
  tokensBefore: number;
  /** Previous compaction summary used for iterative updates. */
  previousSummary?: string;
  /** File operations extracted from summarized history. */
  fileOps: FileOperations;
  /** Settings used to prepare compaction. */
  settings: CompactionSettings;
}
