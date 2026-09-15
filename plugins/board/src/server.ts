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
import type { WebSocket } from "ws";
import { injectRuntime } from "./runtime.js";
import { registerRequest, resolveRequest, type BoardActResult } from "./bridge.js";

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

// A sibling asset filename inside a board directory. Same char
// class as isSafeName plus the file extension. We disallow slashes
// (single path segment only) because the underlying plugin router
// param `[A-Za-z0-9._~-]+` cannot represent subdirectories anyway
// — declaring the restriction here means we fail fast with a clean
// 404 rather than a confusing plugin-router miss.
const ASSET_NAME_RE = /^[A-Za-z0-9._-]+\.[A-Za-z0-9]+$/;

// Content-Type by lowercased extension. Anything not listed is
// served as application/octet-stream so the browser doesn't try to
// execute it as script. Keep this list conservative — boards are
// user code but they run in a sandboxed iframe, so we only need
// the types index.html actually links to.
const ASSET_CONTENT_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

/**
 * Locate a board's sibling asset file (styles.css, app.js, etc.)
 * and return its bytes + content-type, or null if missing/unsafe.
 *
 * Contract:
 *   * `name` passes isSafeName (same as index.html serving).
 *   * `file` passes ASSET_NAME_RE — a single segment, dot, and
 *      known extension.
 *   * Resolved absolute path is a descendant of the user's board
 *      dir (path-traversal defence in depth).
 *   * Extension is a known content-type. Unknown extensions get
 *      a 404 rather than octet-stream + attacker-controlled
 *      content, because the whole point of this is to load CSS
 *      and JS into an iframe — anything weird is either a typo
 *      in the board or someone testing us.
 */
function readBoardAsset(
  userHomeDir: string,
  name: string,
  file: string,
): { bytes: Buffer; contentType: string } | null {
  if (!isSafeName(name)) return null;
  if (!ASSET_NAME_RE.test(file)) return null;
  if (file === "index.html") {
    // index.html has its own route; keep this handler focused on
    // siblings so route-selection stays predictable.
    return null;
  }
  const ext = file.split(".").pop()!.toLowerCase();
  const contentType = ASSET_CONTENT_TYPES[ext];
  if (!contentType) return null;
  const absFile = path.join(boardsRoot(userHomeDir), name, file);
  const root = path.resolve(boardsRoot(userHomeDir));
  if (!path.resolve(absFile).startsWith(root + path.sep)) return null;
  try {
    const bytes = fs.readFileSync(absFile);
    return { bytes, contentType };
  } catch {
    return null;
  }
}

// ─── agent tool: show_board ─────────────────────────────────────

function buildShowBoardTool(pluginCtx: PluginContext): AgentTool {
  return {
    schema: {
      name: "show_board",
      description:
        "Display one of the user's boards (an HTML dashboard under board/<name>/index.html) as an interactive UI in the chat AND switch the side Boards panel to it. List available boards by calling with no name. The board renders in a sandboxed iframe; its HTML is not added to your context.",
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
      // Also switch the side Boards panel to this board, so "show me
      // board X" updates the panel too (not just drops a fresh chat
      // card). BoardPanel listens for board:board_show.
      pluginCtx.broadcast("board_show", { name });
      // Return the board as an MCP-UI resource so the chat renders it
      // as an iframe (same path as any ui:// resource). Short text for
      // the model; html on data.mcpUi for the web layer. Inject the
      // board_act runtime so the agent can drive the live DOM.
      return {
        ok: true,
        text: `[board: ${name}]`,
        data: {
          mcpUi: [
            {
              uri: `ui://board/${name}`,
              mimeType: "text/html",
              html: injectRuntime(html),
            },
          ],
        },
      };
    },
  };
}

// ─── agent tool: board_act ──────────────────────────────────────
//
// Drive a live board's DOM (click / fill / query / wait_for / eval /
// dump). The tool can't touch the iframe directly (it lives in the
// user's browser), so it registers a pending request in the bridge,
// broadcasts `board_act_request` to the tenant, and awaits the
// browser's `board_act_response` (handled by boardActResponse below).

const ACT_ACTIONS = ["query", "click", "fill", "wait_for", "eval", "dump"] as const;

function buildBoardActTool(ctx: PluginContext): AgentTool {
  return {
    schema: {
      name: "board_act",
      description:
        "Interact with a specific board's live DOM: click an element, fill a form field, read text/attributes, wait for an element, dump the interactive DOM, or eval a small script. Pass the board `name` (the same name you'd pass to show_board) so the op targets the right board — the board must be visible (shown in chat via show_board or open in the Boards panel). Selectors are CSS. Use `dump` first to discover selectors.",
      parameters: Type.Object({
        name: Type.String({
          description:
            "Board name to target (subdirectory of board/, e.g. the name passed to show_board). Required so the op reaches the right board when several are on screen.",
        }),
        action: Type.Union(
          ACT_ACTIONS.map((a) => Type.Literal(a)),
          { description: "Operation to perform on the board DOM." },
        ),
        selector: Type.Optional(
          Type.String({ description: "CSS selector (click/fill/query/wait_for; optional for dump)." }),
        ),
        value: Type.Optional(
          Type.String({ description: "Value to set (fill)." }),
        ),
        attr: Type.Optional(
          Type.String({ description: "Attribute to read for query: 'text' (default), 'html', 'value', or any attribute name." }),
        ),
        mode: Type.Optional(
          Type.String({ description: "dump mode: 'elements' (default, interactive DOM outline) or 'text'." }),
        ),
        script: Type.Optional(
          Type.String({ description: "Async JS body to eval inside the board (return a JSON-serialisable value)." }),
        ),
        timeout_ms: Type.Optional(
          Type.Number({ description: "Timeout in ms for wait_for (default 5000) and the overall request (default 30000)." }),
        ),
      }),
    },
    execute: async (raw): Promise<ToolResult> => {
      const op = raw as {
        name?: string;
        action?: string;
        selector?: string;
        value?: string;
        attr?: string;
        mode?: string;
        script?: string;
        timeout_ms?: number;
      };
      const name = typeof op.name === "string" ? op.name.trim() : "";
      if (!name) {
        return { ok: false, text: "board_act requires a `name` (which board to act on). Pass the same name you used with show_board." };
      }
      const action = typeof op.action === "string" ? op.action : "";
      if (!ACT_ACTIONS.includes(action as (typeof ACT_ACTIONS)[number])) {
        return { ok: false, text: `Invalid action: "${action}". One of: ${ACT_ACTIONS.join(", ")}.` };
      }
      const timeoutMs =
        typeof op.timeout_ms === "number" && op.timeout_ms > 0
          ? Math.min(op.timeout_ms, 120_000)
          : 30_000;
      const { reqId, promise } = registerRequest(timeoutMs);
      // Include `name` so exactly the matching board iframe answers
      // (several boards can be on screen at once; without routing they
      // race and a stale board can win, returning the wrong content).
      ctx.broadcast("board_act_request", { reqId, name, op });
      let result: BoardActResult;
      try {
        result = await promise;
      } catch (err) {
        return {
          ok: false,
          text:
            err instanceof Error
              ? err.message
              : `board_act failed: ${String(err)}. Is the board open in the Boards panel?`,
        };
      }
      if (!result.ok) {
        return { ok: false, text: result.error ?? "board_act failed" };
      }
      const data = result.data;
      const text =
        data === null || data === undefined
          ? `board_act ${action} ok`
          : typeof data === "string"
            ? data
            : JSON.stringify(data);
      return { ok: true, text: text.slice(0, 8000), data };
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
    // Inject the board_act runtime so the agent's board_act tool can
    // drive this board's DOM through the panel iframe.
    res.send(injectRuntime(html));
  };

  const serveBoardAsset: PluginRouteHandler = (req: Request, res: Response) => {
    // Sibling asset loader for a board's index.html. Motivation
    // (Yu, 2026-09-15 23:07): boards want to `<link href="styles.css">`
    // and `<script src="app.js">` like any static site — without this
    // handler the browser hits /api/p/board/boards/:name/styles.css
    // and gets a 404 because only /index.html was routed.
    //
    // Auth mirrors serveBoard: same tenant + user context, same
    // isSafeName gate. readBoardAsset itself does the extension
    // whitelist and traversal check so this handler stays small.
    const userId = userIdFromReq(req);
    if (!userId) {
      res.status(401).json({ error: "no user context" });
      return;
    }
    const name = String(req.params.name ?? "");
    const file = String(req.params.file ?? "");
    const asset = readBoardAsset(ctx.userHomeDir(userId), name, file);
    if (asset === null) {
      res.status(404).send("board asset not found");
      return;
    }
    res.setHeader("Content-Type", asset.contentType);
    // Boards are user-authored and might change between reloads;
    // no aggressive caching. A short revalidation window is fine
    // — anyone editing a board expects reload-to-see-changes.
    res.setHeader("Cache-Control", "no-cache");
    res.send(asset.bytes);
  };

  return { listBoards, serveBoard, serveBoardAsset };
}

// ─── WS handler: board_act_response ─────────────────────────────
//
// The BoardPanel (browser) sends this after driving its iframe in
// response to a `board_act_request`. We resolve the pending promise
// the board_act tool is awaiting, keyed by reqId.

function boardActResponse(
  msg: { type: string } & Record<string, unknown>,
  _socket: WebSocket,
): void {
  const reqId = typeof msg.reqId === "string" ? msg.reqId : "";
  if (!reqId) return;
  const result: BoardActResult = {
    ok: msg.ok === true,
    data: msg.data,
    error: typeof msg.error === "string" ? msg.error : undefined,
  };
  resolveRequest(reqId, result);
}

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    ctx.log.info("board activated");
    return {
      tools: {
        ShowBoardTool: buildShowBoardTool(ctx),
        BoardActTool: buildBoardActTool(ctx),
      },
      routes: buildRoutes(ctx),
      wsHandlers: { boardActResponse },
    };
  },
  async deactivate() {
    /* nothing to tear down */
  },
};

export const activate = plugin.activate.bind(plugin);
export const deactivate = plugin.deactivate?.bind(plugin);
export default plugin;
