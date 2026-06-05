// Cheap, vendor-agnostic token estimation.
//
// pi-ai doesn't expose a tokeniser per provider, and shipping
// tiktoken / Anthropic-tokenizer for one heuristic is overkill. The
// 4-chars-per-token rule of thumb is accurate within ±25% for English,
// usually high-side for Chinese (which packs more meaning per char so
// tokenisers compress aggressively). For our purposes \u2014 deciding
// whether to compact at the 50% mark of a context window \u2014 a
// systematic over-estimate is the conservative choice.
//
// We count:
//   - all message content text (TextContent.text)
//   - the byte-size of each base64 image we'd inline (1 token \u2248 4
//     chars of base64)
//   - tool-call argument JSON bodies
//   - the system prompt
//   - the JSON schema of every tool the agent has access to
//
// We DON'T count:
//   - structural overhead (role markers, message boundaries) \u2014 small
//     constant per message, swallowed by the conservative ratio
//   - thinking blocks (provider-specific, often free)

import type { Message, Tool } from "@earendil-works/pi-ai";

const CHARS_PER_TOKEN = 4;

/**
 * Estimate the number of tokens needed to send the given context to
 * an LLM. Returns whole tokens. Always rounds up.
 */
export function estimateTokens(args: {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}): number {
  let chars = 0;
  if (args.systemPrompt) chars += args.systemPrompt.length;

  for (const m of args.messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      const p = part as { type?: string; text?: string; data?: string;
        arguments?: unknown };
      if (p.type === "text" && typeof p.text === "string") {
        chars += p.text.length;
      } else if (p.type === "image" && typeof p.data === "string") {
        // base64 strings; each char is roughly one byte that the
        // provider will need to ferry. Vision pricing is also\n        // usually per-pixel \u2014 over-estimating here is a feature.
        chars += p.data.length;
      } else if (p.type === "toolCall") {
        chars += JSON.stringify(p.arguments ?? {}).length;
      }
    }
  }

  if (args.tools && args.tools.length > 0) {
    for (const t of args.tools) {
      chars += (t.name?.length ?? 0) + (t.description?.length ?? 0);
      try {
        chars += JSON.stringify(t.parameters ?? {}).length;
      } catch {
        /* schemas are plain objects \u2014 stringify shouldn't fail */
      }
    }
  }

  return Math.ceil(chars / CHARS_PER_TOKEN);
}
