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

function readConfig(ctx: PluginContext): TrackerDriver | null {
  const raw = (ctx.pluginConfig ?? {}) as Record<string, unknown>;
  const driver = (raw.driver as string) || "redmine";
  const baseUrl = raw.baseUrl as string | undefined;
  const apiKey = raw.apiKey as string | undefined;
  if (!baseUrl || !apiKey) return null;
  const cfg: DriverConfig = {
    driver,
    baseUrl,
    apiKey,
    defaultProject: (raw.defaultProject as string) || undefined,
  };
  return createDriver(cfg);
}

const plugin: PluginServerModule = {
  activate(ctx) {
    const getDrv = () => readConfig(ctx);

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
    };
  },
};

export default plugin;
