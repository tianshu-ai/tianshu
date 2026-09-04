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
        // List connections with their types (no secrets)
        listConnections: (_req: Request, res: Response) => {
          const safe = Object.entries(connections).map(([name, cfg]) => ({
            name,
            type: cfg.type,
            description: cfg.description ?? "",
            // Expose non-secret fields for display
            ...(cfg.type === "neo4j" ? { uri: (cfg as Record<string,unknown>).uri, database: (cfg as Record<string,unknown>).database } : {}),
            ...(cfg.type === "mysql" ? { host: (cfg as Record<string,unknown>).host, port: (cfg as Record<string,unknown>).port, database: (cfg as Record<string,unknown>).database } : {}),
          }));
          res.json({ connections: safe });
        },
        // Test a single connection
        testConnection: async (req: Request, res: Response) => {
          const name = (req.params as Record<string, string>)?.name
            ?? req.path.split("/").pop();
          if (!name || !connections[name]) {
            res.status(404).json({ ok: false, error: `Unknown connection: ${name}` });
            return;
          }
          try {
            const driver = await import("./connection-pool.js").then(m => m.getDriver(name));
            const err = await driver.ping();
            res.json(err ? { ok: false, error: err } : { ok: true, name });
          } catch (err) {
            res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        },
        // Supported driver types
        listTypes: (_req: Request, res: Response) => {
          res.json({ types: [
            { id: "neo4j", name: "Neo4j", fields: [
              { key: "uri", label: "URI", placeholder: "bolt://localhost:7687", required: true },
              { key: "username", label: "Username", placeholder: "neo4j", required: true },
              { key: "password", label: "Password", secret: true, required: true },
              { key: "database", label: "Database", placeholder: "neo4j" },
            ]},
            { id: "mysql", name: "MySQL", fields: [
              { key: "host", label: "Host", placeholder: "localhost", required: true },
              { key: "port", label: "Port", placeholder: "3306" },
              { key: "username", label: "Username", placeholder: "root", required: true },
              { key: "password", label: "Password", secret: true, required: true },
              { key: "database", label: "Database", required: true },
            ]},
          ]});
        },
      },
    };
  },
};

export default plugin;
