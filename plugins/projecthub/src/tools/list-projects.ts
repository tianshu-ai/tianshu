import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";
import type { TrackerDriver } from "../types.js";

export function makeListProjectsTool(drv: () => TrackerDriver | null): AgentTool {
  return {
    schema: {
      name: "ph_list_projects",
      description: "List all accessible projects from the connected tracker.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max results (default 100)." },
        },
      },
    },
    async execute(raw: Record<string, unknown>, _ctx: AgentToolContext) {
      const d = drv();
      if (!d) return { error: "ProjectHub not configured." };
      const a = raw as Record<string, any>;
      const r = await d.listProjects({ limit: a.limit });
      return { total: r.total, projects: r.projects };
    },
  };
}
