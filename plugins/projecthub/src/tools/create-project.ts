import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";
import type { TrackerDriver } from "../types.js";
import { projectDetailHtml } from "../card-html.js";

export function makeCreateProjectTool(drv: () => TrackerDriver | null): AgentTool {
  return {
    schema: {
      name: "ph_create_project",
      description:
        "Create a new project in the connected tracker.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Project display name." },
          identifier: { type: "string", description: "URL-safe identifier (lowercase, hyphens)." },
          description: { type: "string", description: "Project description." },
          homepage: { type: "string", description: "Project homepage URL." },
          is_public: { type: "boolean", description: "Whether the project is public (default true)." },
          parent_id: { type: "string", description: "Parent project id for sub-projects." },
          tracker_ids: { type: "array", items: { type: "number" }, description: "Tracker ids to enable." },
          enabled_module_names: { type: "array", items: { type: "string" }, description: "Module names to enable (e.g. issue_tracking, wiki, time_tracking)." },
        },
        required: ["name", "identifier"],
      },
    },
    async execute(raw: Record<string, unknown>, _ctx: AgentToolContext) {
      const d = drv();
      if (!d) return { error: "ProjectHub not configured." };
      try {
        const a = raw as Record<string, any>;
        const project = await d.createProject({
          name: a.name,
          identifier: a.identifier,
          description: a.description,
          homepage: a.homepage,
          isPublic: a.is_public,
          parentId: a.parent_id,
          trackerIds: a.tracker_ids,
          enabledModuleNames: a.enabled_module_names,
        });
        return {
          ok: true,
          text: `[UI_CARD_RENDERED — data below is already displayed to the user as a rich card, do not repeat it in your response]\nCreated project: ${project.name} (${project.identifier})`,
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
