import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";
import type { TrackerDriver } from "../types.js";

export function makeCreateIssueTool(drv: () => TrackerDriver | null): AgentTool {
  return {
    schema: {
      name: "ph_create_issue",
      description: "Create a new issue in the project tracker. Returns the created issue with its id.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project identifier. Uses default if omitted." },
          subject: { type: "string", description: "Issue subject / title." },
          description: { type: "string", description: "Issue description." },
          tracker_id: { type: "string", description: "Tracker / issue type id." },
          priority_id: { type: "string", description: "Priority id." },
          assignee_id: { type: "string", description: "User id to assign to." },
          parent_id: { type: "string", description: "Parent issue id for sub-tasks." },
          start_date: { type: "string", description: "Start date (YYYY-MM-DD)." },
          due_date: { type: "string", description: "Due date (YYYY-MM-DD)." },
          estimated_hours: { type: "number", description: "Estimated hours." },
        },
        required: ["subject"],
      },
    },
    async execute(raw: Record<string, unknown>, _ctx: AgentToolContext) {
      const d = drv();
      if (!d) return { error: "ProjectHub not configured." };
      const a = raw as Record<string, any>;
      const issue = await d.createIssue({
        projectId: a.project_id ?? "",
        subject: a.subject,
        description: a.description,
        trackerId: a.tracker_id,
        priorityId: a.priority_id,
        assigneeId: a.assignee_id,
        parentId: a.parent_id,
        startDate: a.start_date,
        dueDate: a.due_date,
        estimatedHours: a.estimated_hours,
      });
      return { created: true, issue: { id: issue.id, subject: issue.subject, status: issue.status } };
    },
  };
}
