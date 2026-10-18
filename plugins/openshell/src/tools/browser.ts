// Browser toolset for the OpenShell plugin: reflects Playwright MCP
// tools into agent tools, identical pattern to microsandbox.
//
// The Playwright MCP server runs inside the Docker sandbox on
// a forwarded port; McpToolset connects via HTTP from the host.

import type {
  AgentToolContext,
  BrowserSidecar,
  PluginLogger,
} from "@tianshu-ai/plugin-sdk";
import { McpToolset } from "@tianshu-ai/plugin-sdk";

/**
 * Build the Playwright-MCP toolset for one active openshell tenant.
 * Same contract as microsandbox's makeBrowserToolset — the host
 * wires this into `exports.toolsetProviders` and triggers refresh()
 * when the sidecar reports its MCP port.
 */
export function makeBrowserToolset(opts: {
  getSidecar: () => BrowserSidecar | null;
  log: PluginLogger;
}): McpToolset {
  const toolset = new McpToolset({
    name: "playwright",
    // Upstream tools are already `browser_*`; no extra prefix.
    prefix: "",
    resolve: () => {
      const s = opts.getSidecar();
      const port = s?.mcpHostPort();
      return port ? `http://127.0.0.1:${port}/mcp` : undefined;
    },
    // Playwright MCP inside the sandbox binds to the forwarded port
    // on 0.0.0.0; Host header must match what it expects.
    upstreamHost: undefined, // forwarded port — Host matches naturally
    describe: (t) => {
      if (!t.description) return undefined;
      const firstSentence = t.description.split(/(?<=[.!?])\s+/)[0]?.trim();
      return firstSentence
        ? `${firstSentence} (Playwright MCP)`
        : t.description;
    },
  });
  // Best-effort prime.
  void toolset.refresh().catch((err) => {
    opts.log.warn(
      `playwright MCP toolset initial refresh failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
  return toolset;
}

export type { AgentToolContext };
