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
import { configureTenant, configureUser, getUserConnections, pingAll, listSources as poolListSources } from "./connection-pool.js";
import type { ConnectionConfig } from "./drivers/index.js";
import { DsListTool } from "./tools/list.js";
import { DsQueryTool } from "./tools/query.js";
import { DsExecuteTool } from "./tools/execute.js";
import { DsSchemaTool } from "./tools/schema.js";
import { buildDsPanelTool } from "./tools/panel.js";

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    const tenantId = ctx.tenantId;

    // Read connections from live pluginConfig (getter re-reads on every access)
    function readConnections(): Record<string, ConnectionConfig> {
      const raw = (ctx.pluginConfig ?? {}) as Record<string, unknown>;
      let connections: Record<string, ConnectionConfig> = {};
      if (typeof raw.connections === "string") {
        try { connections = JSON.parse(raw.connections); } catch { /* empty */ }
      } else if (typeof raw.connections === "object" && raw.connections !== null) {
        connections = raw.connections as Record<string, ConnectionConfig>;
      }
      return connections;
    }

    // ── Tenant-level sync ─────────────────────────────────────
    let lastConfigJson = "";
    function ensureConfigured(): Record<string, ConnectionConfig> {
      const connections = readConnections();
      const json = JSON.stringify(connections);
      if (json !== lastConfigJson) {
        lastConfigJson = json;
        const names = Object.keys(connections);
        if (names.length === 0) {
          ctx.log.warn("datasource: no connections configured");
        } else {
          ctx.log.info(`datasource: config updated, ${names.length} connection(s): ${names.join(", ")}`);
        }
        configureTenant(tenantId, connections);
      }
      return connections;
    }

    // ── User-level connections (stored in user_preferences) ────
    const USER_DS_KEY = "datasource.connections";
    const lastUserConfigJson = new Map<string, string>();

    function readUserConnections(userId: string): Record<string, ConnectionConfig> {
      if (!userId) return {};
      try {
        const row = ctx.db.prepare<[string, string], { value: string | null }>(
          "SELECT value FROM user_preferences WHERE user_id = ? AND key = ?",
        ).get(userId, USER_DS_KEY);
        if (row?.value) return JSON.parse(row.value);
      } catch { /* empty */ }
      return {};
    }

    function writeUserConnections(userId: string, conns: Record<string, ConnectionConfig>): void {
      if (!userId) return;
      ctx.db.prepare(
        "INSERT OR REPLACE INTO user_preferences (user_id, key, value) VALUES (?, ?, ?)",
      ).run(userId, USER_DS_KEY, JSON.stringify(conns));
    }

    function ensureUserConfigured(userId: string): void {
      if (!userId) return;
      const conns = readUserConnections(userId);
      const json = JSON.stringify(conns);
      if (json !== (lastUserConfigJson.get(userId) ?? "")) {
        lastUserConfigJson.set(userId, json);
        configureUser(tenantId, userId, conns);
      }
    }

    ensureConfigured();

    return {
      tools: {
        DsListTool,
        DsQueryTool,
        DsExecuteTool,
        DsSchemaTool,
        DsPanelTool: buildDsPanelTool((type, payload) => ctx.broadcast(type, payload)),
      },
      routes: {
        getStatus: async (req: Request, res: Response) => {
          ensureConfigured();
          const userId = (req as any).ctx?.userId ?? "";
          ensureUserConfigured(userId);
          const results = await pingAll(tenantId, userId);
          const allOk = Object.values(results).every((r) => r.ok);
          res.json({ ok: allOk, connections: results });
        },
        // List connections with their types (no secrets)
        listConnections: (req: Request, res: Response) => {
          ensureConfigured();
          const userId = (req as any).ctx?.userId ?? "";
          ensureUserConfigured(userId);
          const sources = poolListSources(tenantId, userId);
          const allConns = { ...readConnections(), ...readUserConnections(userId) };
          const safe = sources.map((s) => {
            const cfg = allConns[s.name];
            return {
              name: s.name,
              type: s.type,
              description: s.description,
              scope: s.scope,
              ...(cfg?.type === "neo4j" ? { uri: (cfg as Record<string,unknown>).uri, database: (cfg as Record<string,unknown>).database } : {}),
              ...(cfg?.type === "mysql" ? { host: (cfg as Record<string,unknown>).host, port: (cfg as Record<string,unknown>).port, database: (cfg as Record<string,unknown>).database } : {}),
            };
          });
          res.json({ connections: safe });
        },
        // ── User-level connection CRUD ──────────────────────────
        getUserConnections: (req: Request, res: Response) => {
          const userId = (req as any).ctx?.userId ?? "";
          if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }
          const conns = readUserConnections(userId);
          // Strip secrets
          const safe: Record<string, Record<string, unknown>> = {};
          for (const [name, cfg] of Object.entries(conns)) {
            const { password, token, apiKeyValue, clientSecret, ...rest } = cfg as Record<string, unknown>;
            safe[name] = { ...rest, ...(password ? { password: "***" } : {}), ...(token ? { token: "***" } : {}), ...(apiKeyValue ? { apiKeyValue: "***" } : {}), ...(clientSecret ? { clientSecret: "***" } : {}) };
          }
          res.json({ connections: safe });
        },
        saveUserConnections: (req: Request, res: Response) => {
          const userId = (req as any).ctx?.userId ?? "";
          if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }
          const body = (req as any).body ?? {};
          const conns = body.connections as Record<string, ConnectionConfig> | undefined;
          if (!conns || typeof conns !== "object") {
            res.status(400).json({ error: "connections object required" });
            return;
          }
          // Merge secrets: if a field is "***", keep the old value
          const existing = readUserConnections(userId);
          for (const [name, cfg] of Object.entries(conns)) {
            const old = existing[name] as Record<string, unknown> | undefined;
            if (!old) continue;
            for (const key of ["password", "token", "apiKeyValue", "clientSecret"] as const) {
              if ((cfg as Record<string, unknown>)[key] === "***" && old[key]) {
                (cfg as Record<string, unknown>)[key] = old[key];
              }
            }
          }
          writeUserConnections(userId, conns);
          configureUser(tenantId, userId, conns);
          lastUserConfigJson.set(userId, JSON.stringify(conns));
          ctx.log.info(`datasource: user ${userId} saved ${Object.keys(conns).length} connection(s)`);
          res.json({ ok: true });
        },
        deleteUserConnection: (req: Request, res: Response) => {
          const userId = (req as any).ctx?.userId ?? "";
          if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }
          const name = (req.params as Record<string, string>)?.name ?? req.path.split("/").pop();
          const conns = readUserConnections(userId);
          if (!conns[name]) { res.status(404).json({ error: `Connection "${name}" not found` }); return; }
          delete conns[name];
          writeUserConnections(userId, conns);
          configureUser(tenantId, userId, conns);
          lastUserConfigJson.set(userId, JSON.stringify(conns));
          ctx.log.info(`datasource: user ${userId} deleted connection "${name}"`);
          res.json({ ok: true });
        },

        // Test a single connection
        testConnection: async (req: Request, res: Response) => {
          ensureConfigured();
          const userId = (req as any).ctx?.userId ?? "";
          ensureUserConfigured(userId);
          const name = (req.params as Record<string, string>)?.name
            ?? req.path.split("/").pop();
          try {
            const driver = await import("./connection-pool.js").then(m => m.getDriver(tenantId, name, userId));
            const err = await driver.ping();
            res.json(err ? { ok: false, error: err } : { ok: true, name });
          } catch (err) {
            res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        },
        // Panel query endpoint
        runQuery: async (req: Request, res: Response) => {
          ensureConfigured();
          const userId = (req as any).ctx?.userId ?? "";
          ensureUserConfigured(userId);
          const body = (req as unknown as { body?: Record<string, unknown> }).body ?? {};
          const source = String(body.source ?? "");
          const q = String(body.query ?? "");
          if (!source || !q) {
            res.json({ error: "source and query are required" });
            return;
          }
          try {
            const driver = await import("./connection-pool.js").then(m => m.getDriver(tenantId, source, userId));
            const extraHeaders = (body.extraHeaders && typeof body.extraHeaders === "object") ? body.extraHeaders as Record<string, string> : undefined;
            const result = await driver.query(q, (body.params ?? {}) as Record<string, unknown>, extraHeaders);
            res.json({ columns: result.columns, rows: result.rows.slice(0, 200), rowCount: result.rowCount });
          } catch (err) {
            res.json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
        // Panel schema endpoint
        getSchema: async (req: Request, res: Response) => {
          ensureConfigured();
          const userId = (req as any).ctx?.userId ?? "";
          ensureUserConfigured(userId);
          const name = (req.params as Record<string, string>)?.name ?? req.path.split("/").pop();
          try {
            const driver = await import("./connection-pool.js").then(m => m.getDriver(tenantId, name, userId));
            const result = await driver.schema("overview");
            res.json({ text: result.text });
          } catch (err) {
            res.json({ error: err instanceof Error ? err.message : String(err) });
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
            { id: "rest", name: "REST API", fields: [
              { key: "baseUrl", label: "Base URL", placeholder: "https://api.example.com", required: true },
              { key: "authType", label: "Authentication", fieldType: "select", options: [
                { value: "none", label: "None" },
                { value: "bearer", label: "Bearer Token" },
                { value: "apikey", label: "API Key" },
                { value: "basic", label: "Basic Auth" },
                { value: "oauth2", label: "OAuth2 (Client Credentials)" },
                { value: "custom", label: "Custom Headers" },
              ]},
              { key: "token", label: "Token", secret: true, showWhen: { authType: "bearer" } },
              { key: "apiKeyName", label: "Header Name", placeholder: "X-API-Key", showWhen: { authType: "apikey" } },
              { key: "apiKeyValue", label: "API Key", secret: true, showWhen: { authType: "apikey" } },
              { key: "username", label: "Username", showWhen: { authType: "basic" } },
              { key: "password", label: "Password", secret: true, showWhen: { authType: "basic" } },
              { key: "headers", label: "Custom Headers (JSON)", placeholder: '{"X-Custom": "value"}', showWhen: { authType: "custom" } },
              { key: "extraHeaders", label: "Extra Headers (JSON)", placeholder: '{"Accept": "application/json"}' },
              { key: "tokenUrl", label: "Token URL", placeholder: "https://auth.example.com/oauth/token", required: true, showWhen: { authType: "oauth2" } },
              { key: "clientId", label: "Client ID", required: true, showWhen: { authType: "oauth2" } },
              { key: "clientSecret", label: "Client Secret", secret: true, required: true, showWhen: { authType: "oauth2" } },
              { key: "scope", label: "Scope", placeholder: "read write", showWhen: { authType: "oauth2" } },
              { key: "timeout", label: "Timeout (ms)", placeholder: "30000" },
            ]},
          ]});
        },
      },
    };
  },
};

export default plugin;
