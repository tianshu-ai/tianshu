// Browser toolset: reflect every tool advertised by the per-tenant
// Playwright MCP server into AgentTools.
//
// History: in N+5.3 we hand-wrote three wrappers (browser_navigate,
// browser_snapshot, browser_screenshot) that proxied through the
// internal McpClient. Yu's correct push-back ("why not just expose
// MCP directly?") plus the realisation that we were burning a wrapper
// per tool for no real win led to N+5.4. Now we use the SDK-supplied
// `McpToolset`, which:
//
//   - calls Playwright MCP's `tools/list` once the sandbox is up
//   - reflects every advertised tool (~25 today) into a pi-ai
//     AgentTool with the upstream schema verbatim
//   - re-runs `tools/list` on demand (refresh()) so we pick up
//     additions when the upstream package upgrades
//   - keeps tool names prefixed with "" (no extra prefix — the
//     upstream already names them `browser_*`) so the agent UI
//     stays readable
//   - shows up in the global /admin/mcp page via
//     `provider.snapshot()`
//
// What's *not* here: post-processing of MCP results. The SDK's
// `textOfMcpContent` already extracts text blocks and surfaces
// them as the tool's `text` field (with the structured payload
// preserved on `data`). Anything fancier (e.g. snapshot
// summarisation) goes in describe() / a custom Toolset subclass.

import type {
  AgentToolContext,
  BrowserSidecar,
  PluginLogger,
} from "@tianshu/plugin-sdk";
import { McpToolset } from "@tianshu/plugin-sdk";

/**
 * Build the Playwright-MCP toolset for one active plugin tenant.
 * Caller wires this object into `exports.toolsetProviders` and
 * triggers `refresh()` whenever the BrowserSidecar's MCP host port
 * transitions from undefined → number (e.g. after sandbox start).
 *
 * The endpoint resolver re-reads `sidecar.mcpHostPort()` on every
 * refresh, so a sandbox reset (which picks a new free port) is
 * handled transparently.
 */
export function makeBrowserToolset(opts: {
  /** Sidecar wrapper around the active runner. Read every refresh. */
  getSidecar: () => BrowserSidecar | null;
  /** Plugin logger; used for refresh-error breadcrumbs. */
  log: PluginLogger;
}): McpToolset {
  const toolset = new McpToolset({
    name: "playwright",
    // Upstream tools are already `browser_*`; an extra prefix would
    // give us `playwright_browser_*` which is silly. The model-facing
    // name stays the same as before.
    prefix: "",
    resolve: () => {
      const s = opts.getSidecar();
      const port = s?.mcpHostPort();
      return port ? `http://127.0.0.1:${port}` : undefined;
    },
    // Playwright MCP server inside the sandbox is bound to
    // `localhost:3200`; we connect through a host-side port forward
    // so set the Host header to match what the upstream allows.
    upstreamHost: "localhost:3200",
    // Trim Playwright's wall-of-text descriptions to something
    // closer to one line per tool — the agent's prompt budget is
    // tight and the upstream descriptions repeat a lot of preamble.
    describe: (t) => {
      if (!t.description) return undefined;
      const firstSentence = t.description.split(/(?<=[.!?])\s+/)[0]?.trim();
      // Keep first sentence + "(Playwright MCP)" suffix so the
      // model knows where the capability comes from. This mirrors
      // the labelling style of other server-prefixed tools.
      return firstSentence
        ? `${firstSentence} (Playwright MCP)`
        : t.description;
    },
  });
  // Best-effort prime: try to populate the tool list now so the
  // first agent turn already sees the surface. The toolset itself
  // also self-refreshes lazily on each tools call, so failures here
  // (sandbox not booted yet) are non-fatal.
  void toolset.refresh().catch((err) => {
    opts.log.warn(
      `playwright MCP toolset initial refresh failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
  return toolset;
}

/**
 * Type-marker re-export so server.ts stays self-contained when we
 * later add per-tool helpers (post-processing, custom describe()
 * blocks) without churning the import graph.
 */
export type { AgentToolContext };
