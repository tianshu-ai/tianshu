import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";
import type { TrackerDriver } from "../types.js";
import { issueDetailHtml } from "../card-html.js";

export function makeGetIssueTool(drv: () => TrackerDriver | null): AgentTool {
  return {
    schema: {
      name: "ph_get_issue",
      description:
        "Get full details of a single issue by id, including description, comments/journals, and child issues.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Issue id." },
          include: { type: "string", description: "Comma-separated extra data: children, attachments, relations, journals." },
        },
        required: ["id"],
      },
    },
    async execute(raw: Record<string, unknown>, _ctx: AgentToolContext) {
      const d = drv();
      if (!d) return { error: "ProjectHub not configured." };
      const a = raw as Record<string, any>;
      const includes = a.include ? (a.include as string).split(",").map((s: string) => s.trim()) : ["journals"];
      const issue = await d.getIssue(a.id, includes);
      return {
        ok: true,
        text: `#${issue.id} [${issue.status}] ${issue.subject}\n${issue.description?.slice(0, 200) ?? ""}`,
        data: {
          mcpUi: [{ uri: `ui://projecthub/issue/${issue.id}`, mimeType: "text/html", html: issueDetailHtml(issue) }],
        },
      };
    },
  };
}
