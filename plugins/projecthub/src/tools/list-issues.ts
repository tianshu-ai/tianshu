import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";
import type { TrackerDriver } from "../types.js";
import { issueListHtml } from "../card-html.js";

export function makeListIssuesTool(drv: () => TrackerDriver | null): AgentTool {
  return {
    schema: {
      name: "ph_list_issues",
      description:
        "List issues from the connected project tracker. Filter by project, status, " +
        "assignee, or tracker. Returns id, subject, status, priority, assignee, dates.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project identifier. Uses default if omitted." },
          status: { type: "string", description: "'open' (default), 'closed', '*' (all), or a status id." },
          assigned_to: { type: "string", description: "'me' or a user id." },
          tracker_id: { type: "string", description: "Tracker / issue type id." },
          limit: { type: "number", description: "Max results (default 25)." },
          sort: { type: "string", description: "Sort, e.g. 'priority:desc,updated_on:desc'." },
        },
      },
    },
    async execute(raw: Record<string, unknown>, _ctx: AgentToolContext) {
      const d = drv();
      if (!d) return { error: "ProjectHub not configured. Set driver, baseUrl, and apiKey in plugin settings." };
      const a = raw as Record<string, any>;
      const r = await d.listIssues({
        projectId: a.project_id, status: a.status ?? "open",
        assignee: a.assigned_to, trackerId: a.tracker_id,
        limit: a.limit, sort: a.sort,
      });
      return {
        ok: true,
        text: `[${r.total} issues displayed in card]`,
        data: {
          mcpUi: [{ uri: "ui://projecthub/issues", mimeType: "text/html", html: issueListHtml(r.issues, r.total) }],
        },
      };
    },
  };
}
