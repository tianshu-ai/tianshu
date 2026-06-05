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
  type ChatMessage,
} from "./messages.js";
import {
  toWire,
  type ClientMsg,
  type ServerMsg,
  type WireAttachment,
} from "./ws-protocol.js";

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
        const messages = listMessagesForUser(ctx, userId).map(toWire);
        send({ type: "history", messages });
        return;
      }
      case "prompt": {
        if (aborter) aborter.abort(); // single in-flight prompt per socket
        aborter = new AbortController();
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

  const session = ensureActiveSession(ctx, userId);
  // Build a multimodal UserMessage on disk (path-only, no base64).
  // Non-image attachments still appear in the wire `attachments`
  // list so the UI can render chips, but the agent learns about
  // them via a brief text note in the message body — it then
  // calls `read_file` if it actually wants the contents.
  const userMsg = persistUserPrompt(ctx, session, content, attachments);
  send({ type: "message_added", message: toWire(userMsg) });

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

  send({ type: "stream_start" });

  // Hydrate the conversation log from disk. Tool turns persisted by
  // earlier prompts come back as structured pi-ai Messages; legacy
  // plain-text rows are upgraded by loadAgentHistory.
  const messages = loadAgentHistory(ctx, userId, {
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
      messages: prepareMessagesForLlm(messages, ctx.userHomeDir(userId), modelInfo),
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
      send({ type: "message_added", message: toWire(assistantRow) });

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
        send({ type: "message_added", message: toWire(toolRow) });
        messages.push(toolResult);
      }
      continue;
    }

    // stopReason: stop | length — done.
    send({ type: "stream_end", message: toWire(assistantRow) });
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
export function prepareMessagesForLlm(
  messages: Message[],
  userHome: string,
  modelInfo: ResolvedModelInfo,
): Message[] {
  return messages.map((m) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return m;
    const hasImage = m.content.some((p) => p.type === "image");
    if (!hasImage) return m;

    const next = m.content.flatMap((part): (TextContent | ImageContent)[] => {
      if (part.type !== "image") return [part];
      const img = part as PathImageContent;
      const name = img.name ?? (img.path ? path.basename(img.path) : "image");
      if (!modelInfo.supportsImages) {
        return [
          {
            type: "text",
            text: `[Attached image (current model has no vision support): ${name}]`,
          },
        ];
      }
      if (!img.path) {
        // Already inlined? Pass through as-is.
        return [{ ...img }];
      }
      try {
        const abs = path.join(userHome, img.path.startsWith("/") ? img.path.slice(1) : img.path);
        const data = fs.readFileSync(abs);
        return [
          {
            type: "image",
            data: data.toString("base64"),
            mimeType: img.mimeType,
          },
        ];
      } catch {
        return [
          {
            type: "text",
            text: `[Attached image (read failed): ${name}]`,
          },
        ];
      }
    });

    // Coalesce consecutive text parts — some providers don't like
    // a chain of tiny text fragments.
    const coalesced: (TextContent | ImageContent)[] = [];
    for (const p of next) {
      const last = coalesced[coalesced.length - 1];
      if (last && last.type === "text" && p.type === "text") {
        last.text = last.text ? `${last.text}\n${p.text}` : p.text;
      } else {
        coalesced.push(p);
      }
    }
    return { ...m, content: coalesced };
  });
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
