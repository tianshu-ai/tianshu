import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";
import { listSources } from "../connection-pool.js";

export const DsListTool: AgentTool = {
  schema: {
    name: "ds_list",
    description:
      "List all configured data source connections with their type and description. " +
      "Call this first to discover available sources before querying.",
    parameters: { type: "object", properties: {} },
  },
  async execute(_args: Record<string, unknown>, ctx: AgentToolContext) {
    const sources = listSources(ctx.tenantId);
    if (sources.length === 0) {
      return { content: [{ type: "text", text: "No data sources configured." }] };
    }
    const lines = sources.map((s) => `- **${s.name}** (${s.type})${s.description ? ` — ${s.description}` : ""}`);
    return { content: [{ type: "text", text: `${sources.length} data source(s):\n${lines.join("\n")}` }] };
  },
};
