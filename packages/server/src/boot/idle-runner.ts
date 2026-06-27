// Wire the session-inbox idle runner.
//
// When a worker pool finishes a task and the parent chat session is
// idle (no active harness), the inbox module kicks a background
// `runPrompt` turn so the agent reacts to the notification
// immediately instead of waiting for the user to send something.
//
// We bind once at startup (`bindIdleRunner` is process-wide) so the
// inbox module doesn't have to import the host registry directly. The
// runner closure resolves the tenant from globalOps at call time \u2014
// the session row already lives in some tenant DB; the closure is
// tenant-agnostic.
//
// Two delivery paths matter inside the runner:
//   - webchat session     \u2192 broadcastToUser to every open WS tab
//   - channel-bound session \u2192 buildChannelStreamSink \u2192 channelHub
//
// Without that split a background turn on a wechat-bound session ends
// up only on the user's webchat tabs (if any) and never crosses back
// to the platform user. See memory/2026-06-27 for the original bug.

import { bindIdleRunner } from "../chat/session-inbox.js";
import { runPrompt } from "../chat/handler.js";
import { broadcastToUser } from "../chat/active-harnesses.js";
import { buildChannelStreamSink, channelHub } from "../channels/index.js";
import type { GlobalOps } from "../core/global-ops.js";
import type { PluginRegistry } from "../core/plugins/registry.js";
import type { ServerMsg } from "../chat/ws-protocol.js";

export interface InstallIdleRunnerDeps {
  globalOps: GlobalOps;
  pluginRegistry: PluginRegistry;
}

/**
 * Install the idle-runner. Idempotent in practice (bindIdleRunner is
 * a one-shot module setter), but conceptually call once at boot.
 *
 * Deps are captured by closure so this module doesn't need a
 * mutable singleton.
 */
export function installIdleRunner(deps: InstallIdleRunnerDeps): void {
  const { globalOps, pluginRegistry } = deps;

  bindIdleRunner(async ({ sessionId, userId, promptText }) => {
    // Find which tenant owns this session, and pick up the channel
    // tagging columns at the same time so we know whether to fan
    // replies out to WS tabs (webchat) or push them through the
    // channel adapter (wechat / telegram / ...). If no tenant
    // claims this session, give up silently \u2014 the inbox row stays
    // delivered=false and will be flushed on the next user prompt.
    let owningCtx: ReturnType<typeof globalOps.open> | null = null;
    let channelBindingId: string | null = null;
    let channelChatId: string | null = null;
    for (const tenantId of globalOps.list()) {
      const ctx = globalOps.open(tenantId);
      const row = ctx.db
        .prepare<
          [string],
          {
            id: string;
            channel_binding_id: string | null;
            channel_chat_id: string | null;
          }
        >(
          `SELECT id, channel_binding_id, channel_chat_id
             FROM sessions WHERE id = ?`,
        )
        .get(sessionId);
      if (row) {
        owningCtx = ctx;
        channelBindingId = row.channel_binding_id;
        channelChatId = row.channel_chat_id;
        break;
      }
    }
    if (!owningCtx) {
      console.warn(
        `[idle-runner] no tenant found for session ${sessionId}; skipping`,
      );
      return;
    }
    const ctx = owningCtx;
    const isChannelSession =
      channelBindingId !== null && channelChatId !== null;

    const channelSink = isChannelSession
      ? buildChannelStreamSink({ sessionId, userId })
      : null;
    let errorReason = "";
    const send = (msg: ServerMsg) => {
      if (channelSink) {
        channelSink.push(msg);
      } else {
        broadcastToUser(userId, msg);
      }
    };

    // Wedge guard: a stuck provider can't pin the inbox queue
    // forever. No user-facing abort button for an inbox turn \u2014
    // generous deadline only.
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(),
      5 * 60 * 1000,
    );
    try {
      await runPrompt({
        ctx,
        userId,
        send,
        content: promptText,
        signal: controller.signal,
        pluginRegistry,
        homeDir: ctx.workspaceDir,
      });
    } catch (err) {
      errorReason = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(deadline);
    }

    if (channelSink && channelBindingId && channelChatId) {
      const sinkError = channelSink.getErrorReason();
      if (sinkError) errorReason = sinkError;
      for (const body of channelSink.assistantQueue) {
        try {
          await channelHub.send(channelBindingId, {
            target: channelChatId,
            text: body,
          });
        } catch (err) {
          console.error(
            `[idle-runner] adapter send failed (${channelBindingId} \u2192 ${channelChatId}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      if (errorReason.length > 0) {
        console.warn(
          `[idle-runner] background turn errored on channel session ${sessionId}: ${errorReason}`,
        );
      }
    }
  });
}
