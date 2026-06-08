// Browser agent tools — proxy through Playwright MCP running inside
// the per-tenant sandbox VM (see templates/browser.yaml). The
// BrowserSidecar reports the host port the supervisor's
// playwright-mcp is forwarded to; we POST tools/call to that.
//
// Why proxy instead of expose Playwright MCP to the model directly:
//   - The model already runs against tianshu's own tool API, not
//     a stdio MCP server. Surfacing each playwright tool here keeps
//     the gating, schema, and result shape consistent across plugins.
//   - We can pick a useful subset (navigate / snapshot / screenshot)
//     instead of every Playwright primitive, and translate output
//     into the agent's preferred shape (text-first).
//   - When @playwright/mcp's tool surface evolves we change it
//     here, not in every prompt that uses the browser.

import { Type } from "typebox";
import type {
  AgentTool,
  AgentToolContext,
  BrowserSidecar,
} from "@tianshu/plugin-sdk";
import { errorResult, okResult } from "@tianshu/plugin-sdk";
import { McpClient, McpClientError } from "./mcp-client.js";

function getBrowserSidecar(ctx: AgentToolContext): BrowserSidecar | null {
  return ctx.capabilities.get<BrowserSidecar>("browser.cdp") ?? null;
}

async function browserAvailable(ctx: AgentToolContext): Promise<boolean> {
  if (!ctx.capabilities.has("browser.cdp")) return false;
  const s = getBrowserSidecar(ctx);
  if (!s) return false;
  return s.mcpHostPort() !== undefined;
}

function mcpClient(ctx: AgentToolContext): McpClient | null {
  const s = getBrowserSidecar(ctx);
  const port = s?.mcpHostPort();
  if (!port) return null;
  return new McpClient(`http://127.0.0.1:${port}`);
}

/** Pull the `text` content out of a Playwright MCP response. The
 *  server returns rich content arrays; for text-shaped tools (the
 *  bulk of them) the first text block is the human-readable summary
 *  + the structured payload. */
function textFromMcpContent(c: unknown): string {
  if (!Array.isArray(c)) return "";
  const parts: string[] = [];
  for (const block of c) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const t = (block as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("\n\n");
}

const NOT_AVAILABLE =
  "browser.cdp not available — confirm the browser-template Sandboxfile is built and in use, and that the live VM has finished starting supervisord (admin Browser page should show three host ports).";

// ─── browser_navigate ─────────────────────────────────────────

export const BrowserNavigateTool: AgentTool = {
  schema: {
    name: "browser_navigate",
    description: `Navigate the embedded browser to a URL. Equivalent to \
Playwright's \`page.goto(url)\`. Returns the final URL (after redirects), \
the page title, and an accessibility snapshot describing the loaded page.

Use this when you need to render JavaScript, capture a screenshot, or \
interact with elements — for plain HTML/JSON fetching prefer the lighter \
\`fetch\` flow if available.`,
    parameters: Type.Object({
      url: Type.String({
        description: "Absolute URL (must include scheme).",
      }),
    }),
  },

  async available(ctx) {
    return browserAvailable(ctx);
  },

  async execute(args, ctx) {
    const client = mcpClient(ctx);
    if (!client) return errorResult(NOT_AVAILABLE);
    const url = String((args as { url?: unknown }).url ?? "");
    if (!url) return errorResult("url is required");
    try {
      const r = await client.callTool("browser_navigate", { url });
      const text = textFromMcpContent(r.content);
      if (r.isError) return errorResult(text || "browser_navigate failed", { mcp: r });
      return okResult(text || `Navigated to ${url}.`, { mcp: r });
    } catch (err) {
      return errorResult(
        err instanceof McpClientError
          ? `Playwright MCP: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err),
      );
    }
  },
};

// ─── browser_snapshot ─────────────────────────────────────────

export const BrowserSnapshotTool: AgentTool = {
  schema: {
    name: "browser_snapshot",
    description: `Capture an accessibility snapshot of the current page — \
the structured AX tree (roles, names, refs) Playwright MCP uses by default. \
Cheaper than \`browser_screenshot\` for "what does the page look like" \
questions. Use the screenshot tool when you actually need pixels (visual \
verification, vision-model prompting).`,
    parameters: Type.Object({}),
  },

  async available(ctx) {
    return browserAvailable(ctx);
  },

  async execute(_args, ctx) {
    const client = mcpClient(ctx);
    if (!client) return errorResult(NOT_AVAILABLE);
    try {
      const r = await client.callTool("browser_snapshot", {});
      const text = textFromMcpContent(r.content);
      if (r.isError) return errorResult(text || "browser_snapshot failed", { mcp: r });
      return okResult(text || "(empty snapshot)", { mcp: r });
    } catch (err) {
      return errorResult(
        err instanceof McpClientError
          ? `Playwright MCP: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err),
      );
    }
  },
};

// ─── browser_screenshot ───────────────────────────────────────

export const BrowserScreenshotTool: AgentTool = {
  schema: {
    name: "browser_screenshot",
    description: `Capture a PNG screenshot of the current page. Returns \
text confirmation plus a base64 image attachment.

Defaults to the visible viewport. Pass \`full_page: true\` for a stitched \
full-document image (slower; can be huge for long pages).`,
    parameters: Type.Object({
      full_page: Type.Optional(
        Type.Boolean({
          description:
            "Capture the entire page including scrolled-off content. Default false.",
        }),
      ),
    }),
  },

  async available(ctx) {
    return browserAvailable(ctx);
  },

  async execute(args, ctx) {
    const client = mcpClient(ctx);
    if (!client) return errorResult(NOT_AVAILABLE);
    const fullPage = Boolean((args as { full_page?: unknown }).full_page);
    try {
      // @playwright/mcp 0.x uses `browser_take_screenshot`. We
      // expose the simpler name to the model and translate.
      const r = await client.callTool("browser_take_screenshot", {
        fullPage,
        // raw=false yields a JPEG by default which is fine for
        // smaller responses; jpeg/png both go base64 over MCP.
      });
      const text = textFromMcpContent(r.content) || "screenshot captured";
      if (r.isError) return errorResult(text, { mcp: r });
      return okResult(text, { mcp: r });
    } catch (err) {
      return errorResult(
        err instanceof McpClientError
          ? `Playwright MCP: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err),
      );
    }
  },
};

export const browserTools = {
  BrowserNavigateTool,
  BrowserSnapshotTool,
  BrowserScreenshotTool,
};
