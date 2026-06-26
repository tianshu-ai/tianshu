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
//   3. Appends the inbound text to that session.
//   4. Runs the agent against the session.
//   5. Routes the agent's reply back through the adapter via
//      `channelHub.send(bindingId, ...)`.
//
// This file is deliberately lean. It does NOT own:
//   - session model / persistence (sessions.ts + messages.ts)
//   - agent orchestration (runPrompt, in chat/handler.ts)
//   - adapter lifecycle (adapter-manager.ts)
//
// Filtering rules mirror what the closed-source predecessor did:
// DM → agent for every message; group → only when @-mentioned.
// Adapters that don't reliably detect mentions can set
// `mentionsBot=true` on every group message and rely on the user
// to invoke the bot via `/cmd` prefixes; the router does not enforce
// any other policy.

import { channelHub } from "./hub.js";
import type { InboundEnvelope } from "./types.js";
import type { GlobalOps } from "../core/global-ops.js";
import { ensureChannelSession } from "./sessions.js";
import { appendMessage } from "../chat/messages.js";

/** Decision the router makes about whether a message should reach
 *  the agent at all. */
type AdmitDecision =
  | { kind: "admit" }
  | { kind: "drop"; reason: string };

function admit(envelope: InboundEnvelope): AdmitDecision {
  // Empty text — adapter SHOULD have filtered system-only events
  // (typing indicators, read receipts, sticker-only payloads it
  // can't render) but we belt-and-brace.
  if (!envelope.text || !envelope.text.trim()) {
    return { kind: "drop", reason: "empty text" };
  }
  // Bot self-echo. Channel adapters are responsible for not
  // forwarding their own outbound messages; if a buggy adapter
  // does anyway, we'd otherwise loop. The senderId == botId check
  // would belong here once we track each binding's bot identity;
  // for v0 we trust adapters and only enforce the empty / mention
  // gates.
  if (!envelope.isDirect && !envelope.mentionsBot) {
    return { kind: "drop", reason: "group without mention" };
  }
  return { kind: "admit" };
}

interface RouterDeps {
  globalOps: GlobalOps;
}

/** Wire the router into the hub. Returns an unsubscribe function
 *  the caller can invoke at shutdown. */
export function startChannelRouter(deps: RouterDeps): () => void {
  return channelHub.onMessage((envelope) => {
    // Best-effort: log + drop bad messages, don't propagate errors.
    const decision = admit(envelope);
    if (decision.kind === "drop") {
      console.info(
        `[channel-router] dropped ${envelope.channelId}/${envelope.chatId}: ${decision.reason}`,
      );
      return;
    }
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
  deps: RouterDeps,
): Promise<void> {
  const ctx = deps.globalOps.open(envelope.tenantId);
  const session = ensureChannelSession(ctx, {
    bindingId: envelope.bindingId,
    channelId: envelope.channelId,
    chatId: envelope.chatId,
    isDirect: envelope.isDirect,
    senderName: envelope.senderName,
  });
  appendMessage(ctx, session, { role: "user", content: envelope.text });

  // v0: the channel reply path doesn't yet wire into runPrompt /
  // the agent loop. We persist the message so it shows up in the
  // session inbox the chat shell renders, but the actual agent
  // run lands in the follow-up PR that plumbs runPrompt for
  // non-WebSocket callers. See ADR/channel docs.
  //
  // Adapter authors testing the round trip can build their own
  // echo: subscribe to the hub manually and call `channelHub.send`.
  // The host-side automatic agent reply will turn on once the
  // refactor of runPrompt lands.
}
