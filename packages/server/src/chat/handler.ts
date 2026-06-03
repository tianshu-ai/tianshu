// WebSocket chat handler — wires together the tenant context, the
// message store, and pi-ai's streamSimple.
//
// PR #21 implements the smallest possible end-to-end:
//   client opens /ws, sends {type:"hello"}, gets {type:"connected"} +
//   history. client sends {type:"prompt", content}, server appends a
//   user message, calls streamSimple with the full history, streams
//   text_delta back, and on done appends + announces the assistant
//   message.
//
// Tools / system prompt / SOUL.md are deliberately deferred to PR #22.

import { streamSimple } from "@earendil-works/pi-ai";
import type {
  AssistantMessageEvent,
  Context,
  Message,
  TextContent,
} from "@earendil-works/pi-ai";
import type { WebSocket } from "ws";
import {
  buildModel,
  findModel,
  getDefaultModel,
  resolveApiKey,
  type ResolvedModelInfo,
  type TenantContext,
} from "../core/index.js";
import {
  appendMessage,
  ensureActiveSession,
  listMessagesForUser,
  type ChatMessage,
  type ChatSession,
} from "./messages.js";
import { toWire, type ClientMsg, type ServerMsg } from "./ws-protocol.js";

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
  signal: AbortSignal;
}

async function runPrompt(args: RunPromptArgs): Promise<void> {
  const { ctx, userId, send, content, modelId, signal } = args;

  const session = ensureActiveSession(ctx, userId);
  const userMsg = appendMessage(ctx, session, { role: "user", content });
  send({ type: "message_added", message: toWire(userMsg) });

  // Caller may override the per-prompt model. Unknown ids fall back to
  // the configured default rather than failing the prompt outright —
  // the catalog is allowed to drift while the UI's local pick survives.
  const modelInfo = (modelId ? findModel(ctx.config, modelId) : undefined) ?? getDefaultModel(ctx.config);
  if (!modelInfo) {
    send({
      type: "stream_error",
      reason: "no models configured (set models in ~/.tianshu/config.json)",
    });
    return;
  }

  const piModel = buildModel(modelInfo);
  const piContext = buildContext(ctx, session, modelInfo);
  const apiKey = resolveApiKey(modelInfo);

  send({ type: "stream_start" });

  const stream = streamSimple(piModel, piContext, { signal, apiKey });

  const collected: string[] = [];
  for await (const event of stream as AsyncIterable<AssistantMessageEvent>) {
    if (event.type === "text_delta") {
      const delta = (event as Extract<AssistantMessageEvent, { type: "text_delta" }>).delta;
      collected.push(delta);
      send({ type: "stream_delta", delta });
    } else if (event.type === "error") {
      const reason =
        (event as Extract<AssistantMessageEvent, { type: "error" }>).error?.errorMessage ??
        "stream_error";
      send({ type: "stream_error", reason });
      return;
    }
  }

  const finalText = collected.join("");
  const assistantMsg = appendMessage(ctx, session, { role: "assistant", content: finalText });
  send({ type: "stream_end", message: toWire(assistantMsg) });
}

/** Build a pi-ai Context from the user's full message history. */
function buildContext(
  ctx: TenantContext,
  session: ChatSession,
  modelInfo: ResolvedModelInfo,
): Context {
  const history = listMessagesForUser(ctx, session.userId);
  const messages: Message[] = [];
  for (const m of history) {
    if (m.role === "user") {
      messages.push({
        role: "user",
        content: [{ type: "text", text: m.content } as TextContent],
        timestamp: m.createdAt,
      });
    } else if (m.role === "assistant") {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: m.content } as TextContent],
        api: modelInfo.api,
        provider: modelInfo.providerId,
        model: modelInfo.modelId,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: m.createdAt,
      });
    }
    // tool/system roles are skipped at v0; they arrive with PR #22+.
  }
  return {
    systemPrompt: defaultSystemPrompt(ctx),
    messages,
  };
}

function defaultSystemPrompt(ctx: TenantContext): string {
  const brand = ctx.config.branding?.name ?? "Tianshu";
  // Keep the v0 system prompt minimal; PR #22 will load _tenant/SOUL.md
  // and tenant-level overrides.
  return `You are ${brand}, an open-source AI assistant. Tenant: "${ctx.tenantId}". Reply concisely.`;
}

// re-exported here so server/index.ts only imports from one barrel.
export type { ChatMessage };
