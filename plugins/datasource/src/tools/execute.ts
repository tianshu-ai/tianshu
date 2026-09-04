import type { AgentTool } from "@tianshu-ai/plugin-sdk";
import { getDriver } from "../connection-pool.js";

export const DsExecuteTool: AgentTool = {
  schema: {
    name: "ds_execute",
    description:
      "Execute a write operation or DDL against a data source. " +
      "Use for INSERT/UPDATE/DELETE/CREATE/ALTER/DROP (SQL) or " +
      "CREATE/MERGE/DELETE/SET (Cypher). Returns affected row counts.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "Data source name (from ds_list)" },
        query: { type: "string", description: "Write query or DDL statement" },
        params: {
          type: "object",
          description: "Query parameters",
          additionalProperties: true,
        },
      },
      required: ["source", "query"],
    },
  },

  async execute(args: Record<string, unknown>) {
    const source = String(args.source ?? "");
    const query = String(args.query ?? "");
    if (!source || !query) {
      return { content: [{ type: "text", text: "source and query are required" }], isError: true };
    }
    try {
      const driver = await getDriver(source);
      const result = await driver.execute(query, (args.params ?? {}) as Record<string, unknown>);
      return {
        content: [{ type: "text", text: `Executed successfully. Affected: ${result.affectedRows}. ${result.details}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Execute error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
};
