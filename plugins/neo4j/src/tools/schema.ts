// neo4j_schema — inspect the graph database schema.

import type { AgentToolContext, AgentTool } from "@tianshu-ai/plugin-sdk";
import { readSession } from "../connection.js";

export const Neo4jSchemaTool: AgentTool = {
  schema: {
    name: "neo4j_schema",
    description:
      "Inspect the Neo4j database schema: node labels, relationship types, " +
      "property keys, indexes, and constraints. Also returns node/relationship " +
      "counts. Call this first to understand the graph structure before querying.",
    parameters: {
      type: "object",
      properties: {
        detail: {
          type: "string",
          enum: ["overview", "labels", "relationships", "indexes", "sample"],
          description:
            "Level of detail. overview (default): labels + rel types + counts. " +
            "labels: all labels with property keys + counts. " +
            "relationships: all rel types with connected labels. " +
            "indexes: all indexes + constraints. " +
            "sample: 5 example nodes per label.",
        },
      },
    },
  },

  async execute(args: Record<string, unknown>, ctx: AgentToolContext) {
    const detail = String(args.detail || "overview");
    const session = readSession();
    try {
      switch (detail) {
        case "labels": return { content: [{ type: "text", text: await getLabelsDetail(session) }] };
        case "relationships": return { content: [{ type: "text", text: await getRelationshipsDetail(session) }] };
        case "indexes": return { content: [{ type: "text", text: await getIndexesDetail(session) }] };
        case "sample": return { content: [{ type: "text", text: await getSamples(session) }] };
        default: return { content: [{ type: "text", text: await getOverview(session) }] };
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `Schema error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    } finally {
      await session.close();
    }
  },
};

async function getOverview(session: import("neo4j-driver").Session): Promise<string> {
  const labels = await session.run("CALL db.labels() YIELD label RETURN label ORDER BY label");
  const rels = await session.run("CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType");
  const countRes = await session.run("MATCH (n) RETURN count(n) as nodeCount");
  const relCountRes = await session.run("MATCH ()-[r]->() RETURN count(r) as relCount");

  const nodeCount = countRes.records[0]?.get("nodeCount")?.toNumber?.() ?? countRes.records[0]?.get("nodeCount") ?? 0;
  const relCount = relCountRes.records[0]?.get("relCount")?.toNumber?.() ?? relCountRes.records[0]?.get("relCount") ?? 0;

  const lines = [
    `# Neo4j Schema Overview`,
    ``,
    `Total nodes: ${nodeCount}`,
    `Total relationships: ${relCount}`,
    ``,
    `## Node Labels (${labels.records.length})`,
    ...labels.records.map(r => `- :${r.get("label")}`),
    ``,
    `## Relationship Types (${rels.records.length})`,
    ...rels.records.map(r => `- [:${r.get("relationshipType")}]`),
  ];
  return lines.join("\n");
}

async function getLabelsDetail(session: import("neo4j-driver").Session): Promise<string> {
  const labels = await session.run("CALL db.labels() YIELD label RETURN label ORDER BY label");
  const lines = ["# Node Labels Detail", ""];
  for (const r of labels.records) {
    const label = r.get("label");
    const count = await session.run(`MATCH (n:\`${label}\`) RETURN count(n) as c`);
    const c = count.records[0]?.get("c")?.toNumber?.() ?? count.records[0]?.get("c") ?? 0;
    const props = await session.run(
      `MATCH (n:\`${label}\`) WITH n LIMIT 100 UNWIND keys(n) AS key RETURN DISTINCT key ORDER BY key`
    );
    const propList = props.records.map(p => p.get("key")).join(", ");
    lines.push(`## :${label} (${c} nodes)`);
    lines.push(`Properties: ${propList || "(none)"}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function getRelationshipsDetail(session: import("neo4j-driver").Session): Promise<string> {
  const result = await session.run(
    `CALL db.schema.visualization() YIELD nodes, relationships RETURN nodes, relationships`
  );
  if (result.records.length === 0) return "No schema visualization available.";
  // Fallback: enumerate relationship types with connected labels
  const rels = await session.run(
    `MATCH (a)-[r]->(b)
     RETURN DISTINCT labels(a)[0] AS from, type(r) AS rel, labels(b)[0] AS to, count(*) AS count
     ORDER BY count DESC LIMIT 50`
  );
  const lines = ["# Relationship Types Detail", ""];
  for (const r of rels.records) {
    lines.push(`(:${r.get("from")})-[:${r.get("rel")}]->(:${r.get("to")})  ×${r.get("count")}`);
  }
  return lines.join("\n");
}

async function getIndexesDetail(session: import("neo4j-driver").Session): Promise<string> {
  const indexes = await session.run("SHOW INDEXES");
  const constraints = await session.run("SHOW CONSTRAINTS");
  const lines = [
    "# Indexes",
    "",
    ...indexes.records.map(r => {
      const name = r.get("name");
      const type = r.get("type");
      const labelsOrTypes = r.get("labelsOrTypes");
      const properties = r.get("properties");
      return `- ${name} (${type}) on ${labelsOrTypes} [${properties}]`;
    }),
    "",
    "# Constraints",
    "",
    ...constraints.records.map(r => {
      const name = r.get("name");
      const type = r.get("type");
      return `- ${name} (${type})`;
    }),
  ];
  return lines.join("\n");
}

async function getSamples(session: import("neo4j-driver").Session): Promise<string> {
  const labels = await session.run("CALL db.labels() YIELD label RETURN label ORDER BY label");
  const lines = ["# Sample Nodes (5 per label)", ""];
  for (const r of labels.records) {
    const label = r.get("label");
    const samples = await session.run(`MATCH (n:\`${label}\`) RETURN n LIMIT 5`);
    lines.push(`## :${label}`);
    for (const s of samples.records) {
      const node = s.get("n");
      lines.push(`  ${JSON.stringify(node.properties)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
