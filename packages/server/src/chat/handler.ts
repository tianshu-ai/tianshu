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
  Message,
  TextContent,
  ToolCall,
  ToolResultMessage,
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
import { buildToolset, type Toolset } from "../tools/index.js";
import {
  appendAgentMessage,
  appendMessage,
  ensureActiveSession,
  listMessagesForUser,
  loadAgentHistory,
  type ChatMessage,
} from "./messages.js";
import { toWire, type ClientMsg, type ServerMsg } from "./ws-protocol.js";

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
      systemPrompt: defaultSystemPrompt(ctx),
      messages,
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



function defaultSystemPrompt(ctx: TenantContext): string {
  const brand = ctx.config.branding?.name ?? "Tianshu";
  return [
    `You are ${brand}, an open-source AI assistant.`,
    `Tenant: "${ctx.tenantId}".`,
    ``,
    `You have access to the user's workspace through five filesystem tools:`,
    `  list_dir, read_file, write_file, edit_file, glob.`,
    `Paths are relative to the workspace root ("/" = root). The workspace`,
    `is private to the current user; you cannot reach files outside it.`,
    ``,
    `Reply concisely. When you make changes, briefly say what you changed.`,
  ].join("\n");
}

// re-exported here so server/index.ts only imports from one barrel.
export type { ChatMessage };
