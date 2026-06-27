// Host-owned tool: `channel_send_file`.
//
// Only useful inside a channel session (wechat / telegram / ...). The
// main agent calls this to deliver a local file (image, video, or
// generic attachment) to the platform user on the other end of the
// thread.
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
//      shouldn't be able to spray host filesystem files through
//      the wechat adapter.
//   3. Dispatch through channelHub.send with an `attachments`
//      entry; the adapter (wechat, etc.) handles upload + send.
//
// We pass the caller-provided `caption` as the `text` field of
// OutboundChannelMessage — the wechat adapter sends it as a
// separate text item before the media (Tencent's iLink only
// accepts one item per sendmessage call, so caption + media are
// always two messages on the wire even though the agent saw it
// as a single tool invocation).
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
import type { GlobalOps } from "../../core/global-ops.js";
import { channelHub } from "../../channels/hub.js";

export interface ChannelSendFileDeps {
  /** Resolve a TenantContext from a tenantId — used to look up
   *  the session row's channel tagging. */
  openTenant: (tenantId: string) => ReturnType<GlobalOps["open"]>;
}

export const CHANNEL_SEND_FILE_TOOL_NAME = "channel_send_file";

export function buildChannelSendFileTool(
  deps: ChannelSendFileDeps,
): AgentTool {
  return {
    schema: {
      name: CHANNEL_SEND_FILE_TOOL_NAME,
      description:
        "Send a local file (image, video, document) to the user on the channel platform this session is bound to (e.g. wechat). The file is uploaded to the platform's CDN by the adapter and delivered as a native image/video/file message rather than a link. Use this whenever you produce a deliverable file in a channel conversation; do NOT use it for webchat sessions (it will error). The file path must be inside the tenant workspace. Optional `caption` is sent as a separate text bubble before the media.",
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
      const sessionId = ctx.sessionId;
      if (!sessionId) {
        return {
          ok: false,
          text: "channel_send_file: no sessionId in context; tool can only run inside a chat session.",
        };
      }

      let tenant;
      try {
        tenant = deps.openTenant(ctx.tenantId);
      } catch (err) {
        return {
          ok: false,
          text: `channel_send_file: cannot open tenant ${ctx.tenantId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }

      const row = tenant.db
        .prepare<
          [string],
          {
            channel_binding_id: string | null;
            channel_chat_id: string | null;
          }
        >(
          `SELECT channel_binding_id, channel_chat_id
             FROM sessions
            WHERE id = ?`,
        )
        .get(sessionId);

      if (!row) {
        return {
          ok: false,
          text: `channel_send_file: session ${sessionId} not found.`,
        };
      }
      if (!row.channel_binding_id || !row.channel_chat_id) {
        return {
          ok: false,
          text: "channel_send_file: this session is not bound to any channel (e.g. webchat). Reference the file inline in your reply instead.",
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
        await channelHub.send(row.channel_binding_id, {
          target: row.channel_chat_id,
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

    // Always advertise. The runtime check above keeps it inert on
    // non-channel sessions (returns ok=false with a friendly note
    // pointing the agent at inline references instead).
    available() {
      return true;
    },
  };
}
