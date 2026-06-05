// WebSocket chat handler — wires together the tenant context, the
// message store, pi-ai's streamSimple, and the agent fs tools.
//
// Loop:
//   1. user prompt arrives → append user message
//   2. streamSimple with full history + tool schemas
//   3. on toolcall_end events: run the tool against the per-user
//      home, append tool_result to history, broadcast tool_call /
//      tool_result events
//   4. if the assistant message stops with `toolUse`, call
//      streamSimple again with the appended ToolResultMessage(s).
//   5. otherwise persist the assistant text and emit stream_end.
//
// We cap the number of tool turns per prompt at MAX_TURNS so a model
// stuck in a feedback loop terminates instead of melting the host.

import { streamSimple } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ImageContent,
  Message,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import {
  buildModel,
  findModel,
  getDefaultModel,
  resolveApiKey,
  type ResolvedModelInfo,
  type TenantContext,
} from "../core/index.js";
import { buildToolset, type Toolset } from "../tools/index.js";
import {
  appendAgentMessage,
  appendMessage,
  ensureActiveSession,
  listMessagesForUser,
  loadAgentHistory,
  loadAgentHistoryForSession,
  type ChatMessage,
  type ChatSession,
} from "./messages.js";
import {
  COMPACT_THRESHOLD,
  CompactSkippedError,
  compactSession,
} from "./compact.js";
import { estimateTokens } from "./token-estimate.js";
import {
  toWire,
  type ClientMsg,
  type ServerMsg,
  type ToWireOpts,
  type WireAttachment,
} from "./ws-protocol.js";
import {
  cacheGet,
  cachePut,
  fitToLimit,
  imageFitCacheKey,
} from "./image-fit.js";

const MAX_TURNS = 16;

export interface ChatHandlerOpts {
  ctx: TenantContext;
  userId: string;
  socket: WebSocket;
}

export function attachChatHandler(opts: ChatHandlerOpts): void {
  const { ctx, userId, socket } = opts;

  const send = (msg: ServerMsg) => {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(msg));
  };

  send({ type: "connected", tenantId: ctx.tenantId, userId });

  let aborter: AbortController | null = null;

  socket.on("message", (raw) => {
    let parsed: ClientMsg;
    try {
      parsed = JSON.parse(raw.toString()) as ClientMsg;
    } catch {
      return;
    }

    switch (parsed.type) {
      case "hello":
        send({ type: "connected", tenantId: ctx.tenantId, userId });
        return;
      case "history": {
        const opts = makeWireOpts(ctx);
        const messages = listMessagesForUser(ctx, userId).map((m) =>
          toWire(m, opts),
        );
        send({ type: "history", messages });
        return;
      }
      case "prompt": {
        if (aborter) aborter.abort(); // single in-flight prompt per socket
        aborter = new AbortController();
        // Slash-command: `/compact` runs an immediate compaction
        // pass without sending a fresh user prompt. Recognised when
        // the typed body is exactly the marker plus optional
        // whitespace and (for parity with the legacy CLI) `!`.
        const trimmed = parsed.content.trim();
        if (trimmed === "/compact" || trimmed === "/compact!") {
          runManualCompact({
            ctx,
            userId,
            send,
            modelId: parsed.modelId,
            signal: aborter.signal,
          }).catch((err) => {
            send({
              type: "stream_error",
              reason: err instanceof Error ? err.message : String(err),
            });
          });
          return;
        }
        runPrompt({
          ctx,
          userId,
          send,
          content: parsed.content,
          modelId: parsed.modelId,
          attachments: parsed.attachments,
          signal: aborter.signal,
        }).catch((err) => {
          send({
            type: "stream_error",
            reason: err instanceof Error ? err.message : String(err),
          });
        });
        return;
      }
      case "abort": {
        aborter?.abort();
        aborter = null;
        return;
      }
    }
  });

  socket.on("close", () => {
    aborter?.abort();
    aborter = null;
  });
}

interface RunPromptArgs {
  ctx: TenantContext;
  userId: string;
  send: (msg: ServerMsg) => void;
  content: string;
  modelId?: string;
  attachments?: WireAttachment[];
  signal: AbortSignal;
}

async function runPrompt(args: RunPromptArgs): Promise<void> {
  const { ctx, userId, send, content, modelId, attachments, signal } = args;
  const wireOpts = makeWireOpts(ctx);

  let session = ensureActiveSession(ctx, userId);

  // Resolve the model up front — we need imageMaxBytes / context
  // window for both auto-compact and the LLM call below.
  const modelInfo = (modelId ? findModel(ctx.config, modelId) : undefined) ?? getDefaultModel(ctx.config);
  if (!modelInfo) {
    send({
      type: "stream_error",
      reason: "no models configured (set models in ~/.tianshu/config.json)",
    });
    return;
  }

  const piModel = buildModel(modelInfo);
  const apiKey = resolveApiKey(modelInfo);
  const toolset = buildToolset(ctx.userHomeDir(userId));

  // Auto-compact BEFORE persisting the new user message: we want
  // the next turn to land in the post-compact session, not stuck
  // attached to the about-to-be-archived one. The compact decision
  // looks at the existing log only; the new prompt's contribution
  // is bounded by the model's tools-and-prompt budget anyway.
  session = await maybeAutoCompact({
    ctx,
    userId,
    session,
    modelInfo,
    toolset,
    send,
    signal,
  });

  // Build a multimodal UserMessage on disk (path-only, no base64).
  // Non-image attachments still appear in the wire `attachments`
  // list so the UI can render chips, but the agent learns about
  // them via a brief text note in the message body — it then
  // calls `read_file` if it actually wants the contents.
  const userMsg = persistUserPrompt(ctx, session, content, attachments);
  send({ type: "message_added", message: toWire(userMsg, wireOpts) });

  send({ type: "stream_start" });

  // Hydrate the conversation log from disk — SCOPED TO THE ACTIVE
  // SESSION so a recently-compacted parent session doesn't bleed
  // back into the agent's context.
  const { messages } = loadAgentHistoryForSession(ctx, session.id, {
    api: modelInfo.api,
    provider: modelInfo.providerId,
    model: modelInfo.modelId,
  });

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (signal.aborted) return;

    const piContext: Context = {
      systemPrompt: defaultSystemPrompt(ctx, userId),
      // Inline base64 image data only at this point so the bytes
      // never reach disk via the conversation log. The on-disk
      // representation stays path-only — cheap, queryable,
      // independent of base64 encoding choices.
      messages: await prepareMessagesForLlm(
        messages,
        ctx.userHomeDir(userId),
        modelInfo,
      ),
      tools: toolset.schemas,
    };

    const stream = streamSimple(piModel, piContext, { signal, apiKey });
    const final = await consumeStream(stream, send);
    if (!final) return; // error already sent

    // Persist + push the assistant turn (text, thinking, and any
    // tool calls — the full structured message goes to disk so the
    // UI can replay the conversation faithfully on reload).
    const assistantRow = appendAgentMessage(ctx, session, final);
    messages.push(final);

    if (final.stopReason === "toolUse") {
      const toolCalls = final.content.filter(
        (c): c is ToolCall => c.type === "toolCall",
      );
      if (toolCalls.length === 0) {
        break; // claimed toolUse but emitted none — bail
      }

      // Surface the assistant turn now so the UI can show the
      // tool-call chips before any results land.
      send({ type: "message_added", message: toWire(assistantRow, wireOpts) });

      for (const call of toolCalls) {
        send({
          type: "tool_call",
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
        });

        const result = await runOneTool(toolset, call);
        const summary = describeResult(result);
        const toolResult: ToolResultMessage = {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: summary } as TextContent],
          isError: !result.ok,
          timestamp: Date.now(),
        };
        const toolRow = appendAgentMessage(ctx, session, toolResult);
        send({
          type: "tool_result",
          callId: call.id,
          name: call.name,
          ok: result.ok,
          text: summary,
        });
        send({ type: "message_added", message: toWire(toolRow, wireOpts) });
        messages.push(toolResult);
      }
      continue;
    }

    // stopReason: stop | length — done.
    send({ type: "stream_end", message: toWire(assistantRow, wireOpts) });
    return;
  }

  send({
    type: "stream_error",
    reason: `agent loop exceeded ${MAX_TURNS} turns without resolving`,
  });
}

/** Run a single pi-ai stream to completion, forwarding text deltas
 *  to the WS and returning the final AssistantMessage. Sends a
 *  `stream_error` and returns null if the stream errored. */
async function consumeStream(
  stream: AsyncIterable<AssistantMessageEvent>,
  send: (msg: ServerMsg) => void,
): Promise<AssistantMessage | null> {
  let final: AssistantMessage | null = null;
  for await (const event of stream) {
    if (event.type === "text_delta") {
      send({ type: "stream_delta", delta: event.delta });
    } else if (event.type === "done") {
      final = event.message;
    } else if (event.type === "error") {
      const reason = event.error?.errorMessage ?? "stream_error";
      send({ type: "stream_error", reason });
      return null;
    }
  }
  return final;
}

interface AnyToolResult {
  ok: boolean;
  text: string;
}

async function runOneTool(toolset: Toolset, call: ToolCall): Promise<AnyToolResult> {
  const exec = toolset.executors[call.name];
  if (!exec) {
    return { ok: false, text: `unknown tool: ${call.name}` };
  }
  try {
    const out = await exec(call.arguments);
    return { ok: out.ok, text: out.text };
  } catch (err) {
    return {
      ok: false,
      text: err instanceof Error ? err.message : String(err),
    };
  }
}

function describeResult(r: AnyToolResult): string {
  return r.text;
}

/** Build a `ToWireOpts` bound to the current tenant config. The
 *  resolver lets `toWire` stamp `meta.contextWindow` on every
 *  assistant row without each caller having to do the lookup. */
function makeWireOpts(ctx: TenantContext): ToWireOpts {
  return {
    contextWindowFor: (modelId: string) => {
      const info = findModel(ctx.config, modelId);
      return info?.contextWindow;
    },
  };
}

// ─── compaction helpers ───────────────────────────────────────────────

/** Run a compaction pass if the projected input crosses the
 *  threshold. Returns the (possibly new) active session. The
 *  outbound socket gets a "history_compacted" notice on success so
 *  the UI can show a "📌 historical chat compressed" marker.
 *
 *  Errors during compaction are non-fatal: we log them, surface a
 *  stream_error notice, and keep the original session. The user
 *  loses the auto-compact for this turn but the prompt still goes
 *  out (better one expensive turn than a hard failure). */
async function maybeAutoCompact(args: {
  ctx: TenantContext;
  userId: string;
  session: ChatSession;
  modelInfo: ResolvedModelInfo;
  toolset: Toolset;
  send: (msg: ServerMsg) => void;
  signal: AbortSignal;
}): Promise<ChatSession> {
  const { ctx, userId, session, modelInfo, toolset, send, signal } = args;
  if (!modelInfo.contextWindow || modelInfo.contextWindow <= 0) {
    return session;
  }
  const { messages, rows } = loadAgentHistoryForSession(ctx, session.id, {
    api: modelInfo.api,
    provider: modelInfo.providerId,
    model: modelInfo.modelId,
  });
  if (messages.length < 4) return session; // not worth

  const tokens = estimateTokens({
    systemPrompt: defaultSystemPrompt(ctx, userId),
    messages,
    tools: toolset.schemas,
  });
  const trigger = Math.floor(modelInfo.contextWindow * COMPACT_THRESHOLD);
  if (tokens < trigger) return session;

  try {
    const result = await compactSession({
      ctx,
      userId,
      oldSession: session,
      pi: messages,
      rows,
      modelInfo,
      signal,
    });
    send({
      type: "history_compacted",
      reason: "auto",
      oldSessionId: result.oldSessionId,
      newSessionId: result.newSession.id,
      summarisedCount: result.summarisedCount,
      keptCount: result.keptCount,
      durationMs: result.durationMs,
    });
    return result.newSession;
  } catch (err) {
    if (err instanceof CompactSkippedError) return session;
    send({
      type: "stream_error",
      reason: `auto-compact failed: ${err instanceof Error ? err.message : String(err)} (continuing without compact)`,
    });
    return session;
  }
}

async function runManualCompact(args: {
  ctx: TenantContext;
  userId: string;
  send: (msg: ServerMsg) => void;
  modelId?: string;
  signal: AbortSignal;
}): Promise<void> {
  const { ctx, userId, send, modelId, signal } = args;
  const session = ensureActiveSession(ctx, userId);
  const modelInfo =
    (modelId ? findModel(ctx.config, modelId) : undefined) ??
    getDefaultModel(ctx.config);
  if (!modelInfo) {
    send({
      type: "stream_error",
      reason: "no models configured",
    });
    return;
  }
  const { messages, rows } = loadAgentHistoryForSession(ctx, session.id, {
    api: modelInfo.api,
    provider: modelInfo.providerId,
    model: modelInfo.modelId,
  });
  if (messages.length === 0) {
    send({
      type: "stream_error",
      reason: "nothing to compact (no messages yet)",
    });
    return;
  }
  try {
    const result = await compactSession({
      ctx,
      userId,
      oldSession: session,
      pi: messages,
      rows,
      modelInfo,
      signal,
    });
    send({
      type: "history_compacted",
      reason: "manual",
      oldSessionId: result.oldSessionId,
      newSessionId: result.newSession.id,
      summarisedCount: result.summarisedCount,
      keptCount: result.keptCount,
      durationMs: result.durationMs,
    });
    // Push a refreshed history so the UI swaps to the new session
    // immediately (the fork ack + summary stub plus any kept tail).
    const wire = listMessagesForUser(ctx, userId).map((m) =>
      toWire(m, makeWireOpts(ctx)),
    );
    send({ type: "history", messages: wire });
  } catch (err) {
    if (err instanceof CompactSkippedError) {
      send({ type: "stream_error", reason: `compact skipped: ${err.message}` });
      return;
    }
    send({
      type: "stream_error",
      reason: `compact failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// ─── attachment helpers ───────────────────────────────────────────────

/**
 * Image content carries a sentinel `path` field on disk so the LLM
 * call site can resolve it to bytes. pi-ai's ImageContent type
 * doesn't declare it, but extra properties are passed through
 * untouched until the live conversion happens.
 *
 * Same shape as the closed-source predecessor uses
 * (`packages/server/src/agent-manager.ts`).
 */
interface PathImageContent extends ImageContent {
  path?: string;
  name?: string;
  size?: number;
}

/** Persist the user's prompt as a multimodal UserMessage when there
 *  are image attachments; otherwise as a plain text string (matches
 *  PR #21 baseline). Always carries the full attachments array as a
 *  sibling field so the UI can re-render chips for non-image
 *  attachments after a reload. */
function persistUserPrompt(
  ctx: TenantContext,
  session: ReturnType<typeof ensureActiveSession>,
  content: string,
  attachments: WireAttachment[] | undefined,
): ChatMessage {
  const atts = attachments ?? [];
  if (atts.length === 0) {
    return appendMessage(ctx, session, { role: "user", content });
  }

  const textParts: string[] = [];
  if (content.trim().length > 0) textParts.push(content);
  const imageParts: PathImageContent[] = [];

  for (const att of atts) {
    if (isImageMime(att.mimeType)) {
      imageParts.push({
        type: "image",
        // pi-ai's ImageContent declares `data` mandatory; we put a
        // placeholder here and overwrite at LLM-call time.
        data: "",
        mimeType: att.mimeType,
        path: att.path,
        name: att.name,
        size: att.size,
      });
    } else {
      // Non-image: nudge the agent toward the right read_file call
      // without dumping bytes into the conversation log.
      textParts.push(
        `[Attached file: ${att.name ?? att.path} (${att.mimeType}) — available at .${att.path}]`,
      );
    }
  }

  const piContent: (TextContent | PathImageContent)[] = [];
  if (textParts.length > 0) {
    piContent.push({ type: "text", text: textParts.join("\n") });
  }
  piContent.push(...imageParts);

  // Always carry the full attachments list as a sibling field so the
  // wire layer (toWire) can render non-image chips after reload too.
  const userMessage: UserMessage & { attachments: WireAttachment[] } = {
    role: "user",
    content: piContent.length > 0
      ? piContent
      : [{ type: "text", text: "" }],
    timestamp: Date.now(),
    attachments: atts,
  } as UserMessage & { attachments: WireAttachment[] };
  return appendAgentMessage(ctx, session, userMessage);
}

function isImageMime(m: string): boolean {
  return typeof m === "string" && m.startsWith("image/");
}

/**
 * Walk the message log and replace every UserMessage's image parts:
 *
 *   - When the model supports vision and the file exists on disk:
 *     inline the base64 bytes into ImageContent.data.
 *   - When the model is text-only OR the file vanished: replace the
 *     image part with a short text note so the request isn't
 *     rejected by providers that refuse mixed content.
 *
 * The original `messages` array is not mutated; we return a fresh
 * array suitable for piContext.messages.
 */
export async function prepareMessagesForLlm(
  messages: Message[],
  userHome: string,
  modelInfo: ResolvedModelInfo,
): Promise<Message[]> {
  // Sequential rather than parallel-fancy: there's typically <=2
  // images in flight at a time and sharp uses libvips which is
  // already multi-threaded internally.
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    const hasImage = m.content.some((p) => p.type === "image");
    if (!hasImage) {
      out.push(m);
      continue;
    }

    const parts: (TextContent | ImageContent)[] = [];
    for (const part of m.content) {
      if (part.type !== "image") {
        parts.push(part);
        continue;
      }
      const img = part as PathImageContent;
      const name = img.name ?? (img.path ? path.basename(img.path) : "image");
      if (!modelInfo.supportsImages) {
        parts.push({
          type: "text",
          text: `[Attached image (current model has no vision support): ${name}]`,
        });
        continue;
      }
      if (!img.path) {
        // Already inlined? Pass through as-is.
        parts.push({ ...img });
        continue;
      }
      const abs = path.join(
        userHome,
        img.path.startsWith("/") ? img.path.slice(1) : img.path,
      );
      try {
        const stat = fs.statSync(abs);
        const cacheKey = imageFitCacheKey(
          abs,
          stat.mtimeMs,
          modelInfo.imageMaxBytes,
        );
        const cached = cacheGet(cacheKey);
        let buf: Buffer;
        let mimeType: string;
        if (cached) {
          buf = cached.buf;
          mimeType = cached.mimeType;
        } else {
          const raw = fs.readFileSync(abs);
          // Most images sail through (already small); for the rest
          // fitToLimit transcodes to a byte-bounded JPEG.
          const fitted = await fitToLimit(
            raw,
            img.mimeType,
            modelInfo.imageMaxBytes,
          );
          buf = fitted.buf;
          mimeType = fitted.mimeType;
          cachePut(cacheKey, buf, mimeType);
        }
        parts.push({
          type: "image",
          data: buf.toString("base64"),
          mimeType,
        });
      } catch (err) {
        const reason =
          (err as { message?: string } | null)?.message ?? "read failed";
        // Two failure shapes — the file vanished, or fitToLimit
        // exhausted its retry ladder. Either way we don't want to
        // poison the request: degrade to a text note.
        parts.push({
          type: "text",
          text: `[Attached image (${reason}): ${name}]`,
        });
      }
    }

    // Coalesce consecutive text parts — some providers don't like
    // a chain of tiny text fragments.
    const coalesced: (TextContent | ImageContent)[] = [];
    for (const p of parts) {
      const last = coalesced[coalesced.length - 1];
      if (last && last.type === "text" && p.type === "text") {
        last.text = last.text ? `${last.text}\n${p.text}` : p.text;
      } else {
        coalesced.push(p);
      }
    }
    out.push({ ...m, content: coalesced });
  }
  return out;
}



/**
 * Build the system prompt the orchestrator runs with.
 *
 * The prompt encodes the workspace scaffold defined in ADR-0001 so the
 * agent has a stable mental model of where things live:
 *
 *   - Default cwd is the user's per-tenant home (`users/<userId>/`).
 *   - Projects, uploads, scratch and trash all live under that home.
 *   - The shared `_tenant/` area is read-only by convention (team
 *     persona / memory / config).
 *
 * Tools currently expose a path model rooted at the user's home, so
 * paths in this prompt are written relative to `./` (= cwd) for
 * exactly that reason. When sandbox mounts land (PR #22+) the absolute
 * `/workspace/...` view will become real and we'll surface it here.
 *
 * Worker / task vocabulary is intentionally absent: workers don't ship
 * until PR #23+, and dangling references just let the model fabricate.
 */
export function defaultSystemPrompt(ctx: TenantContext, userId: string): string {
  const brand = ctx.config.branding?.name ?? "Tianshu";
  return [
    `You are ${brand}, an open-source AI assistant.`,
    `Tenant: "${ctx.tenantId}". User: "${userId}".`,
    ``,
    `WORKSPACE LAYOUT`,
    `Your default working directory is the user's private home in this tenant.`,
    `Filesystem tools (list_dir, read_file, write_file, edit_file, glob) operate`,
    `relative to this home ("/" = home).`,
    ``,
    `Personal directories (use freely):`,
    `  ./projects/<slug>/   active work; reports, code, deliverables go here.`,
    `  ./uploads/           files the user uploaded for you to look at.`,
    `  ./tmp/               scratch space; clean up after yourself.`,
    `  ./trash/             soft-delete; move things here instead of removing them.`,
    `  ./USER.md            personal preferences (read on demand).`,
    ``,
    `Conventions:`,
    `  - Deliverables go to ./projects/<slug>/, never the home root.`,
    `  - When the user uploads a file, expect it under ./uploads/.`,
    `  - Don't leave scratch artefacts in ./projects/ or the root — use ./tmp/.`,
    `  - Other users' homes in this tenant are off-limits; you cannot reach them.`,
    ``,
    `Reply concisely. When you make changes, briefly say what you changed.`,
  ].join("\n");
}

// re-exported here so server/index.ts only imports from one barrel.
export type { ChatMessage };
