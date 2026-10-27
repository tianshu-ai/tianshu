import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";
import type { TrackerDriver } from "../types.js";
import { projectDetailHtml } from "../card-html.js";

export function makeUpdateProjectTool(drv: () => TrackerDriver | null): AgentTool {
  return {
    schema: {
      name: "ph_update_project",
      description:
        "Update an existing project — change name, description, visibility, trackers, or modules.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Project id or identifier." },
          name: { type: "string", description: "New project name." },
          description: { type: "string", description: "New description." },
          homepage: { type: "string", description: "New homepage URL." },
          is_public: { type: "boolean", description: "Whether the project is public." },
          tracker_ids: { type: "array", items: { type: "number" }, description: "Tracker ids to enable." },
          enabled_module_names: { type: "array", items: { type: "string" }, description: "Module names to enable." },
        },
        required: ["id"],
      },
    },
    async execute(raw: Record<string, unknown>, _ctx: AgentToolContext) {
      const d = drv();
      if (!d) return { error: "ProjectHub not configured." };
      try {
        const a = raw as Record<string, any>;
        await d.updateProject(a.id, {
          name: a.name,
          description: a.description,
          homepage: a.homepage,
          isPublic: a.is_public,
          trackerIds: a.tracker_ids,
          enabledModuleNames: a.enabled_module_names,
        });
        // Re-fetch to show updated state
        const project = await d.getProject(a.id);
        return {
          ok: true,
          text: `[UI_CARD_RENDERED — data below is already displayed to the user as a rich card, do not repeat it in your response]\nUpdated project: ${project.name} (${project.identifier})`,
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
