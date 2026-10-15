// Messenger plugin — agent-facing `update_agent_card` tool.
//
// Lets the agent update its own Agent Card (name + description).

import { Type } from "typebox";
import type { AgentTool } from "@tianshu-ai/plugin-sdk";
import type { Db, Contact } from "./schema.js";
import { getAgentCard, setAgentCard, listContacts } from "./schema.js";
import type { SendAdapter } from "./tool.js";

export function buildUpdateAgentCardTool(
  db: Db,
  broadcast: (event: string, data: unknown) => void,
  getA2aAdapter: () => SendAdapter | undefined,
): AgentTool {
  return {
    schema: {
      name: "update_agent_card",
      description:
        "Read or update this agent's Agent Card — the public profile other agents see via A2A.\n" +
        "- update_agent_card({action: \"read\"}) — returns the current card\n" +
        "- update_agent_card({name: \"...\", description: \"...\"}) — updates the card\n" +
        "The description should focus on BUSINESS context: who your user is, what business problems you help them solve, what domain you specialize in. Don't list tool names — describe from a business perspective.",
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

      // Push card update to all A2A contacts
      const a2a = getA2aAdapter();
      if (a2a) {
        const peers = listContacts(db).filter((c: Contact) => c.type === "a2a" && c.enabled);
        const payload = JSON.stringify({ _a2a_card_update: true, card });
        for (const peer of peers) {
          try { await a2a.send(peer, payload); } catch { /* best-effort */ }
        }
      }

      return `Agent card updated and pushed to ${listContacts(db).filter((c: Contact) => c.type === "a2a" && c.enabled).length} A2A peer(s).\n${JSON.stringify(card, null, 2)}`;
    },
  };
}
