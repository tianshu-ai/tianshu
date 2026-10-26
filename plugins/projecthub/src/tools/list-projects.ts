import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";
import type { TrackerDriver } from "../types.js";
import { projectListHtml } from "../card-html.js";

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
      const summary = r.projects.map((p) => `${p.identifier}: ${p.name}`).join("\n");
      return {
        ok: true,
        text: `[UI_CARD_RENDERED — data below is already displayed to the user as a rich card, do not repeat it in your response]\n${r.total} projects:\n${summary}`,
        data: {
          mcpUi: [{ uri: "ui://projecthub/projects", mimeType: "text/html", html: projectListHtml(r.projects, r.total) }],
        },
      };
    },
  };
}
