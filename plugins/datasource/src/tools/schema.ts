import type { AgentTool } from "@tianshu-ai/plugin-sdk";
import { getDriver } from "../connection-pool.js";

export const DsSchemaTool: AgentTool = {
  schema: {
    name: "ds_schema",
    description:
      "Inspect the schema of a data source. " +
      "Neo4j: labels, relationships, properties. MySQL: tables, columns, indexes. " +
      "Use detail='full' for column types/properties, 'sample' for example rows.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "Data source name (from ds_list)" },
        detail: {
          type: "string",
          enum: ["overview", "full", "sample"],
          description: "Level of detail. overview (default), full (with columns/properties), sample (with example rows)",
        },
      },
      required: ["source"],
    },
  },

  async execute(args: Record<string, unknown>) {
    const source = String(args.source ?? "");
    if (!source) {
      return { content: [{ type: "text", text: "source is required" }], isError: true };
    }
    try {
      const driver = await getDriver(source);
      const result = await driver.schema(String(args.detail || "overview"));
      return { content: [{ type: "text", text: result.text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Schema error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
};
