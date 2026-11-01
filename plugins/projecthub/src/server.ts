import type { PluginServerModule, PluginContext } from "@tianshu-ai/plugin-sdk";
import type { DriverConfig, TrackerDriver } from "./types.js";
import { createDriver } from "./drivers/index.js";
import { makeListIssuesTool } from "./tools/list-issues.js";
import { makeGetIssueTool } from "./tools/get-issue.js";
import { makeCreateIssueTool } from "./tools/create-issue.js";
import { makeUpdateIssueTool } from "./tools/update-issue.js";
import { makeUpdateMetaTool } from "./tools/update-meta.js";
import { makeListProjectsTool } from "./tools/list-projects.js";
import { makeGetProjectTool } from "./tools/get-project.js";
import { makeCreateProjectTool } from "./tools/create-project.js";
import { makeUpdateProjectTool } from "./tools/update-project.js";

const PREF_KEY = "projecthub.connection";

/** Read per-user connection config from user_preferences, fallback to tenant pluginConfig. */
function readConfig(ctx: PluginContext, userId?: string): TrackerDriver | null {
  const raw = (ctx.pluginConfig ?? {}) as Record<string, unknown>;
  let driver = (raw.driver as string) || "redmine";
  let baseUrl = raw.baseUrl as string | undefined;
  let apiKey: string | undefined = raw.apiKey as string | undefined;
  let defaultProject = (raw.defaultProject as string) || undefined;

  // Per-user overrides from user_preferences
  if (userId) {
    try {
      const row = ctx.db.prepare<[string, string], { value: string }>(
        "SELECT value FROM user_preferences WHERE user_id = ? AND key = ?"
      ).get(userId, PREF_KEY);
      if (row?.value) {
        const u = JSON.parse(row.value) as Record<string, string>;
        if (u.baseUrl) baseUrl = u.baseUrl;
        if (u.apiKey) apiKey = u.apiKey;
        if (u.driver) driver = u.driver;
        if (u.defaultProject) defaultProject = u.defaultProject;
      }
    } catch { /* no user config, use tenant defaults */ }
  }

  if (!baseUrl || !apiKey) return null;
  return createDriver({ driver, baseUrl, apiKey, defaultProject });
}

/** Get userId from express request (set by host auth middleware). */
function userIdFromReq(req: any): string | undefined {
  return req.ctx?.userId ?? req.rctx?.userId;
}

const plugin: PluginServerModule = {
  activate(ctx) {
    // getDrv now accepts optional userId for per-user config
    const getDrv = (userId?: string) => readConfig(ctx, userId);

    return {
      tools: {
        ListIssuesTool: makeListIssuesTool(getDrv),
        GetIssueTool: makeGetIssueTool(getDrv),
        CreateIssueTool: makeCreateIssueTool(getDrv),
        UpdateIssueTool: makeUpdateIssueTool(getDrv),
        UpdateMetaTool: makeUpdateMetaTool(getDrv),
        ListProjectsTool: makeListProjectsTool(getDrv),
        GetProjectTool: makeGetProjectTool(getDrv),
        CreateProjectTool: makeCreateProjectTool(getDrv),
        UpdateProjectTool: makeUpdateProjectTool(getDrv),
      },
      routes: {
        // ── User connection config ──────────────────────────────
        getConnection: async (req: any, res: any) => {
          const userId = userIdFromReq(req);
          if (!userId) return res.status(401).json({ error: "auth required" });
          try {
            const row = ctx.db.prepare<[string, string], { value: string }>(
              "SELECT value FROM user_preferences WHERE user_id = ? AND key = ?"
            ).get(userId, PREF_KEY);
            if (!row?.value) return res.json({ configured: false });
            const conn = JSON.parse(row.value) as Record<string, string>;
            // Never return the full apiKey to the client
            res.json({
              configured: true,
              driver: conn.driver || "redmine",
              baseUrl: conn.baseUrl || "",
              apiKeySet: !!conn.apiKey,
              defaultProject: conn.defaultProject || "",
            });
          } catch (err: any) {
            res.status(500).json({ error: err.message });
          }
        },

        saveConnection: async (req: any, res: any) => {
          const userId = userIdFromReq(req);
          if (!userId) return res.status(401).json({ error: "auth required" });
          const body = req.body ?? {};
          const conn: Record<string, string> = {};
          if (body.driver) conn.driver = String(body.driver);
          if (body.baseUrl) conn.baseUrl = String(body.baseUrl);
          if (body.apiKey) conn.apiKey = String(body.apiKey);
          if (body.defaultProject) conn.defaultProject = String(body.defaultProject);

          try {
            ctx.db.prepare(
              "INSERT OR REPLACE INTO user_preferences (user_id, key, value) VALUES (?, ?, ?)"
            ).run(userId, PREF_KEY, JSON.stringify(conn));

            // Test the connection
            const drv = readConfig(ctx, userId);
            if (!drv) return res.json({ ok: false, error: "Invalid config — could not create driver" });
            try {
              await drv.listProjects({ limit: 1 });
              res.json({ ok: true });
            } catch (err: any) {
              res.json({ ok: false, error: `Connection test failed: ${err.message}` });
            }
          } catch (err: any) {
            res.status(500).json({ error: err.message });
          }
        },

        deleteConnection: async (req: any, res: any) => {
          const userId = userIdFromReq(req);
          if (!userId) return res.status(401).json({ error: "auth required" });
          try {
            ctx.db.prepare(
              "DELETE FROM user_preferences WHERE user_id = ? AND key = ?"
            ).run(userId, PREF_KEY);
            res.json({ ok: true });
          } catch (err: any) {
            res.status(500).json({ error: err.message });
          }
        },

        // ── Existing routes (now user-aware) ────────────────────
        listProjects: async (req: any, res: any) => {
          const drv = getDrv(userIdFromReq(req));
          if (!drv) return res.json({ error: "projecthub not configured" });
          try {
            const { projects, total } = await drv.listProjects({ limit: 100 });
            res.json({ projects, total });
          } catch (err: any) {
            res.json({ error: err.message ?? String(err) });
          }
        },
        getProject: async (req: any, res: any) => {
          const drv = getDrv(userIdFromReq(req));
          if (!drv) return res.json({ error: "projecthub not configured" });
          const id = req.params?.id ?? req.path.split("/").pop();
          if (!id) return res.status(400).json({ error: "project id required" });
          try {
            const project = await drv.getProject(id);
            res.json({ project });
          } catch (err: any) {
            res.json({ error: err.message ?? String(err) });
          }
        },
        listIssues: async (req: any, res: any) => {
          const drv = getDrv(userIdFromReq(req));
          if (!drv) return res.json({ error: "projecthub not configured" });
          const q = req.query ?? {};
          try {
            const { issues, total } = await drv.listIssues({
              projectId: q.projectId || undefined,
              status: q.status || "open",
              limit: q.limit ? Number(q.limit) : 25,
            });
            res.json({ issues, total });
          } catch (err: any) {
            res.json({ error: err.message ?? String(err) });
          }
        },
        getIssue: async (req: any, res: any) => {
          const drv = getDrv(userIdFromReq(req));
          if (!drv) return res.json({ error: "projecthub not configured" });
          const id = req.params?.id ?? req.path.split("/").pop();
          if (!id) return res.status(400).json({ error: "issue id required" });
          try {
            const issue = await drv.getIssue(id, ["journals", "children"]);
            res.json({ issue });
          } catch (err: any) {
            res.json({ error: err.message ?? String(err) });
          }
        },
      },
    };
  },
};

export default plugin;
