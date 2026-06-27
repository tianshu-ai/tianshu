// Inbound channel message router.
//
// Every inbound channel message arrives at the hub as an envelope
// tagged with its binding (and thus tenant). The router:
//
//   1. Filters out messages the agent shouldn't see:
//        - bot's own echoed messages (adapter SHOULD drop these,
//          but we double-check)
//        - group messages without a bot mention
//   2. Finds or creates a channel session keyed on
//      (binding_id, channel_id, channel_chat_id).
//   3. Runs the agent against the session (via runPrompt). The
//      router builds its own `send` callback so the WebSocket-
//      shaped ServerMsg stream is funnelled into a single final
//      reply string.
//   4. Routes the final reply back through the binding's adapter
//      via `channelHub.send(bindingId, ...)`.
//
// Why this file does NOT skip runPrompt and reach the agent loop
// directly: runPrompt also handles tool execution, model selection,
// auto-compact, plugin tool injection, system-prompt assembly,
// flush-tool-delta, MAX_TURNS enforcement, etc. Re-implementing
// any of that is a recipe for divergence. Hooking a non-WS sink
// in via the existing `send` callback gets us the whole pipeline
// for free.
//
// Filtering rules: DM → agent for every message; group → only
// when @-mentioned. Adapters that can't detect mentions reliably
// set mentionsBot=true on every group message and rely on user-
// side conventions ("@bot ..."); the router doesn't enforce more.

import { channelHub } from "./hub.js";
import type { InboundEnvelope } from "./types.js";
import type { GlobalOps } from "../core/global-ops.js";
import { ensureChannelSession } from "./sessions.js";
import { getBinding, setBindingStatus } from "./bindings.js";
import { runPrompt } from "../chat/handler.js";
import { broadcastToUser } from "../chat/active-harnesses.js";
import type { ServerMsg } from "../chat/ws-protocol.js";

/** Translate raw LLM / provider errors into a short, user-facing
 *  string suitable for a chat-platform message. Specifics (401
 *  bodies, stack traces, provider URLs) stay in logs + binding
 *  status; the human at the other end of wechat gets something
 *  they can act on. */
function friendlyErrorMessage(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("jwt is expired") || lower.includes("401")) {
    return "⚠️ I can't reach the model right now — the API key is expired or invalid. The admin needs to refresh it.";
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return "⚠️ Hitting rate limits. Try again in a bit.";
  }
  if (lower.includes("403") || lower.includes("permission")) {
    return "⚠️ The model is denying my requests (403). The admin needs to check provider access.";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "⚠️ Took too long to hear back from the model. Try again.";
  }
  return "⚠️ Something went wrong on my side. Try again, and ping the admin if it sticks.";
}

/** Decision the router makes about whether a message should reach
 *  the agent at all. */
type AdmitDecision =
  | { kind: "admit" }
  | { kind: "drop"; reason: string };

function admit(envelope: InboundEnvelope): AdmitDecision {
  if (!envelope.text || !envelope.text.trim()) {
    return { kind: "drop", reason: "empty text" };
  }
  if (!envelope.isDirect && !envelope.mentionsBot) {
    return { kind: "drop", reason: "group without mention" };
  }
  return { kind: "admit" };
}

export interface ChannelRouterDeps {
  globalOps: GlobalOps;
  /** Plugin registry, passed through to runPrompt so plugin tools
   *  + skills get wired in. Same instance the WebSocket handler
   *  uses; channels share the surface. */
  pluginRegistry?: import("../core/plugins/registry.js").PluginRegistry;
  /** Host's $HOME equivalent — currently only consumed by
   *  runPrompt's homeDir param, which a few tools need for path
   *  resolution. */
  homeDir?: string;
}

/** Wire the router into the hub. Returns an unsubscribe function
 *  the caller invokes at shutdown. */
export function startChannelRouter(deps: ChannelRouterDeps): () => void {
  return channelHub.onMessage((envelope) => {
    const decision = admit(envelope);
    if (decision.kind === "drop") {
      console.info(
        `[channel-router] dropped ${envelope.channelId}/${envelope.chatId}: ${decision.reason}`,
      );
      return;
    }
    console.info(
      `[channel-router] admit ${envelope.channelId}/${envelope.chatId} (${envelope.tenantId}): "${envelope.text.slice(0, 60)}"`,
    );
    void dispatch(envelope, deps).catch((err) => {
      console.error(
        `[channel-router] dispatch failed (${envelope.channelId}/${envelope.chatId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  });
}

async function dispatch(
  envelope: InboundEnvelope,
  deps: ChannelRouterDeps,
): Promise<void> {
  const ctx = deps.globalOps.open(envelope.tenantId);
  const session = ensureChannelSession(ctx, {
    bindingId: envelope.bindingId,
    channelId: envelope.channelId,
    chatId: envelope.chatId,
    isDirect: envelope.isDirect,
    senderName: envelope.senderName,
  });

  // Pull the binding's preferred model (if any) so the channel
  // user's choice of LLM follows their wechat / telegram / etc.
  // thread. Falls back to the tenant default when missing.
  const binding = getBinding(ctx.db, envelope.bindingId);
  const modelId =
    typeof binding?.config.modelId === "string" &&
    binding.config.modelId.trim().length > 0
      ? binding.config.modelId.trim()
      : undefined;
  // Tell every open chat-shell socket for this user that something
  // changed on a channel — their plugin sidebar sections re-poll
  // and the new session row pops up without a 30s polling delay.
  broadcastToUser(session.userId, {
    type: "channel_session_changed",
    channelId: envelope.channelId,
  });

  // Forward every assistant text chunk the agent emits, not just
  // the last one. A single agent turn can produce multiple
  // assistant messages (tool call → result → explanation →
  // continuation → final answer), and we want the user to see all
  // of them on wechat the same way they would in the webchat
  // pane.
  //
  // Strategy: each stream_end is a complete assistant message
  // (delta chunks already concatenated server-side into
  // `message.text`). We queue every non-empty body in
  // `assistantQueue` and ship them out sequentially after
  // runPrompt resolves. Sequential matters for two reasons:
  //   - context_token is per-user, shared across our outbound
  //     calls; parallel sends would race on Tencent's side
  //   - wechat preserves message order by send time, so users see
  //     thinking → tool result → final answer in the order the
  //     agent produced them
  let deltaChunks: string[] = [];
  const assistantQueue: string[] = [];
  let errorReason = "";
  const sink = (msg: ServerMsg) => {
    // Rebroadcast persisted-row events scoped to this channel
    // session so a chat shell viewing it paints them live. We
    // tag each one with `sessionId` so the chat shell can filter
    // (only apply when viewingSessionId matches) and the events
    // don't leak into the unrelated webchat thread.
    if (
      msg.type === "message_added" ||
      msg.type === "tool_call" ||
      msg.type === "tool_result"
    ) {
      broadcastToUser(session.userId, { ...msg, sessionId: session.id } as ServerMsg);
    }
    if (msg.type === "stream_delta") {
      deltaChunks.push(msg.delta);
    } else if (msg.type === "stream_end") {
      const wireText = msg.message?.text?.trim() ?? "";
      const text = wireText || deltaChunks.join("").trim();
      deltaChunks = [];
      if (text.length > 0) assistantQueue.push(text);
    } else if (msg.type === "stream_error") {
      errorReason = msg.reason || "unknown";
    }
  };

  const aborter = new AbortController();
  try {
    await runPrompt({
      ctx,
      userId: session.userId,
      send: sink,
      content: envelope.text,
      modelId,
      signal: aborter.signal,
      pluginRegistry: deps.pluginRegistry,
      homeDir: deps.homeDir,
      session,
    });
  } catch (err) {
    errorReason = err instanceof Error ? err.message : String(err);
  }

  // Sequential delivery preserves order on the user's wechat
  // thread + avoids racing the per-user context_token.
  for (const body of assistantQueue) {
    await safeSend(envelope.bindingId, envelope.chatId, body);
  }

  if (errorReason.length > 0) {
    // The user sees a short, plain explanation — 'agent error:
    // 401 Jwt is expired' isn't actionable for them. Detail goes
    // into the binding row so the admin can see the original
    // cause at /admin/<channel>.
    try {
      setBindingStatus(ctx.db, envelope.bindingId, "error", errorReason);
    } catch {
      /* logging-only; do not break the user reply */
    }
    console.warn(
      `[channel-router] agent error (${envelope.bindingId}): ${errorReason}`,
    );
    await safeSend(
      envelope.bindingId,
      envelope.chatId,
      friendlyErrorMessage(errorReason),
    );
  }
  // Tool-only turn: assistantQueue is empty, nothing more to ship.
}

async function safeSend(bindingId: string, target: string, text: string): Promise<void> {
  try {
    await channelHub.send(bindingId, { target, text });
  } catch (err) {
    console.error(
      `[channel-router] adapter send failed (${bindingId} → ${target}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
