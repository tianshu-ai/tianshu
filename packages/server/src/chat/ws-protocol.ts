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
  /**
   * Initial / refresh history fetch.
   *
   * Returns the most recent `limit` messages (ascending by
   * created_at, like a chat log). Default 100; max 500. Older
   * messages can be paged in via `history_more`.
   *
   * Without paging, busy users can rack up thousands of messages
   * across sessions and a fresh socket would have to ship the
   * whole transcript on connect — both server (one big query +
   * frame) and client (one big render) suffer. With paging, the
   * usual fast-path stays fast and only users who scroll up pay
   * the cost of older history.
   */
  | { type: "history"; limit?: number; sessionId?: string }
  /**
   * Page in older history, exclusive of `before`. Cursor is the
   * oldest message id currently in the client's store; server
   * returns the next `limit` messages older than that id.
   */
  | {
      type: "history_more";
      before: string;
      limit?: number;
      sessionId?: string;
    }
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
  /**
   * Replaces the client's current message list. Sent on initial
   * `history` request and after a session switch. `hasMore` tells
   * the client whether older pages exist (drives the "Load
   * earlier" button visibility).
   */
  | { type: "history"; messages: WireMessage[]; hasMore: boolean }
  /**
   * Prepends an older page to the client's current message list.
   * Sent in response to `history_more`. `messages` are still in
   * ascending order (oldest first).
   */
  | {
      type: "history_page";
      messages: WireMessage[];
      hasMore: boolean;
      before: string;
    }
  | { type: "message_added"; message: WireMessage; sessionId?: string }
  | { type: "stream_start" }
  | { type: "stream_delta"; delta: string }
  | { type: "stream_end"; message: WireMessage }
  | { type: "stream_error"; reason: string }
  /**
   * A transient LLM call failure is being retried. Emitted once per
   * retry attempt so the UI can show a small "retrying…" notice with
   * the reason and how long we're waiting. Purely informational — the
   * stream continues normally on success, or ends with `stream_error`
   * if all attempts are exhausted.
   */
  | {
      type: "model_retry";
      /** 1-based attempt that just failed (the retry is attempt+1). */
      attempt: number;
      /** Total attempts allowed (including the first try). */
      maxAttempts: number;
      /** Short reason label, e.g. "http-429" / "network" / "rate-limit". */
      kind: string;
      /** Backoff before the next attempt, in ms. */
      delayMs: number;
      /** True when the failure is a rate limit (drives a distinct icon). */
      rateLimited: boolean;
      /** Human-readable one-liner for the notice. */
      message: string;
      /** True when partial content had already streamed before the
       *  failure; the client should reset its in-progress bubble (a
       *  `stream_reset` is also sent) so the rebuilt answer doesn't
       *  duplicate the aborted half. */
      contentStreamed: boolean;
      sessionId?: string;
    }
  /**
   * Discard the in-progress streaming bubble. Sent when a mid-stream
   * failure is being retried and content had already streamed — the
   * retry rebuilds the message from scratch, so the client clears what
   * it has before the replay's deltas arrive. Followed by fresh
   * `stream_delta`s (no new `stream_start`).
   */
  | { type: "stream_reset"; sessionId?: string }
  /** Agent invoked a tool. Sent before the tool runs so the UI can
   *  render an in-progress chip. */
  | {
      type: "tool_call";
      callId: string;
      name: string;
      arguments: Record<string, unknown>;
      sessionId?: string;
    }
  /** Tool finished. `text` is the human-readable summary the LLM will
   *  see; `ok` lets the UI tint failures. */
  | {
      type: "tool_result";
      callId: string;
      name: string;
      ok: boolean;
      text: string;
      sessionId?: string;
    }
  /** A compaction pass just landed. Sent for both auto-compact (
   *  triggered by pi's `shouldCompact()` against the model's
   *  context window) and manual `/compact` invocations. The UI
   *  shows a "📌 history compacted" marker so the user knows
   *  their next replies are running on a summary of the older
   *  conversation. */
  | {
      type: "history_compacted";
      reason: "auto" | "manual";
      oldSessionId: string;
      newSessionId: string;
      summarisedCount: number;
      keptCount: number;
      durationMs: number;
      /** Estimated context tokens before compaction. Only set on
       *  the harness-driven auto-compact path; the legacy
       *  /compact slash command still leaves this undefined. */
      tokensBefore?: number;
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
    }
  /**
   * Channel sessions changed (created / deleted / message landed).
   * Plugins listening on this re-poll their session lists; the
   * host sidebar reflects new threads without waiting for the
   * next interval.
   *
   * `channelId` is the channel that produced the event ("wechat"
   * / etc.) so listeners can filter — a plugin doesn't care
   * about another channel's churn.
   */
  | { type: "channel_session_changed"; channelId: string }
  /**
   * Tool catalog drifted vs. what this connection's last session
   * was stamped under — typically because the host was upgraded
   * while the user was offline (or while their tabs were closed).
   * The chat UI shows a small banner; the agent's next turn picks
   * up the same delta from history via flushToolDeltaForSession.
   *
   * Fired once per WS connection at attach time — every member of
   * a tenant gets one when they next connect after an upgrade,
   * regardless of whether they themselves triggered any plugin
   * change. New tools, removed tools, version-bump-with-no-tool-
   * change all reuse this event so the client doesn't need to
   * model every case.
   */
  | {
      type: "tool_catalog_changed";
      fromVersion: string | null;
      toVersion: string;
      newTools: ReadonlyArray<{ name: string; pluginId: string }>;
    }
  /**
   * Generic passthrough for a plugin's `ctx.broadcast(type, payload)`.
   * The host wraps it as `{type:"plugin_event", event:"<pluginId>:<type>",
   * payload}` so plugin frontends can subscribe over the shared /ws
   * without adding a bespoke ServerMsg variant per plugin event.
   * (workboard uses event "workboard:workboard.task" to push kanban
   * task updates so the board can drop its 3s poll.)
   */
  | { type: "plugin_event"; event: string; payload: unknown };

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
      // (server-set by SqliteSessionStorage.appendEntry for every
      // attachment, image or not). Fall back to deriving it from
      // ImageContent parts so legacy rows written before that field
      // existed still render.
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

// Match the marker formats the chat handler injects so the agent
// has a path for non-image attachments. Conservative — we only
// strip our own markers, not arbitrary square-bracketed text the
// user might have typed. Two phrasings are matched:
//   - `— available at .<path>`  (legacy, written by pre-N+6.4
//     persistUserPrompt rows still in the DB)
//   - `— readable at .<path>`   (current, written by
//     prepareUserInput)
const ATTACHMENT_MARKER_RE =
  /\[Attached file: [^\]]*— (?:available|readable) at [^\]]*\]/g;

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
