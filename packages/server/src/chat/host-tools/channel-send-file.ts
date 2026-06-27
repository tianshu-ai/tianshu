// Host-owned tool: `channel_send_file`.
//
// Only useful inside a channel session. The main agent calls this to
// deliver a local file (image, video, or generic attachment) to the
// platform user on the other end of the thread. The tool is
// channel-agnostic by design: it dispatches via channelHub.send and
// the adapter behind the binding (wechat, telegram, future) is
// responsible for whatever platform-specific upload + send dance is
// needed. Adding a new platform = add a new channel plugin that
// implements OutboundChannelMessage.attachments; no change to this
// tool.
//
// Flow:
//   1. Look up the current session row. If channel_binding_id is
//      null, the session is a webchat thread — refuse with a
//      friendly note; the agent should reference the file inline
//      instead.
//   2. Resolve the file path against the tenant workspace root
//      (paths starting with `/` are taken as-is, relative paths
//      are joined to `<tenant>/workspace/`). Reject anything that
//      escapes the tenant root after canonicalisation — a worker
//      shouldn't be able to spray host filesystem files through a
//      channel adapter.
//   3. Dispatch through channelHub.send with an `attachments` entry.
//
// Caption + media on the wire: we pass the caller-provided `caption`
// as OutboundChannelMessage.text and the file as a single entry in
// OutboundChannelMessage.attachments. Whether the adapter ships them
// as one combined message or two sequential ones is a per-channel
// concern handled inside the plugin (Tencent's iLink, for one, only
// accepts a single item per sendmessage call — so the wechat adapter
// emits two messages even though the agent invoked one tool call).
//
// Worker agents CAN call this — a worker producing a deliverable
// file on a channel-bound task should be able to ship it directly.
// We rely on the tenant-root path check to keep the surface safe.

import path from "node:path";
import fs from "node:fs";
import { Type } from "typebox";
import type {
  AgentTool,
  AgentToolContext,
} from "@tianshu-ai/plugin-sdk";
import { channelHub } from "../../channels/hub.js";

export const CHANNEL_SEND_FILE_TOOL_NAME = "channel_send_file";

export function buildChannelSendFileTool(): AgentTool {
  return {
    schema: {
      name: CHANNEL_SEND_FILE_TOOL_NAME,
      description:
        "Send a local file (image, video, document) to the user on the channel platform this session is bound to (e.g. wechat, telegram). The file is delivered as a native image/video/file message by the platform's adapter — not as a link or path. Use this whenever you produce a deliverable file in a channel conversation; do NOT use it for webchat sessions (it will error). The file path must be inside the tenant workspace. Optional `caption` is sent as accompanying text alongside the media.",
      parameters: Type.Object({
        filePath: Type.String({
          description:
            "Absolute path on the host filesystem, inside this tenant's workspace. Relative paths are joined to the tenant workspace root.",
        }),
        fileName: Type.Optional(
          Type.String({
            description:
              "Display name for FILE-type attachments (e.g. 'report.pdf'). Ignored for images/videos. Defaults to the basename of filePath.",
          }),
        ),
        caption: Type.Optional(
          Type.String({
            description:
              "Optional text bubble sent before the media. Use this to introduce the file ('Here's the chart you asked for:'). Omit to send the file alone.",
          }),
        ),
      }),
    },

    async execute(
      args: unknown,
      ctx: AgentToolContext,
    ): Promise<{ ok: boolean; text: string }> {
      const params = args as {
        filePath?: unknown;
        fileName?: unknown;
        caption?: unknown;
      };
      const filePath =
        typeof params.filePath === "string" ? params.filePath : "";
      const fileName =
        typeof params.fileName === "string" ? params.fileName : undefined;
      const caption =
        typeof params.caption === "string" ? params.caption : "";
      if (!filePath) {
        return {
          ok: false,
          text: "channel_send_file: filePath is required.",
        };
      }
      // `available()` already gated us on ctx.channelSession; this is
      // a belt-and-braces check for cases where someone bypasses the
      // toolset builder (tests, manual host-tool invocation, future
      // routes that wire executors directly).
      const channel = ctx.channelSession;
      if (!channel) {
        return {
          ok: false,
          text: "channel_send_file: this session is not bound to any channel (webchat). Reference the file inline in your reply instead.",
        };
      }

      // Resolve against tenant workspace + check the resolved path
      // stays inside it. ctx.tenantHomeDir is the workspace dir;
      // we accept either a workspace-relative path or an absolute
      // path already under that root.
      const tenantRoot = ctx.tenantHomeDir;
      if (!tenantRoot) {
        return {
          ok: false,
          text: "channel_send_file: tenantHomeDir missing from tool context — this is a host wiring bug, not your fault.",
        };
      }
      const resolvedRoot = path.resolve(tenantRoot);
      const candidate = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(resolvedRoot, filePath);
      if (
        candidate !== resolvedRoot &&
        !candidate.startsWith(resolvedRoot + path.sep)
      ) {
        return {
          ok: false,
          text: `channel_send_file: path "${filePath}" resolves outside the tenant workspace; refusing.`,
        };
      }
      if (!fs.existsSync(candidate)) {
        return {
          ok: false,
          text: `channel_send_file: file not found at ${candidate}`,
        };
      }
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) {
        return {
          ok: false,
          text: `channel_send_file: ${candidate} is not a regular file.`,
        };
      }

      try {
        await channelHub.send(channel.bindingId, {
          target: channel.chatId,
          text: caption,
          attachments: [
            {
              filePath: candidate,
              fileName: fileName ?? path.basename(candidate),
            },
          ],
        });
      } catch (err) {
        return {
          ok: false,
          text: `channel_send_file: adapter delivery failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      return {
        ok: true,
        text: `Sent ${path.basename(candidate)} (${stat.size} bytes)${caption ? " with caption" : ""}.`,
      };
    },

    // Only advertise inside a channel-bound session. Webchat
    // agents don't have a platform to deliver media through, so
    // the tool would only ever return ok=false for them — better
    // to hide it from the catalog entirely. The host populates
    // `ctx.channelSession` from `sessions.channel_binding_id` for
    // every per-turn toolset build.
    available(ctx: AgentToolContext) {
      return ctx.channelSession != null;
    },
  };
}
