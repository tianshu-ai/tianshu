// neo4j_query — execute a read-only Cypher query.

import type { AgentToolContext, AgentTool } from "@tianshu-ai/plugin-sdk";
import { readSession } from "../connection.js";
import { formatRecords } from "../format.js";

const MAX_ROWS = 200;

export const Neo4jQueryTool: AgentTool = {
  schema: {
    name: "neo4j_query",
    description:
      "Execute a read-only Cypher query against the Neo4j graph database. " +
      "Returns up to 200 rows as JSON. Use for searching nodes, traversing " +
      "relationships, aggregations, and path queries.",
    parameters: {
      type: "object",
      properties: {
        cypher: {
          type: "string",
          description: "Cypher query (read-only: MATCH, RETURN, WITH, etc.)",
        },
        params: {
          type: "object",
          description: "Query parameters (e.g. { name: 'Alice' } for $name in Cypher)",
          additionalProperties: true,
        },
        limit: {
          type: "number",
          description: `Max rows to return (default ${MAX_ROWS})`,
        },
      },
      required: ["cypher"],
    },
  },

  async execute(args: Record<string, unknown>, ctx: AgentToolContext) {
    const cypher = String(args.cypher ?? "");
    if (!cypher) {
      return { content: [{ type: "text", text: "cypher is required" }], isError: true };
    }

    // Block obvious write operations.
    const upper = cypher.toUpperCase().trim();
    if (/^(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|CALL\s+\{)/m.test(upper)) {
      return {
        content: [{ type: "text", text: "neo4j_query is read-only. Use neo4j_write for mutations." }],
        isError: true,
      };
    }

    const limit = Math.min(Number(args.limit) || MAX_ROWS, MAX_ROWS);
    const params = (args.params ?? {}) as Record<string, unknown>;

    const session = readSession();
    try {
      const result = await session.run(cypher, params);
      const rows = result.records.slice(0, limit);
      const text = formatRecords(rows, result.summary);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Cypher error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    } finally {
      await session.close();
    }
  },
};
