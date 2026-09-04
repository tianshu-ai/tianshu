// ds_panel — push a query to the Data Sources panel for the user to see/run.

import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";

export function buildDsPanelTool(broadcast: (type: string, payload: unknown) => void): AgentTool {
  return {
    schema: {
      name: "ds_panel",
      description:
        "Send a query to the Data Sources side panel. The panel opens automatically, " +
        "pre-fills the data source and query, and optionally auto-runs it. " +
        "Use this when the user asks you to write a query for them to inspect or run.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Data source name (from ds_list)" },
          query: { type: "string", description: "Query to pre-fill (SQL or Cypher)" },
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
      const autoRun = args.autoRun === true;
      if (!source || !query) {
        return { content: [{ type: "text", text: "source and query are required" }], isError: true };
      }
      broadcast("ds_panel_fill", { source, query, autoRun });
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
