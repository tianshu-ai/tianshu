import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";
import type { TrackerDriver } from "../types.js";

export function makeUpdateIssueTool(drv: () => TrackerDriver | null): AgentTool {
  return {
    schema: {
      name: "ph_update_issue",
      description:
        "Update an existing issue — change status, assignee, priority, progress, due date, or add a comment.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Issue id to update." },
          status_id: { type: "string", description: "New status id." },
          assignee_id: { type: "string", description: "New assignee user id." },
          priority_id: { type: "string", description: "New priority id." },
          done_ratio: { type: "number", description: "Progress percentage (0-100)." },
          due_date: { type: "string", description: "New due date (YYYY-MM-DD)." },
          subject: { type: "string", description: "New subject." },
          description: { type: "string", description: "New description." },
          notes: { type: "string", description: "Comment to add." },
        },
        required: ["id"],
      },
    },
    async execute(raw: Record<string, unknown>, _ctx: AgentToolContext) {
      const d = drv();
      if (!d) return { error: "ProjectHub not configured." };
      const a = raw as Record<string, any>;
      try {
        await d.updateIssue(a.id, {
          subject: a.subject, description: a.description,
          statusId: a.status_id, priorityId: a.priority_id,
          assigneeId: a.assignee_id, doneRatio: a.done_ratio,
          dueDate: a.due_date, notes: a.notes,
        });
        // Verify: Redmine silently ignores workflow-invalid fields (returns 200)
        const after = await d.getIssue(a.id);
        const warnings: string[] = [];
        if (a.status_id && String(after.statusId ?? '') !== String(a.status_id)) {
          warnings.push(`Status was NOT changed (workflow may not allow this transition). Current status: ${after.status} (id=${after.statusId})`);
        }
        if (a.assignee_id && String(after.assigneeId ?? '') !== String(a.assignee_id)) {
          warnings.push(`Assignee was NOT changed. Current assignee: ${after.assignee ?? 'unassigned'}`);
        }
        if (warnings.length > 0) {
          return { updated: false, issue_id: a.id, warnings, current: { status: after.status, statusId: after.statusId, assignee: after.assignee } };
        }
        return { updated: true, issue_id: a.id };
      } catch (err: any) {
        return { error: err.message ?? String(err) };
      }
    },
  };
}
