import type { AgentTool } from "@tianshu-ai/plugin-sdk";
import { getDriver } from "../connection-pool.js";

const MAX_ROWS = 200;

export const DsQueryTool: AgentTool = {
  schema: {
    name: "ds_query",
    description:
      "Execute a read-only query against a data source. " +
      "Use SQL for MySQL, Cypher for Neo4j. Returns up to 200 rows. " +
      "Call ds_list first to see available sources.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "Data source name (from ds_list)" },
        query: { type: "string", description: "Query string (SQL for MySQL, Cypher for Neo4j)" },
        params: {
          type: "object",
          description: "Query parameters. MySQL: {:name} style. Neo4j: {$name} style.",
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
      const result = await driver.query(query, (args.params ?? {}) as Record<string, unknown>);
      const rows = result.rows.slice(0, MAX_ROWS);
      const text = formatResult(result.columns, rows, result.rowCount);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Query error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
};

function formatResult(columns: string[], rows: Record<string, unknown>[], totalCount: number): string {
  if (rows.length === 0) return "No results.";
  if (columns.length <= 8 && rows.length <= 50) {
    const header = `| ${columns.join(" | ")} |`;
    const sep = `| ${columns.map(() => "---").join(" | ")} |`;
    const body = rows.map((r) =>
      `| ${columns.map((k) => String(r[k] ?? "")).join(" | ")} |`
    );
    return [`${totalCount} row(s)`, "", header, sep, ...body].join("\n");
  }
  return `${totalCount} row(s)\n\n` + JSON.stringify(rows, null, 2);
}
