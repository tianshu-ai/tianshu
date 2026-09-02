// neo4j_admin — schema management: create/drop indexes, constraints, labels.

import type { AgentToolContext, AgentTool } from "@tianshu-ai/plugin-sdk";
import { writeSession } from "../connection.js";

export const Neo4jAdminTool: AgentTool = {
  schema: {
    name: "neo4j_admin",
    description:
      "Manage Neo4j schema: create/drop indexes and constraints, " +
      "create node labels and relationship types via Cypher DDL. " +
      "Actions: create_index, drop_index, create_constraint, drop_constraint, " +
      "create_label (creates a dummy node then deletes it to register the label), " +
      "run_ddl (arbitrary DDL statement).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "create_index",
            "drop_index",
            "create_constraint",
            "drop_constraint",
            "create_label",
            "run_ddl",
          ],
          description: "Schema management action",
        },
        label: {
          type: "string",
          description: "Node label (for create_index, create_constraint, create_label)",
        },
        property: {
          type: "string",
          description: "Property name (for create_index, create_constraint)",
        },
        properties: {
          type: "array",
          items: { type: "string" },
          description: "Property names for composite index",
        },
        index_name: {
          type: "string",
          description: "Index or constraint name (for drop_index, drop_constraint)",
        },
        constraint_type: {
          type: "string",
          enum: ["unique", "exists", "node_key"],
          description: "Constraint type (default: unique)",
        },
        index_type: {
          type: "string",
          enum: ["btree", "fulltext", "text", "point", "range", "vector"],
          description: "Index type (default: range)",
        },
        cypher: {
          type: "string",
          description: "Raw DDL Cypher for run_ddl action",
        },
      },
      required: ["action"],
    },
  },

  async execute(args: Record<string, unknown>, ctx: AgentToolContext) {
    const action = String(args.action ?? "");
    const session = writeSession();

    try {
      switch (action) {
        case "create_index": {
          const label = String(args.label ?? "");
          const props = (args.properties as string[]) ?? [String(args.property ?? "")];
          const indexType = String(args.index_type || "range").toUpperCase();
          if (!label || !props.length || !props[0]) {
            return err("label and property/properties required");
          }
          const propList = props.map(p => `n.\`${p}\``).join(", ");
          const name = `idx_${label}_${props.join("_")}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
          const cypher = indexType === "FULLTEXT"
            ? `CREATE FULLTEXT INDEX \`${name}\` IF NOT EXISTS FOR (n:\`${label}\`) ON EACH [${propList}]`
            : `CREATE ${indexType} INDEX \`${name}\` IF NOT EXISTS FOR (n:\`${label}\`) ON (${propList})`;
          await session.run(cypher);
          return ok(`Index \`${name}\` created (${indexType}) on :${label}(${props.join(", ")})`);
        }

        case "drop_index": {
          const name = String(args.index_name ?? "");
          if (!name) return err("index_name required");
          await session.run(`DROP INDEX \`${name}\` IF EXISTS`);
          return ok(`Index \`${name}\` dropped`);
        }

        case "create_constraint": {
          const label = String(args.label ?? "");
          const prop = String(args.property ?? "");
          const type = String(args.constraint_type || "unique");
          if (!label || !prop) return err("label and property required");
          const name = `cst_${label}_${prop}_${type}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
          let cypher: string;
          switch (type) {
            case "unique":
              cypher = `CREATE CONSTRAINT \`${name}\` IF NOT EXISTS FOR (n:\`${label}\`) REQUIRE n.\`${prop}\` IS UNIQUE`;
              break;
            case "exists":
              cypher = `CREATE CONSTRAINT \`${name}\` IF NOT EXISTS FOR (n:\`${label}\`) REQUIRE n.\`${prop}\` IS NOT NULL`;
              break;
            case "node_key":
              cypher = `CREATE CONSTRAINT \`${name}\` IF NOT EXISTS FOR (n:\`${label}\`) REQUIRE n.\`${prop}\` IS NODE KEY`;
              break;
            default:
              return err(`Unknown constraint type: ${type}`);
          }
          await session.run(cypher);
          return ok(`Constraint \`${name}\` created (${type}) on :${label}.${prop}`);
        }

        case "drop_constraint": {
          const name = String(args.index_name ?? "");
          if (!name) return err("index_name required");
          await session.run(`DROP CONSTRAINT \`${name}\` IF EXISTS`);
          return ok(`Constraint \`${name}\` dropped`);
        }

        case "create_label": {
          const label = String(args.label ?? "");
          if (!label) return err("label required");
          // Create+delete a temp node to register the label in the schema.
          await session.run(
            `CREATE (n:\`${label}\` {_temp: true}) WITH n DELETE n`
          );
          return ok(`Label :${label} registered`);
        }

        case "run_ddl": {
          const cypher = String(args.cypher ?? "");
          if (!cypher) return err("cypher required for run_ddl");
          // Only allow DDL-like statements.
          const upper = cypher.toUpperCase().trim();
          if (!/^(CREATE|DROP|ALTER|CALL)\b/.test(upper)) {
            return err("run_ddl only allows CREATE/DROP/ALTER/CALL statements");
          }
          const result = await session.run(cypher);
          const c = result.summary.counters.updates();
          return ok(`DDL executed. ${JSON.stringify(c)}`);
        }

        default:
          return err(`Unknown action: ${action}`);
      }
    } catch (e) {
      return err(`Neo4j error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await session.close();
    }
  },
};

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
