// @tianshu/plugin-sdk — server-side plugin authoring types.
//
// A plugin is one directory: manifest.json + server entry + client
// entry (see ADR-0003 §1). The server entry exports `activate(ctx)`
// (and optional `deactivate()`) and types from this module guide the
// shape of the returned exports.
//
// Client-side types live at `@tianshu/plugin-sdk/client` so a plugin
// author can install just the SDK in their package and pull both
// halves from one source.

export * from "./capabilities.js";
export * from "./manifest.js";
export * from "./server.js";
export {
  McpToolset,
  textOfMcpContent,
  type McpEndpointResolver,
  type McpToolDescriptor,
  type McpToolFilter,
  type McpToolsetEntry,
  type McpToolsetOptions,
  type McpToolsetSnapshot,
  type ToolsetProvider,
} from "./mcp-toolset.js";
