// Neo4j graph database plugin for tianshu.
//
// Three agent tools:
//   - neo4j_query   — read-only Cypher queries
//   - neo4j_write   — write Cypher (CREATE/MERGE/DELETE/SET)
//   - neo4j_schema  — inspect labels, relationships, indexes, samples
//
// Configuration in config.json under plugins.neo4j:
//   { "uri": "bolt://host:7687", "username": "neo4j",
//     "password": "...", "database": "neo4j" }

import type { Request, Response } from "express";
import type {
  PluginContext,
  PluginServerExports,
  PluginServerModule,
} from "@tianshu-ai/plugin-sdk";
import { configure, verifyConnectivity, close } from "./connection.js";
import { Neo4jQueryTool } from "./tools/query.js";
import { Neo4jWriteTool } from "./tools/write.js";
import { Neo4jSchemaTool } from "./tools/schema.js";

interface Neo4jPluginConfig {
  uri?: string;
  username?: string;
  password?: string;
  database?: string;
}

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    const raw = (ctx.pluginConfig ?? {}) as Neo4jPluginConfig;
    const cfg = {
      uri: raw.uri || "bolt://localhost:7687",
      username: raw.username || "neo4j",
      password: raw.password || "",
      database: raw.database || "neo4j",
    };

    if (!cfg.password) {
      ctx.log.warn("neo4j: no password configured — tools will fail until config is set");
    } else {
      ctx.log.info(`neo4j: connecting to ${cfg.uri} (db: ${cfg.database})`);
    }

    configure(cfg);

    return {
      tools: {
        Neo4jQueryTool,
        Neo4jWriteTool,
        Neo4jSchemaTool,
      },
      routes: {
        getStatus: async (_req: Request, res: Response) => {
          const err = await verifyConnectivity();
          if (err) {
            res.json({ ok: false, error: err, uri: cfg.uri, database: cfg.database });
          } else {
            res.json({ ok: true, uri: cfg.uri, database: cfg.database });
          }
        },
      },
    };
  },
};

export default plugin;
