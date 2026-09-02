// neo4j_write — execute a write Cypher query (CREATE, MERGE, DELETE, SET, etc.).

import type { AgentToolContext, AgentTool } from "@tianshu-ai/plugin-sdk";
import { writeSession } from "../connection.js";

export const Neo4jWriteTool: AgentTool = {
  schema: {
    name: "neo4j_write",
    description:
      "Execute a write Cypher query against Neo4j (CREATE, MERGE, DELETE, SET, REMOVE). " +
      "Returns counters (nodes/relationships created/deleted). " +
      "Use for inserting data, updating properties, creating relationships.",
    parameters: {
      type: "object",
      properties: {
        cypher: {
          type: "string",
          description: "Cypher write query",
        },
        params: {
          type: "object",
          description: "Query parameters",
          additionalProperties: true,
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

    const params = (args.params ?? {}) as Record<string, unknown>;
    const session = writeSession();
    try {
      const result = await session.run(cypher, params);
      const c = result.summary.counters.updates();
      const lines: string[] = ["Write executed successfully."];
      if (c.nodesCreated) lines.push(`Nodes created: ${c.nodesCreated}`);
      if (c.nodesDeleted) lines.push(`Nodes deleted: ${c.nodesDeleted}`);
      if (c.relationshipsCreated) lines.push(`Relationships created: ${c.relationshipsCreated}`);
      if (c.relationshipsDeleted) lines.push(`Relationships deleted: ${c.relationshipsDeleted}`);
      if (c.propertiesSet) lines.push(`Properties set: ${c.propertiesSet}`);
      if (c.labelsAdded) lines.push(`Labels added: ${c.labelsAdded}`);
      if (c.labelsRemoved) lines.push(`Labels removed: ${c.labelsRemoved}`);
      if (c.indexesAdded) lines.push(`Indexes added: ${c.indexesAdded}`);
      if (c.indexesRemoved) lines.push(`Indexes removed: ${c.indexesRemoved}`);
      if (c.constraintsAdded) lines.push(`Constraints added: ${c.constraintsAdded}`);
      if (c.constraintsRemoved) lines.push(`Constraints removed: ${c.constraintsRemoved}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
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
