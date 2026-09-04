// Unified data source plugin for tianshu.
//
// Supports Neo4j and MySQL (extensible to more).
// Configuration in plugins.datasource.connections:
//   { "name": { "type": "neo4j|mysql", ... } }

import type { Request, Response } from "express";
import type {
  PluginContext,
  PluginServerExports,
  PluginServerModule,
} from "@tianshu-ai/plugin-sdk";
import { configure, pingAll } from "./connection-pool.js";
import type { ConnectionConfig } from "./drivers/index.js";
import { DsListTool } from "./tools/list.js";
import { DsQueryTool } from "./tools/query.js";
import { DsExecuteTool } from "./tools/execute.js";
import { DsSchemaTool } from "./tools/schema.js";

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    const raw = (ctx.pluginConfig ?? {}) as Record<string, unknown>;

    // connections can be a JSON string (from configSchema) or an object
    let connections: Record<string, ConnectionConfig> = {};
    if (typeof raw.connections === "string") {
      try { connections = JSON.parse(raw.connections); } catch { /* empty */ }
    } else if (typeof raw.connections === "object" && raw.connections !== null) {
      connections = raw.connections as Record<string, ConnectionConfig>;
    }

    const names = Object.keys(connections);
    if (names.length === 0) {
      ctx.log.warn("datasource: no connections configured");
    } else {
      ctx.log.info(`datasource: ${names.length} connection(s): ${names.join(", ")}`);
    }

    configure(connections);

    return {
      tools: {
        DsListTool,
        DsQueryTool,
        DsExecuteTool,
        DsSchemaTool,
      },
      routes: {
        getStatus: async (_req: Request, res: Response) => {
          const results = await pingAll();
          const allOk = Object.values(results).every((r) => r.ok);
          res.json({ ok: allOk, connections: results });
        },
      },
    };
  },
};

export default plugin;
