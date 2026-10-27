import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";
import type { TrackerDriver } from "../types.js";
import { projectDetailHtml } from "../card-html.js";

export function makeGetProjectTool(drv: () => TrackerDriver | null): AgentTool {
  return {
    schema: {
      name: "ph_get_project",
      description:
        "Get project details — trackers, enabled modules, visibility, timestamps.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Project id or identifier." },
        },
        required: ["id"],
      },
    },
    async execute(raw: Record<string, unknown>, _ctx: AgentToolContext) {
      const d = drv();
      if (!d) return { error: "ProjectHub not configured." };
      try {
        const a = raw as Record<string, any>;
        const project = await d.getProject(a.id);
        const text = [
          `[UI_CARD_RENDERED — data below is already displayed to the user as a rich card, do not repeat it in your response]`,
          `Project: ${project.name} (${project.identifier})`,
          project.description ? `Description: ${project.description}` : "",
          `Trackers: ${project.trackers.map((t) => t.name).join(", ")}`,
          `Modules: ${project.enabledModules.join(", ")}`,
          `Public: ${project.isPublic}`,
        ].filter(Boolean).join("\n");
        return {
          ok: true,
          text,
          data: {
            mcpUi: [{ uri: `ui://projecthub/project/${project.identifier}`, mimeType: "text/html", html: projectDetailHtml(project) }],
          },
        };
      } catch (err: any) {
        return { error: err.message ?? String(err) };
      }
    },
  };
}
