// A ToolsetProvider backed by the dialed-in bridge connections. The
// host calls listTools() every agent turn, so tools appear/disappear as
// bridges connect/disconnect with no plugin reactivation.
//
// Each bridge tool becomes an AgentTool named `bridge_<device>_<tool>`.
// `available()` hides it from users who don't own that bridge; the
// tenant scope is already fixed (this provider is created per-tenant).
// `execute()` does the async JSON-RPC round-trip to the owning device.
//
// Screenshots / images: a bridge tool result may carry MCP image
// blocks (base64). To keep the agent context small we DON'T inline
// those bytes into the tool result. Instead we save each image under
// the user's dir and return only its PATH + dimensions. The agent then
// calls `bridge_view_image(path)` on demand — that tool inlines the
// bytes as an ImageContent for the vision model, one turn, controlled.

import fs from "node:fs";
import path from "node:path";
import type {
  AgentTool,
  AgentToolContext,
  ToolResult,
  ToolsetProvider,
} from "@tianshu-ai/plugin-sdk";
import { okResult, errorResult } from "@tianshu-ai/plugin-sdk";
import type { BridgeRegistry, BridgeConn } from "./registry.js";
import type { McpToolDescriptor, ToolsCallResult } from "./protocol.js";

const SHOTS_DIR = "bridge-screenshots";
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Sanitise a device/tool id into a tool-name-safe token. */
function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

/** Fully-qualified agent tool name for a bridge tool. */
export function toolName(deviceId: string, tool: string): string {
  return `bridge_${slug(deviceId)}_${slug(tool)}`;
}

/** Save any image blocks in a tools/call result under the user's dir,
 *  returning their workspace-relative paths. Keeps bytes OUT of the
 *  agent context. */
function saveImageBlocks(
  res: ToolsCallResult,
  userHome: string,
): string[] {
  const saved: string[] = [];
  const dir = path.join(userHome, SHOTS_DIR);
  for (const c of res.content ?? []) {
    if (c.type !== "image") continue;
    const data = typeof c.data === "string" ? c.data : "";
    if (!data) continue;
    const mime = typeof c.mimeType === "string" ? c.mimeType : "image/png";
    const ext = EXT_BY_MIME[mime] ?? "png";
    try {
      fs.mkdirSync(dir, { recursive: true });
      const rel = path.join(SHOTS_DIR, `${Date.now()}-${saved.length}.${ext}`);
      fs.writeFileSync(path.join(userHome, rel), Buffer.from(data, "base64"));
      saved.push(rel);
    } catch {
      /* best-effort; skip on write failure */
    }
  }
  return saved;
}

/** Flatten a tools/call result for the agent: text blocks joined, and
 *  image blocks saved to disk with their PATHS surfaced (not bytes). */
function renderResult(res: ToolsCallResult, userHome: string): ToolResult {
  const textParts = (res.content ?? [])
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .filter(Boolean);
  const savedImages = saveImageBlocks(res, userHome);
  let text = textParts.join("\n").trim();
  if (savedImages.length) {
    const note =
      `Saved ${savedImages.length} image(s) to your workspace:\n` +
      savedImages.map((p) => `  - ${p}`).join("\n") +
      `\nTo look at one, call bridge_view_image with its path.`;
    text = text ? `${text}\n${note}` : note;
  }
  text = text || "(no content)";
  return res.isError ? errorResult(text, res) : okResult(text, res);
}

export function makeBridgeToolset(args: {
  registry: BridgeRegistry;
  /** Resolve a user's workspace dir (from PluginContext.userHomeDir). */
  userHomeDir: (userId: string) => string;
  log: { info: (m: string) => void; warn: (m: string) => void };
}): ToolsetProvider {
  const { registry, userHomeDir } = args;
  return {
    name: "bridge",
    listTools(): AgentTool[] {
      const tools: AgentTool[] = [];
      const conns = registry.all();
      // One view_image tool per user with a bridge (user-scoped via
      // available()), so the agent can inline a saved screenshot when
      // it actually needs to see it.
      const usersWithBridge = new Set(conns.map((c) => c.userId));
      for (const uid of usersWithBridge) {
        tools.push(buildViewImageTool(uid, userHomeDir));
      }
      for (const conn of conns) {
        for (const t of conn.tools) {
          tools.push(buildTool(registry, userHomeDir, conn.userId, conn.deviceId, t));
        }
      }
      return tools;
    },
  };
}

function buildTool(
  registry: BridgeRegistry,
  userHomeDir: (userId: string) => string,
  userId: string,
  deviceId: string,
  desc: McpToolDescriptor,
): AgentTool {
  const parameters =
    desc.inputSchema && typeof desc.inputSchema === "object"
      ? (desc.inputSchema as Record<string, unknown>)
      : { type: "object", properties: {}, additionalProperties: true };
  return {
    schema: {
      name: toolName(deviceId, desc.name),
      description:
        (desc.description ?? `Local bridge tool "${desc.name}" on device "${deviceId}".`) +
        ` (Runs on the user's own machine via the Local Bridge device "${deviceId}".)`,
      parameters: parameters as never,
    },
    available(ctx: AgentToolContext): boolean {
      return ctx.userId === userId;
    },
    async execute(rawArgs: Record<string, unknown>, ctx: AgentToolContext): Promise<ToolResult> {
      if (ctx.userId !== userId) {
        return errorResult("This bridge tool belongs to a different user.");
      }
      const conn = registry.forUser(userId).find((c) => c.deviceId === deviceId);
      if (!conn) {
        return errorResult(
          `Local Bridge device "${deviceId}" is not connected. Start the bridge client and try again.`,
        );
      }
      try {
        const result = await registry.call(conn, "tools/call", {
          name: desc.name,
          arguments: rawArgs,
        });
        return renderResult((result ?? {}) as ToolsCallResult, userHomeDir(userId));
      } catch (err) {
        return errorResult(
          `Local Bridge call failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

/** On-demand image viewer: read a previously-saved bridge image and
 *  return it as an ImageContent so the vision model sees it THIS turn.
 *  This is the only place bytes enter the agent context. */
function buildViewImageTool(
  userId: string,
  userHomeDir: (userId: string) => string,
): AgentTool {
  return {
    schema: {
      name: "bridge_view_image",
      description:
        "Look at an image the Local Bridge saved to your workspace (e.g. a browser screenshot). " +
        "Pass the workspace-relative path returned by a bridge tool (like bridge-screenshots/....png). " +
        "The image is shown to you for this turn only.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative path of the saved image, e.g. bridge-screenshots/1720000000000-0.png",
          },
        },
        required: ["path"],
      } as never,
    },
    available(ctx: AgentToolContext): boolean {
      return ctx.userId === userId;
    },
    async execute(rawArgs: Record<string, unknown>, ctx: AgentToolContext): Promise<ToolResult> {
      if (ctx.userId !== userId) return errorResult("Not your bridge image.");
      const rel = String(rawArgs.path ?? "").trim();
      // Path-safety: must stay under the user's SHOTS_DIR.
      const home = userHomeDir(userId);
      const abs = path.resolve(home, rel);
      const shotsRoot = path.resolve(home, SHOTS_DIR);
      if (!abs.startsWith(shotsRoot + path.sep)) {
        return errorResult(`Path must be under ${SHOTS_DIR}/. Got: ${rel}`);
      }
      let buf: Buffer;
      try {
        buf = fs.readFileSync(abs);
      } catch {
        return errorResult(`Image not found: ${rel}`);
      }
      const ext = path.extname(abs).slice(1).toLowerCase();
      const mimeType =
        ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/png";
      return {
        ok: true,
        text: `Showing ${rel}.`,
        images: [{ base64: buf.toString("base64"), mimeType }],
      };
    },
  };
}
