// Shared sink for funnelling a runPrompt stream into a channel
// adapter. Used in two places:
//
//   - channels/router.ts dispatch(): the synchronous "user sent a
//     message on wechat" turn.
//   - chat/idle-runner.ts (in index.ts): the asynchronous
//     "background turn fired for a channel-bound session" turn,
//     e.g. a workboard task completing and pushing a follow-up
//     prompt to main.
//
// Both paths want the same thing: queue every assistant
// message_added body, also pump message_added / tool_call /
// tool_result back out to any WS tab a human is using to spy on
// the session, dedupe stream_end against the preceding
// message_added, and capture stream_error so the caller can
// surface a friendly note. Before this helper the two paths each
// inlined ~40 lines that drifted apart whenever one was patched.
//
// The sink is intentionally NOT generic over "any sink consumer"
// — it knows it's serving channel sessions specifically. The
// webchat sink stays inline in handler.ts because it broadcasts
// every event including stream_delta; here we filter to the
// subset adapters actually need.

import type { ServerMsg } from "../chat/ws-protocol.js";
import { broadcastToUser } from "../chat/active-harnesses.js";

export interface ChannelStreamSinkOpts {
  /** Session id the sink belongs to. We tag rebroadcast events
   *  with this so a chat shell viewing the same session paints
   *  them live (and so events don't leak into the user's
   *  unrelated webchat thread). */
  sessionId: string;
  /** User id that owns the session. broadcastToUser routes to
   *  every WS tab the user has open under this id. */
  userId: string;
}

export interface ChannelStreamSink {
  /** Hand this to runPrompt({ send }). */
  push: (msg: ServerMsg) => void;
  /** Texts to ship through the channel adapter, in send order.
   *  Filled as `runPrompt` emits assistant message_added events. */
  readonly assistantQueue: readonly string[];
  /** Last stream_error reason, or empty string. */
  getErrorReason: () => string;
}

export function buildChannelStreamSink(
  opts: ChannelStreamSinkOpts,
): ChannelStreamSink {
  const assistantQueue: string[] = [];
  const sentMessageIds = new Set<string>();
  let errorReason = "";

  const push = (msg: ServerMsg) => {
    // Live rebroadcast — admin / dev viewers of this channel
    // session paint events as they happen. We only forward the
    // event types webchat needs to render a turn; stream_delta
    // is intentionally dropped because it's high-frequency and
    // adapters don't need partial bodies (we ship one message
    // per `message_added` regardless).
    if (
      msg.type === "message_added" ||
      msg.type === "tool_call" ||
      msg.type === "tool_result"
    ) {
      broadcastToUser(opts.userId, {
        ...msg,
        sessionId: opts.sessionId,
      } as ServerMsg);
    }

    // EVERY assistant message goes into the queue for adapter
    // delivery. The agent loop emits a `message_added` for each
    // LLM turn (text, post-tool-call continuation, …). Earlier
    // versions only queued the final `stream_end` body and
    // dropped intermediate turns; users on wechat saw only the
    // last response.
    if (msg.type === "message_added" && msg.message?.role === "assistant") {
      const text = msg.message.text?.trim() ?? "";
      if (text.length > 0) {
        sentMessageIds.add(msg.message.id);
        assistantQueue.push(text);
      }
    } else if (msg.type === "stream_end") {
      // Belt-and-braces: stream_end carries the last assistant
      // turn. Some agent paths skip the intermediate
      // message_added; the de-dup against sentMessageIds keeps
      // us from double-shipping when it doesn't.
      const wire = msg.message;
      const text = wire?.text?.trim() ?? "";
      if (wire && text.length > 0 && !sentMessageIds.has(wire.id)) {
        sentMessageIds.add(wire.id);
        assistantQueue.push(text);
      }
    } else if (msg.type === "stream_error") {
      errorReason = msg.reason || "unknown";
    }
  };

  return {
    push,
    assistantQueue,
    getErrorReason: () => errorReason,
  };
}
