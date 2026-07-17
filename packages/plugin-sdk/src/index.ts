// @tianshu-ai/plugin-sdk — server-side plugin authoring types.
//
// A plugin is one directory: manifest.json + server entry + client
// entry (see ADR-0003 §1). The server entry exports `activate(ctx)`
// (and optional `deactivate()`) and types from this module guide the
// shape of the returned exports.
//
// Client-side types live at `@tianshu-ai/plugin-sdk/client` so a plugin
// author can install just the SDK in their package and pull both
// halves from one source.

export * from "./capabilities.js";
export * from "./manifest.js";
export * from "./server.js";
export * from "./agent-loop.js";
export * from "./session-inbox.js";
export * from "./catalog.js";
export * from "./opencode-proxy.js";
export * from "./lsp.js";
export * from "./channel-bindings.js";
export * from "./workforce-snapshot.js";
export * from "./solution.js";
export {
  McpToolset,
  textOfMcpContent,
  extractMcpUiResources,
  type McpUiResource,
  type McpEndpointResolver,
  type McpToolDescriptor,
  type McpToolFilter,
  type McpToolsetEntry,
  type McpToolsetOptions,
  type McpToolsetSnapshot,
  type ToolsetProvider,
} from "./mcp-toolset.js";
