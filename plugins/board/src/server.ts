// Board plugin server entry.
//
// A "board" is a folder under the user's workspace:
//   users/<userId>/board/<name>/index.html
// (+ any assets it references, loaded relative to that index.html).
//
// Two ways to view a board:
//   1. Agent tool `show_board({ name })` returns the board's HTML as an
//      MCP-UI resource (ui://board/<name>), which the chat renders as a
//      sandboxed iframe — reusing the same MCP-UI rendering path as any
//      MCP server's ui:// resource. The heavy HTML never enters the
//      model context (the model gets a short placeholder); it rides on
//      the tool result's `data.mcpUi` for the web layer only.
//   2. The BoardPanel side panel lists boards and renders the selected
//      one in an iframe served by `GET /api/p/board/boards/:name/index.html`.
//
// Read-only + path-safe: names are slug-validated and every read is
// confined to the user's board dir (no traversal).

import fs from "node:fs";
import path from "node:path";
import type {
  PluginContext,
  PluginServerExports,
  PluginServerModule,
  PluginRouteHandler,
  AgentTool,
  AgentToolContext,
  ToolResult,
} from "@tianshu-ai/plugin-sdk";
import { Type } from "typebox";
import type { Request, Response } from "express";

// A board name is a single path segment: letters, digits, dash,
// underscore, dot (no slashes, no "..").
const NAME_RE = /^[A-Za-z0-9._-]+$/;
function isSafeName(name: string): boolean {
  return NAME_RE.test(name) && name !== "." && name !== "..";
}

/** `<userHomeDir>/board`. userHomeDir is
 *  `<tenant>/workspace/users/<userId>`. */
function boardsRoot(userHomeDir: string): string {
  return path.join(userHomeDir, "board");
}

/** List board names: subdirectories of the user's board/ dir that
 *  contain an index.html. Returns [] if the dir is absent. */
function listBoardNames(userHomeDir: string): string[] {
  const root = boardsRoot(userHomeDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || !isSafeName(e.name)) continue;
    if (fs.existsSync(path.join(root, e.name, "index.html"))) out.push(e.name);
  }
  return out.sort();
}

/** Read a board's index.html, or null if missing/unsafe. Confined to
 *  the user's board dir. */
function readBoardHtml(userHomeDir: string, name: string): string | null {
  if (!isSafeName(name)) return null;
  const file = path.join(boardsRoot(userHomeDir), name, "index.html");
  // Defense in depth: ensure the resolved path is still inside root.
  const root = path.resolve(boardsRoot(userHomeDir));
  if (!path.resolve(file).startsWith(root + path.sep)) return null;
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// ─── agent tool: show_board ─────────────────────────────────────

function buildShowBoardTool(): AgentTool {
  return {
    schema: {
      name: "show_board",
      description:
        "Display one of the user's boards (an HTML dashboard under board/<name>/index.html) as an interactive UI in the chat. List available boards by calling with no name. The board renders in a sandboxed iframe; its HTML is not added to your context.",
      parameters: Type.Object({
        name: Type.Optional(
          Type.String({ description: "Board name (subdirectory of board/). Omit to list boards." }),
        ),
      }),
    },
    execute: (raw, ctx: AgentToolContext): ToolResult => {
      const p = raw as { name?: string };
      const home = ctx.userHomeDir;
      const names = listBoardNames(home);
      const name = typeof p.name === "string" ? p.name.trim() : "";

      if (!name) {
        return {
          ok: true,
          text:
            names.length > 0
              ? `Available boards: ${names.join(", ")}. Call show_board({ name }) to display one.`
              : "No boards found. Add one at board/<name>/index.html in the workspace.",
        };
      }
      if (!isSafeName(name)) {
        return { ok: false, text: `Invalid board name: "${name}".` };
      }
      const html = readBoardHtml(home, name);
      if (html === null) {
        return {
          ok: false,
          text:
            names.length > 0
              ? `Board "${name}" not found. Available: ${names.join(", ")}.`
              : `Board "${name}" not found and no boards exist yet.`,
        };
      }
      // Return the board as an MCP-UI resource so the chat renders it
      // as an iframe (same path as any ui:// resource). Short text for
      // the model; html on data.mcpUi for the web layer.
      return {
        ok: true,
        text: `[board: ${name}]`,
        data: {
          mcpUi: [
            { uri: `ui://board/${name}`, mimeType: "text/html", html },
          ],
        },
      };
    },
  };
}

// ─── REST routes (mounted under /api/p/board/*) ─────────────────

function userIdFromReq(req: Request): string {
  const ctx = (req as { ctx?: { userId?: string } }).ctx;
  return ctx?.userId ?? "";
}

function buildRoutes(ctx: PluginContext): Record<string, PluginRouteHandler> {
  const listBoards: PluginRouteHandler = (req: Request, res: Response) => {
    const userId = userIdFromReq(req);
    if (!userId) {
      res.status(401).json({ error: "no user context" });
      return;
    }
    res.json({ boards: listBoardNames(ctx.userHomeDir(userId)) });
  };

  const serveBoard: PluginRouteHandler = (req: Request, res: Response) => {
    const userId = userIdFromReq(req);
    if (!userId) {
      res.status(401).json({ error: "no user context" });
      return;
    }
    const name = String(req.params.name ?? "");
    const html = readBoardHtml(ctx.userHomeDir(userId), name);
    if (html === null) {
      res.status(404).send("board not found");
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  };

  return { listBoards, serveBoard };
}

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    ctx.log.info("board activated");
    return {
      tools: { ShowBoardTool: buildShowBoardTool() },
      routes: buildRoutes(ctx),
    };
  },
  async deactivate() {
    /* nothing to tear down */
  },
};

export const activate = plugin.activate.bind(plugin);
export const deactivate = plugin.deactivate?.bind(plugin);
export default plugin;
