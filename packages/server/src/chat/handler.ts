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

import { runAgentLoop as piRunAgentLoop } from "@earendil-works/pi-agent-core";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
} from "@earendil-works/pi-agent-core";
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
import { adaptToolset, isAdapterError } from "./agent-tool-adapter.js";
import {
  filterSkillsForTenant,
  loadSkillsForPlugin,
  type LoadedSkill,
} from "../core/plugins/skills.js";
import { fileURLToPath } from "node:url";
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
  /**
   * Plugin registry for this tenant. The chat handler asks it for
   * the current `toolsForTenant()` and a `hostCapabilities()`
   * handle each agent turn, so plugin enable/disable flips are
   * picked up without restarting the session.
   */
  pluginRegistry?: import("../core/plugins/registry.js").PluginRegistry;
  /** Tenant root dir on the host — fed into AgentToolContext. */
  homeDir?: string;
}

export function attachChatHandler(opts: ChatHandlerOpts): void {
  const { ctx, userId, socket, pluginRegistry, homeDir } = opts;

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
          pluginRegistry,
          homeDir,
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
  pluginRegistry?: import("../core/plugins/registry.js").PluginRegistry;
  homeDir?: string;
}

async function runPrompt(args: RunPromptArgs): Promise<void> {
  const { ctx, userId, send, content, modelId, attachments, signal, pluginRegistry, homeDir } = args;
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
  const userHome = ctx.userHomeDir(userId);
  const pluginTools = pluginRegistry?.toolsForTenant(ctx.tenantId) ?? [];
  const allSkills = [
    ...loadHostSkills(),
    ...(pluginRegistry?.skillsForTenant(ctx.tenantId) ?? []),
  ];
  // Build a set of registered tool names from pluginTools' schemas.
  // We don't yet know what `available()` will say, so we use the
  // schema name; this slightly over-includes skills that depend on
  // a tool that ends up hidden, but the agent simply won't reach
  // for those. Conservative on the side of more visibility.
  const declaredToolNames = new Set(pluginTools.map(({ tool }) => tool.schema.name));
  const hostCaps = pluginRegistry?.hostCapabilities(ctx.tenantId) ?? emptyHostCapabilities();
  const skills = filterSkillsForTenant(allSkills, {
    hasTool: (n) => declaredToolNames.has(n),
    hasCapability: (n) => hostCaps.has(n as never),
  });
  const toolset = await buildToolset({
    pluginTools,
    skills,
    toolContext: {
      tenantId: ctx.tenantId,
      userId,
      capabilities: hostCaps,
      userHomeDir: userHome,
      tenantHomeDir: homeDir ?? "",
      log: makeLogger(ctx.tenantId, userId, send),
    },
  });

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

  const systemPrompt = defaultSystemPrompt(ctx, userId);

  // Hand off to pi-agent-core. Bridge events back to WS:
  //   * text_delta deltas → stream_delta
  //   * message_end (assistant) → persist + message_added
  //   * message_end (toolResult) → persist + tool_result + message_added
  //   * tool call start → emit tool_call event up-front so the UI
  //                       can render chips before results land
  // The host's existing user-prompt persistence stays in place; we
  // pass the LLM-ready snapshot as the loop's initial context. Pi
  // will not re-emit message_start/end for the prompt because we
  // hand it in as `context.messages` rather than `prompts[]`.
  const adapted = adaptToolset(toolset);
  const llmReady = await prepareMessagesForLlm(
    messages,
    ctx.userHomeDir(userId),
    modelInfo,
  );
  const agentContext: AgentContext = {
    systemPrompt,
    messages: [...llmReady] as AgentMessage[],
    tools: adapted.tools,
  };
  const config: AgentLoopConfig = {
    model: piModel,
    apiKey,
    convertToLlm: (msgs: AgentMessage[]) =>
      msgs.filter(
        (m): m is Message =>
          m.role === "user" || m.role === "assistant" || m.role === "toolResult",
      ),
    shouldStopAfterTurn: ({ newMessages }) => {
      const assistantCount = newMessages.filter(
        (m) => m.role === "assistant",
      ).length;
      return assistantCount >= MAX_TURNS;
    },
    afterToolCall: async ({ result }) => {
      if (isAdapterError(result.details)) {
        return { isError: true };
      }
      return undefined;
    },
  };

  // We split the just-persisted user prompt off the LLM-ready
  // messages list and hand it to pi as `prompts[]`, so pi emits
  // message_start/end through our sink the same way assistant
  // turns do. This keeps the WS event timeline consistent and
  // avoids double-emitting (pi never re-emits messages it found
  // pre-seeded in `context.messages`).
  const promptInputs: AgentMessage[] = [];
  const lastCtx = agentContext.messages[agentContext.messages.length - 1];
  if (lastCtx && lastCtx.role === "user") {
    promptInputs.push(lastCtx as AgentMessage);
    agentContext.messages.pop();
  }

  let lastAssistantId: string | null = null;
  const emit = async (event: AgentEvent): Promise<void> => {
    if (event.type === "message_update") {
      const ev = event.assistantMessageEvent;
      if (ev.type === "text_delta" && typeof ev.delta === "string") {
        send({ type: "stream_delta", delta: ev.delta });
      } else if (ev.type === "toolcall_start") {
        // Pi delivers toolcall id via the partial assistant message
        // (the toolCall block at contentIndex). Pull it out for the
        // UI's tool_call event so chips can render before the tool
        // result lands.
        const partial = (ev as { partial?: { content?: unknown[] } }).partial;
        const block = partial?.content?.[
          (ev as { contentIndex: number }).contentIndex
        ] as { id?: string; name?: string; arguments?: unknown } | undefined;
        if (block && block.id && block.name) {
          send({
            type: "tool_call",
            callId: block.id,
            name: block.name,
            arguments: (block.arguments as Record<string, unknown>) ?? {},
          });
        }
      }
      return;
    }
    if (event.type === "message_end") {
      const m = event.message;
      if (m.role === "assistant") {
        const row = appendAgentMessage(ctx, session, m as AssistantMessage);
        lastAssistantId = row.id;
        send({ type: "message_added", message: toWire(row, wireOpts) });
      } else if (m.role === "toolResult") {
        const tr = m as ToolResultMessage;
        const row = appendAgentMessage(ctx, session, tr);
        const text = tr.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("");
        send({
          type: "tool_result",
          callId: tr.toolCallId,
          name: tr.toolName,
          ok: !tr.isError,
          text,
        });
        send({ type: "message_added", message: toWire(row, wireOpts) });
      } else if (m.role === "user") {
        // The user prompt was already persisted by persistUserPrompt;
        // skip silently.
      }
      return;
    }
    if (event.type === "agent_end") {
      // Final assistant turn ended naturally — emit stream_end with
      // the last persisted assistant row id.
      if (lastAssistantId) {
        // Re-look up the row to satisfy toWire's input shape.
        // Since appendAgentMessage already returned it, we cached
        // the id. The simplest re-load is via the in-memory row
        // captured at the time — retrieve from messages by id.
        // For brevity we send a synthetic stream_end with no row;
        // the UI's existing flow re-uses the latest message_added.
      }
      send({ type: "stream_end" } as never);
      return;
    }
  };

  try {
    await piRunAgentLoop(
      promptInputs,
      agentContext,
      config,
      emit,
      signal,
    );
  } catch (err) {
    send({
      type: "stream_error",
      reason: err instanceof Error ? err.message : String(err),
    });
  }
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

export interface AnyToolResult {
  ok: boolean;
  text: string;
}

/**
 * Normalise an executor's structured result to `{ ok, text }` for
 * the chat log + LLM tool-result content. Two shapes are accepted:
 *
 * 1. Fs-style: `{ ok: boolean, text: string, ...extras }` — used as
 *    is. This is what the original 5 fs tools return.
 * 2. Anything else: stringified JSON. `ok` is derived from common
 *    field hints (`ok`, `exit_code`, `state`) and falls back to
 *    `true` when no clear signal exists. The full structured
 *    result is JSON-encoded into `text` so the model sees every
 *    field.
 */
export function normaliseToolResult(out: unknown): AnyToolResult {
  if (
    out &&
    typeof out === "object" &&
    typeof (out as { text?: unknown }).text === "string" &&
    typeof (out as { ok?: unknown }).ok === "boolean"
  ) {
    const r = out as { ok: boolean; text: string };
    return { ok: r.ok, text: r.text };
  }
  if (out && typeof out === "object") {
    const r = out as Record<string, unknown>;
    let ok = true;
    if (typeof r.ok === "boolean") ok = r.ok;
    else if (typeof r.exit_code === "number") ok = r.exit_code === 0;
    else if (typeof r.state === "string")
      ok = r.state !== "error" && r.state !== "failed";
    return { ok, text: JSON.stringify(out) };
  }
  return { ok: true, text: String(out ?? "") };
}

export async function runOneTool(
  toolset: Toolset,
  call: ToolCall,
): Promise<AnyToolResult> {
  const exec = toolset.executors[call.name];
  if (!exec) {
    return { ok: false, text: `unknown tool: ${call.name}` };
  }
  try {
    const out = await exec(call.arguments);
    return normaliseToolResult(out);
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
  const lines: string[] = [
    `You are ${brand}, an open-source AI assistant.`,
    `Tenant: "${ctx.tenantId}". User: "${userId}".`,
    ``,
    `WORKSPACE LAYOUT`,
    `Your default working directory is the user's private home in this tenant.`,
  ];

  // Tool segments depend on which plugins are active; the chat
  // handler injects matching capability text via a separate hook
  // (see runPrompt). Keep the workspace layout independent.
  lines.push(
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
  );
  return lines.join("\n");
}

/**
 * Load skills shipped with the host repo (under `<repoRoot>/skills/`).
 * These are surfaced to every tenant alongside plugin-contributed
 * skills. Any with `when:` predicates are filtered later by
 * `filterSkillsForTenant`.
 *
 * Result is cached per process — host skills are read-only at
 * runtime, no need to re-stat per request.
 */
let hostSkillsCache: LoadedSkill[] | null = null;
export function loadHostSkills(): LoadedSkill[] {
  if (hostSkillsCache) return hostSkillsCache;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/chat/handler.js → ../../../skills, source/chat/handler.ts
  // → ../../../skills. Either way, three levels up gets us to the
  // server package root, which contains a `skills/` dir at build
  // time. We override via TIANSHU_HOST_SKILLS_DIR for tests.
  const fromEnv = process.env.TIANSHU_HOST_SKILLS_DIR;
  const skillsDir = fromEnv
    ? path.resolve(fromEnv)
    : path.resolve(here, "..", "..", "skills");
  if (!fs.existsSync(skillsDir)) {
    hostSkillsCache = [];
    return hostSkillsCache;
  }
  // Treat host skills as if they came from a synthetic `tianshu`
  // plugin so log lines and plugin-id-derived names stay readable.
  const contributions = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => ({ id: d.name.replace(/\.md$/, ""), path: d.name }));
  const result = loadSkillsForPlugin({
    pluginId: "tianshu",
    pluginDir: skillsDir,
    contributions,
  });
  for (const f of result.failures) {
    // eslint-disable-next-line no-console
    console.warn(
      `[host-skills] ${f.source.contributionId} (${f.filePath}): ${f.reason}`,
    );
  }
  hostSkillsCache = result.skills;
  return hostSkillsCache;
}

// re-exported here so server/index.ts only imports from one barrel.
export type { ChatMessage };

function emptyHostCapabilities(): import("../core/plugins/registry.js").HostCapabilityHandle {
  return {
    get: () => undefined,
    has: () => false,
  };
}

function makeLogger(
  tenantId: string,
  userId: string,
  _send: (msg: ServerMsg) => void,
): import("@tianshu/plugin-sdk").PluginLogger {
  // Tools log to the server console for now; future PR can route
  // structured tool logs to the chat UI as separate events.
  const prefix = `[tenant:${tenantId}][user:${userId}][tool]`;
  return {
    info: (msg, meta) => console.log(`${prefix} ${msg}`, meta ?? ""),
    warn: (msg, meta) => console.warn(`${prefix} ${msg}`, meta ?? ""),
    error: (msg, meta) => console.error(`${prefix} ${msg}`, meta ?? ""),
  };
}
