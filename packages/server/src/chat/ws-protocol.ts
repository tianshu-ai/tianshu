// WebSocket protocol for the (PR #21) minimal chat surface.
//
// Server → Client events follow the pi-ai naming so we can pass deltas
// through with zero translation later when worker streams arrive.
//
// Wire format is JSON, one message per WebSocket frame.

import type { ChatMessage } from "./messages.js";

// ─── Client → Server ──────────────────────────────────────────────

export type ClientMsg =
  | { type: "hello" }
  | { type: "history" }
  | {
      type: "prompt";
      content: string;
      /** Optional model id (e.g. 'anthropic/claude-sonnet-4-6'). When
       *  absent the server falls back to config.defaultModel. */
      modelId?: string;
      /**
       * Files staged in the composer (per ADR-0003 §12).
       *
       * For image attachments the server constructs a multimodal
       * UserMessage and inlines the file as base64 right before each
       * LLM call. For non-image attachments the server adds a text
       * note pointing at `path` so the agent can `read_file` it.
       *
       * Paths are user-home-relative ("/uploads/x.png" → the file
       * lives at `<userHome>/uploads/x.png`).
       */
      attachments?: WireAttachment[];
    }
  | { type: "abort" };

export interface WireAttachment {
  /** User-home-relative path, always starts with "/". */
  path: string;
  /** RFC 6838 mime type ("image/png", "application/pdf", …). */
  mimeType: string;
  /** Original filename for UI display. Optional. */
  name?: string;
  /** Byte size on disk, when the client knows. Optional. */
  size?: number;
}

// ─── Server → Client ──────────────────────────────────────────────

export type ServerMsg =
  | { type: "connected"; tenantId: string; userId: string }
  | { type: "history"; messages: WireMessage[] }
  | { type: "message_added"; message: WireMessage }
  | { type: "stream_start" }
  | { type: "stream_delta"; delta: string }
  | { type: "stream_end"; message: WireMessage }
  | { type: "stream_error"; reason: string }
  /** Agent invoked a tool. Sent before the tool runs so the UI can
   *  render an in-progress chip. */
  | {
      type: "tool_call";
      callId: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  /** Tool finished. `text` is the human-readable summary the LLM will
   *  see; `ok` lets the UI tint failures. */
  | {
      type: "tool_result";
      callId: string;
      name: string;
      ok: boolean;
      text: string;
    }
  /** A compaction pass just landed. Sent for both auto-compact (
   *  triggered by the 50% context threshold) and manual `/compact`
   *  invocations. The UI shows a "📌 history compacted" marker so
   *  the user knows their next replies are running on a summary of
   *  the older conversation. */
  | {
      type: "history_compacted";
      reason: "auto" | "manual";
      oldSessionId: string;
      newSessionId: string;
      summarisedCount: number;
      keptCount: number;
      durationMs: number;
    }
  /** Plugin enable/disable just landed. `enabled` lists plugin ids
   *  that came online (and what they brought — tools / toolsets);
   *  `disabled` lists what went away. The chat shell renders a
   *  brief notice; the agent loop also gets a synthetic system
   *  message so the model knows its tool surface changed. */
  | {
      type: "plugins_changed";
      enabled: PluginsChangedDelta[];
      disabled: PluginsChangedDelta[];
    };

export interface PluginsChangedDelta {
  pluginId: string;
  displayName: string;
  /** Tools the plugin advertises in its manifest contributes.tools[]. */
  tools: string[];
  /** Toolsets the plugin advertises in its manifest contributes.toolsets[]. */
  toolsets: string[];
}

/**
 * Display-only metadata for an assistant message. Populated by
 * `toWire()` from the persisted `AssistantMessage` (pi-ai records
 * model + usage on every turn). The chat shell renders these in a
 * tiny line under the bubble — mirrors the closed-source predecessor
 * (`packages/web/src/components/MessageBubble.tsx` MessageMeta).
 *
 * `contextWindow` lets the UI compute “12% ctx” without having to
 * call the model registry itself; we resolve it server-side from the
 * tenant config.
 */
export interface WireMessageMeta {
  /** Provider/model id as recorded by pi-ai (e.g. "claude-sonnet-4-6"). */
  model?: string;
  usage?: {
    input: number;
    output: number;
    totalTokens: number;
  };
  /** Active model's context window at the time we serialised, so the
   *  client doesn't need to look it up. */
  contextWindow?: number;
}

/** Single tool call inside an assistant message. */
export interface WireToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Tool result content surfaced for one tool call. */
export interface WireToolResult {
  callId: string;
  name: string;
  ok: boolean;
  text: string;
}

/** Ordered building blocks for an assistant message — preserves the
 *  pi-ai `content` array's interleaving of text and tool calls so
 *  the UI can render them in author order. Legacy `text` +
 *  `toolCalls` are still populated for backwards-compat. */
export type WireAssistantBlock =
  | { kind: "text"; text: string }
  | {
      kind: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };

/**
 * Wire shape for one persisted message. The DB stores either a plain
 * string (legacy) or a JSON-serialised pi-ai Message; on the wire we
 * always present a clean `{ text, toolCalls?, toolResult? }` triple
 * so the UI never has to JSON.parse content itself.
 */
export interface WireMessage {
  id: string;
  sessionId: string;
  role: ChatMessage["role"];
  /** Human-readable text. Empty string for tool-only assistant turns. */
  text: string;
  /** Tool calls authored by the assistant in this message, if any. */
  toolCalls?: WireToolCall[];
  /** Ordered text + tool-call blocks; only set on assistant messages.
   *  Older client builds ignore this and fall back to
   *  `text + toolCalls`. */
  blocks?: WireAssistantBlock[];
  /** When this message is a tool result, the structured details. */
  toolResult?: WireToolResult;
  /** Files attached to this user message (path + mimeType only — the
   *  raw bytes stay on disk). The UI renders thumbnails / chips. */
  attachments?: WireAttachment[];
  /** Display-only metadata for assistant messages (model, token
   *  usage, context window). Undefined for user / tool rows. */
  meta?: WireMessageMeta;
  createdAt: number;
}

/**
 * Optional helper a caller can supply so we can stamp
 * `contextWindow` onto the meta of an assistant message. Stays
 * optional because tests and the legacy plain-text path don't have
 * a tenant config in scope. */
export interface ToWireOpts {
  contextWindowFor?: (modelId: string) => number | undefined;
}

export function toWire(m: ChatMessage, opts: ToWireOpts = {}): WireMessage {
  const base = {
    id: m.id,
    sessionId: m.sessionId,
    role: m.role,
    createdAt: m.createdAt,
  };
  // Try parsing the content as a structured pi-ai Message; fall back
  // to treating it as plain text (legacy path).
  const parsed = tryParse(m.content);
  if (parsed && typeof parsed === "object" && parsed !== null && "role" in parsed) {
    const obj = parsed as Record<string, unknown>;
    if (obj.role === "assistant" && Array.isArray(obj.content)) {
      const parts = obj.content as Array<Record<string, unknown>>;
      const blocks: WireAssistantBlock[] = [];
      for (const c of parts) {
        if (c.type === "text" && typeof c.text === "string") {
          blocks.push({ kind: "text", text: c.text });
        } else if (c.type === "toolCall") {
          blocks.push({
            kind: "toolCall",
            id: String(c.id ?? ""),
            name: String(c.name ?? ""),
            arguments: (c.arguments as Record<string, unknown>) ?? {},
          });
        }
        // `thinking` and other future block types are intentionally
        // dropped here — the UI surfaces them through other channels.
      }
      const text = blocks
        .filter((b): b is Extract<WireAssistantBlock, { kind: "text" }> => b.kind === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls = blocks
        .filter(
          (b): b is Extract<WireAssistantBlock, { kind: "toolCall" }> =>
            b.kind === "toolCall",
        )
        .map(({ kind: _k, ...rest }) => rest);
      const meta = extractAssistantMeta(obj, opts);
      return {
        ...base,
        text,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        blocks: blocks.length > 0 ? blocks : undefined,
        meta,
      };
    }
    if (obj.role === "toolResult") {
      const content = Array.isArray(obj.content) ? (obj.content as Array<Record<string, unknown>>) : [];
      const text = content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      return {
        ...base,
        text,
        toolResult: {
          callId: String(obj.toolCallId ?? ""),
          name: String(obj.toolName ?? ""),
          ok: !obj.isError,
          text,
        },
      };
    }
    if (obj.role === "user" && Array.isArray(obj.content)) {
      const parts = obj.content as Array<Record<string, unknown>>;
      const rawText = parts
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      // Strip the agent-facing "[Attached file: name (mime) — available
      // at ./uploads/...]" markers we inject server-side so the user's
      // bubble shows their actual prose. The chip strip rendered from
      // `attachments[]` already conveys what's attached. The DB still
      // carries the marker for the agent's pi-ai context.
      const text = stripAgentAttachmentMarkers(rawText);
      // Attachment metadata: prefer the sibling `attachments` field
      // (server-set by persistUserPrompt for every attachment, image
      // or not). Fall back to deriving it from ImageContent parts so
      // legacy rows written before that field existed still render.
      const stored = Array.isArray(obj.attachments)
        ? (obj.attachments as Array<Record<string, unknown>>)
            .map((a) => ({
              path: typeof a.path === "string" ? a.path : "",
              mimeType:
                typeof a.mimeType === "string"
                  ? a.mimeType
                  : "application/octet-stream",
              name: typeof a.name === "string" ? a.name : undefined,
              size: typeof a.size === "number" ? a.size : undefined,
            }))
            .filter((a) => a.path.length > 0)
        : [];
      const fromImageParts =
        stored.length === 0
          ? parts
              .filter((c) => c.type === "image")
              .map((c) => ({
                path: typeof c.path === "string" ? c.path : "",
                mimeType:
                  typeof c.mimeType === "string"
                    ? c.mimeType
                    : "application/octet-stream",
                name: typeof c.name === "string" ? c.name : undefined,
                size: typeof c.size === "number" ? c.size : undefined,
              }))
              .filter((a) => a.path.length > 0)
          : [];
      const attachments =
        stored.length > 0 ? stored : fromImageParts;
      return {
        ...base,
        text,
        attachments: attachments.length > 0 ? attachments : undefined,
      };
    }
  }
  // Legacy: content is a bare string.
  return { ...base, text: m.content };
}

/** Pull display-only meta off a parsed pi-ai AssistantMessage.
 *  Returns undefined when nothing useful is present (legacy rows
 *  without a usage block, etc.). */
function extractAssistantMeta(
  obj: Record<string, unknown>,
  opts: ToWireOpts,
): WireMessageMeta | undefined {
  const model =
    typeof obj.model === "string" && obj.model.length > 0
      ? (obj.model as string)
      : undefined;
  const provider =
    typeof obj.provider === "string" && obj.provider.length > 0
      ? (obj.provider as string)
      : undefined;
  let usage: WireMessageMeta["usage"];
  const u = obj.usage as Record<string, unknown> | undefined;
  if (u && typeof u === "object") {
    const input = numericField(u, "input");
    const output = numericField(u, "output");
    const totalTokens = numericField(u, "totalTokens");
    if (input != null || output != null || totalTokens != null) {
      usage = {
        input: input ?? 0,
        output: output ?? 0,
        totalTokens: totalTokens ?? (input ?? 0) + (output ?? 0),
      };
    }
  }
  if (!model && !usage) return undefined;
  // pi-ai stores `model` as the bare model id and `provider` as the
  // provider id; tenant config keys models by `<provider>/<model>`.
  // Compose the lookup id when both are present so we don't have to
  // teach `contextWindowFor` about that split.
  const fullId = provider && model ? `${provider}/${model}` : model;
  const contextWindow = fullId
    ? opts.contextWindowFor?.(fullId) ?? undefined
    : undefined;
  return { model, usage, contextWindow };
}

function numericField(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function tryParse(s: string): unknown {
  if (!s || s[0] !== "{") return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Match the exact marker format emitted by chat handler's
// persistUserPrompt(). Conservative — we only strip our own marker,
// not arbitrary square-bracketed text the user might have typed.
const ATTACHMENT_MARKER_RE =
  /\[Attached file: [^\]]*— available at [^\]]*\]/g;

function stripAgentAttachmentMarkers(text: string): string {
  if (!text.includes("[Attached file: ")) return text;
  const stripped = text.replace(ATTACHMENT_MARKER_RE, "");
  // Collapse the leftover blank lines / trailing whitespace.
  return stripped
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .join("\n")
    .trim();
}
