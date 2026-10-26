import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";
import type { TrackerDriver } from "../types.js";

export function makeUpdateMetaTool(drv: () => TrackerDriver | null): AgentTool {
  return {
    schema: {
      name: "ph_update_meta",
      description:
        "Get all updatable fields for an issue and their allowed values. " +
        "Call this BEFORE ph_update_issue to know which status transitions are " +
        "allowed, which users can be assigned, and which priorities are available.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Issue id." },
        },
        required: ["id"],
      },
    },
    async execute(raw: Record<string, unknown>, _ctx: AgentToolContext) {
      const d = drv();
      if (!d) return { error: "ProjectHub not configured." };
      try {
        const meta = await d.getUpdateMeta(raw.id as string);
        return meta;
      } catch (err: any) {
        return { error: err.message ?? String(err) };
      }
    },
  };
}
