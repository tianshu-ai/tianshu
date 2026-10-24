// ds_panel — push a query to the Data Sources panel for the user to see/run.

import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";

export function buildDsPanelTool(broadcast: (type: string, payload: unknown) => void): AgentTool {
  return {
    schema: {
      name: "ds_panel",
      description:
        "Send a query to the Data Sources side panel. Pre-fills the data source and query, " +
        "and optionally auto-runs it. IMPORTANT: call switch_panel with panel=\"datasource\" first " +
        "to ensure the panel is open, then call this tool. " +
        "For REST API sources, use 'METHOD /path' format in query (e.g. 'POST /posts'). " +
        "Use body for POST/PUT/PATCH JSON payloads and headers for custom HTTP headers.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Data source name (from ds_list)" },
          query: { type: "string", description: "Query to pre-fill. For REST: 'METHOD /path' (e.g. 'GET /posts?_limit=3', 'POST /posts'). For SQL/Cypher: the query string." },
          body: { type: "string", description: "JSON body for REST POST/PUT/PATCH requests. Ignored for SQL/Cypher." },
          headers: {
            type: "object",
            description: "Custom HTTP headers as key-value pairs for REST requests.",
            additionalProperties: { type: "string" },
          },
          autoRun: {
            type: "boolean",
            description: "If true, automatically execute the query. Default false (just pre-fill).",
          },
        },
        required: ["source", "query"],
      },
    },
    async execute(args: Record<string, unknown>, _ctx: AgentToolContext) {
      const source = String(args.source ?? "");
      const query = String(args.query ?? "");
      const body = args.body != null ? String(args.body) : undefined;
      const headers = (args.headers && typeof args.headers === "object") ? args.headers as Record<string, string> : undefined;
      const autoRun = args.autoRun === true;
      if (!source || !query) {
        return { content: [{ type: "text", text: "source and query are required" }], isError: true };
      }
      broadcast("ds_panel_fill", { source, query, body, headers, autoRun });
      return {
        content: [{
          type: "text",
          text: autoRun
            ? `Query sent to Data Sources panel and auto-running on "${source}".`
            : `Query pre-filled in Data Sources panel for "${source}". User can review and run it.`,
        }],
      };
    },
  };
}
