// Browser agent tools (N+5.1 scaffold).
//
// Three tools land in this PR; their *capabilities* are wired
// (manifest contributions, host-side tool registration, agent
// gating via `available()`) but the implementations are stubs that
// return a structured "browser stack not running" error until
// N+5.3 lights up the real Playwright MCP / chromium pipe.
//
// Why ship the tools now:
// - The agent needs to *see* them in `tools/list` so plugin authors
//   building skills/prompts can write against the final shape.
// - `available()` already gates them off when the BrowserSidecar
//   reports no chromium, so a model trying to use one gets the
//   tool-not-available signal cleanly instead of a fake success.
// - The Playwright MCP path is fixed: when the chromium ships in
//   N+5.2/3, the only change here is replacing the stub bodies
//   with `fetch(http://localhost:<mcpPort>/...)` calls. Schemas,
//   names, and gating stay identical.
//
// Tool surface intentionally mirrors a useful subset of
// @playwright/mcp's tools so anyone familiar with that vocabulary
// can transition without re-learning. Once Playwright MCP is
// running we can decide whether to proxy more of its tools through
// or expose its own stdio MCP server directly to the agent.

import { Type } from "typebox";
import type {
  AgentTool,
  AgentToolContext,
  BrowserSidecar,
} from "@tianshu/plugin-sdk";
import { errorResult, okResult } from "@tianshu/plugin-sdk";

/** Resolve the live BrowserSidecar via the capability registry. We
 *  go through `capabilities.get` (not a direct import) so any
 *  future plugin that also provides browser.cdp seamlessly
 *  replaces ours without code changes here. */
function getBrowserSidecar(ctx: AgentToolContext): BrowserSidecar | null {
  return ctx.capabilities.get<BrowserSidecar>("browser.cdp") ?? null;
}

/** Common gate: the tool advertises itself only when the sidecar
 *  is *both* registered and reporting chromium-up. The first
 *  condition is satisfied by the plugin shipping a sidecar (always
 *  in this PR); the second isn't until N+5.3. The result is that
 *  models don't see fictitious browser tools today. */
async function browserAvailable(ctx: AgentToolContext): Promise<boolean> {
  if (!ctx.capabilities.has("browser.cdp")) return false;
  const s = getBrowserSidecar(ctx);
  if (!s) return false;
  // We require the MCP port specifically because every tool here
  // routes through Playwright MCP. If MCP isn't up the tools have
  // nothing to call.
  return s.mcpHostPort() !== undefined;
}

const NOT_RUNNING_HINT =
  "browser stack not running yet. Ship the chromium + Playwright MCP layer in your Sandboxfile and rebuild (lands in a follow-up PR).";

// ─── browser_navigate ─────────────────────────────────────────

export const BrowserNavigateTool: AgentTool = {
  schema: {
    name: "browser_navigate",
    description: `Navigate the embedded browser to a URL. Equivalent to \
Playwright's \`page.goto(url)\`. Returns the final URL (after redirects) \
and the page title once the load event fires.

Use this when you need to render JavaScript, capture a screenshot, or \
interact with elements — for plain HTML/JSON fetching prefer the lighter \
\`fetch\` flow if available.`,
    parameters: Type.Object({
      url: Type.String({
        description: "Absolute URL (must include scheme).",
      }),
      wait_until: Type.Optional(
        Type.Union(
          [
            Type.Literal("load"),
            Type.Literal("domcontentloaded"),
            Type.Literal("networkidle"),
          ],
          {
            description:
              "Page-load milestone before resolving. Default 'load'. 'networkidle' is slower but safer for SPAs.",
          },
        ),
      ),
    }),
  },

  async available(ctx) {
    return browserAvailable(ctx);
  },

  async execute(_args, _ctx) {
    return errorResult(NOT_RUNNING_HINT);
  },
};

// ─── browser_snapshot ─────────────────────────────────────────

export const BrowserSnapshotTool: AgentTool = {
  schema: {
    name: "browser_snapshot",
    description: `Capture an accessibility snapshot of the current page. \
Returns a structured AX tree (roles, names, refs) that's much smaller and \
easier for an LLM to act on than a screenshot — same primitive \
@playwright/mcp uses by default.

Cheaper than \`browser_screenshot\` for "what does the page look like" \
questions; use the screenshot tool when you need pixels (visual \
verification, vision-model prompting).`,
    parameters: Type.Object({}),
  },

  async available(ctx) {
    return browserAvailable(ctx);
  },

  async execute(_args, _ctx) {
    return errorResult(NOT_RUNNING_HINT);
  },
};

// ─── browser_screenshot ───────────────────────────────────────

export const BrowserScreenshotTool: AgentTool = {
  schema: {
    name: "browser_screenshot",
    description: `Capture a PNG screenshot of the current page. Returns \
a path to the file in the user's workspace, plus pixel dimensions.

Defaults to the visible viewport. Pass \`full_page: true\` for a stitched \
full-document image (slower; can be huge for long pages).`,
    parameters: Type.Object({
      full_page: Type.Optional(
        Type.Boolean({
          description:
            "Capture the entire page including scrolled-off content. Default false.",
        }),
      ),
      output_name: Type.Optional(
        Type.String({
          description:
            "Filename (without dir) the PNG is saved as. Default: timestamped name. Saved under <user-home>/screenshots/.",
        }),
      ),
    }),
  },

  async available(ctx) {
    return browserAvailable(ctx);
  },

  async execute(_args, _ctx) {
    return errorResult(NOT_RUNNING_HINT);
  },
};

// Re-exported by tools/index.ts so the plugin's server.ts can wire
// them into exports.tools without a long deep-import chain.
export const browserTools = {
  BrowserNavigateTool,
  BrowserSnapshotTool,
  BrowserScreenshotTool,
};

// Suppress unused-import lint: okResult is reserved for the
// follow-up PR that fills in the stubs.
void okResult;
