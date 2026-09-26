import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";
import { getDriver } from "../connection-pool.js";

export const DsExecuteTool: AgentTool = {
  schema: {
    name: "ds_execute",
    description:
      "Execute a write operation against a data source. " +
      "SQL: INSERT/UPDATE/DELETE/CREATE/ALTER/DROP. Cypher: CREATE/MERGE/DELETE/SET. " +
      "REST: 'POST /path' or 'PUT /path' with params as JSON body. Returns affected row counts.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "Data source name (from ds_list)" },
        query: { type: "string", description: "Write query or DDL statement" },
        params: {
          type: "object",
          description: "Query parameters. REST: JSON body for POST/PUT/PATCH.",
          additionalProperties: true,
        },
        headers: {
          type: "object",
          description: "Extra HTTP headers for this request (REST only). Merged with connection-level headers.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["source", "query"],
    },
  },

  async execute(args: Record<string, unknown>, ctx: AgentToolContext) {
    const source = String(args.source ?? "");
    const query = String(args.query ?? "");
    if (!source || !query) {
      return { content: [{ type: "text", text: "source and query are required" }], isError: true };
    }
    try {
      const driver = await getDriver(ctx.tenantId, source);
      const hdrs = args.headers && typeof args.headers === "object" ? args.headers as Record<string, string> : undefined;
      const result = await driver.execute(query, (args.params ?? {}) as Record<string, unknown>, hdrs);
      return {
        content: [{ type: "text", text: `Executed successfully. Affected: ${result.affectedRows}. ${result.details}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Execute error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
};
