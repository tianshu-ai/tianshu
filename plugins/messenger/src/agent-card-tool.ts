// Messenger plugin — agent-facing `update_agent_card` tool.
//
// Lets the agent update its own Agent Card (name + description).

import { Type } from "typebox";
import type { AgentTool } from "@tianshu-ai/plugin-sdk";
import type { Db } from "./schema.js";
import { getAgentCard, setAgentCard } from "./schema.js";

export function buildUpdateAgentCardTool(db: Db, broadcast: (event: string, data: unknown) => void): AgentTool {
  return {
    schema: {
      name: "update_agent_card",
      description:
        "Read or update this agent's Agent Card — the public profile other agents see via A2A.\n" +
        "- update_agent_card({action: \"read\"}) — returns the current card\n" +
        "- update_agent_card({name: \"...\", description: \"...\"}) — updates the card\n" +
        "The description should be a concise summary of what you can do, your skills, tools, and specialties.",
      parameters: Type.Object({
        action: Type.Optional(Type.String({ description: "read | update (default: update)" })),
        name: Type.Optional(Type.String({ description: "Agent display name" })),
        description: Type.Optional(Type.String({ description: "What this agent can do — skills, tools, specialties" })),
      }),
    },
    execute: async (raw) => {
      const p = raw as Record<string, unknown>;
      const action = String(p.action ?? "update");

      if (action === "read") {
        const card = getAgentCard(db);
        return JSON.stringify(card, null, 2);
      }

      // Update
      const name = typeof p.name === "string" ? p.name : undefined;
      const description = typeof p.description === "string" ? p.description : undefined;

      if (!name && !description) {
        return "Nothing to update. Provide name and/or description.";
      }

      const card = setAgentCard(db, { name, description });
      broadcast("messenger_changed", {});
      return `Agent card updated.\n${JSON.stringify(card, null, 2)}`;
    },
  };
}
