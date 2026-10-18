// Messenger plugin — agent-facing `update_agent_card` tool.
//
// Lets the agent update its own Agent Card (name + description).

import { Type } from "typebox";
import type { AgentTool } from "@tianshu-ai/plugin-sdk";
import type { Db, Contact } from "./schema.js";
import { getAgentCard, setAgentCard, listContacts } from "./schema.js";
import type { SendAdapter } from "./tool.js";
import type { AgentToolContext } from "@tianshu-ai/plugin-sdk";

export function buildUpdateAgentCardTool(
  db: Db,
  broadcast: (event: string, data: unknown) => void,
  getA2aAdapter: () => SendAdapter | undefined,
  getRelayClient?: () => { isConnected: boolean; updateCard(card: Record<string, unknown>): void } | null,
): AgentTool {
  return {
    schema: {
      name: "update_agent_card",
      description:
        "Read or update this agent's Agent Card (standard A2A v1.0 format) — the public profile other agents see.\n" +
        "- update_agent_card({action: \"read\"}) — returns the current card\n" +
        "- update_agent_card({name, description, provider, version, skills}) — updates the card\n" +
        "\nFields:\n" +
        "- name: A role-specific name reflecting your relationship with the user (e.g. 'Alex's Tech Advisor')\n" +
        "- description: Business-focused intro for other agents — who your user is, what problems you solve, your domain expertise\n" +
        "- provider: Organization name (user's company or personal name)\n" +
        "- version: Semantic version like '1.0.0'\n" +
        "- skills: Array of {id, name, description} — describe capabilities from a business perspective, not tool names\n" +
        "\nExample skills: [{id: 'code-review', name: 'Code Review', description: 'Review PRs, find bugs, suggest improvements'}]",
      parameters: Type.Object({
        action: Type.Optional(Type.String({ description: "read | update (default: update)" })),
        name: Type.Optional(Type.String({ description: "Agent display name" })),
        description: Type.Optional(Type.String({ description: "Business-focused self-introduction for other agents" })),
        provider: Type.Optional(Type.String({ description: "Provider organization name" })),
        version: Type.Optional(Type.String({ description: "Version string, e.g. 1.0.0" })),
        skills: Type.Optional(Type.Array(Type.Object({
          id: Type.String({ description: "Unique skill id" }),
          name: Type.String({ description: "Skill display name" }),
          description: Type.String({ description: "What this skill does (business perspective)" }),
        }), { description: "List of agent skills/capabilities" })),
      }),
    },
    execute: async (raw, toolCtx?: AgentToolContext) => {
      const p = raw as Record<string, unknown>;
      const action = String(p.action ?? "update");
      const userId = toolCtx?.userId ?? "";

      if (action === "read") {
        const card = getAgentCard(db, userId);
        return JSON.stringify(card, null, 2);
      }

      // Update
      const name = typeof p.name === "string" ? p.name : undefined;
      const description = typeof p.description === "string" ? p.description : undefined;
      const provider = typeof p.provider === "string" ? p.provider : undefined;
      const version = typeof p.version === "string" ? p.version : undefined;
      const skills = Array.isArray(p.skills) ? p.skills as Array<{ id: string; name: string; description: string }> : undefined;

      if (!name && !description && !provider && !version && !skills) {
        return "Nothing to update. Provide at least one field: name, description, provider, version, or skills.";
      }

      const card = setAgentCard(db, userId, { name, description, provider, version, skills });
      broadcast("messenger_changed", {});

      // Push card update to all A2A contacts
      const a2a = getA2aAdapter();
      if (a2a) {
        const peers = listContacts(db, userId).filter((c: Contact) => c.type === "a2a" && c.enabled);
        const payload = JSON.stringify({ _a2a_card_update: true, card });
        for (const peer of peers) {
          try { await a2a.send(peer, payload); } catch { /* best-effort */ }
        }
      }

      // Sync to relay server
      const relay = getRelayClient?.();
      if (relay?.isConnected) {
        relay.updateCard({
          name: card.name || "",
          description: card.description || "",
          skills: card.skills || [],
          version: card.version || "1.0.0",
          provider: card.provider || "",
        }, userId);
      }

      return `Agent card updated and pushed to ${listContacts(db, userId).filter((c: Contact) => c.type === "a2a" && c.enabled).length} A2A peer(s).\n${JSON.stringify(card, null, 2)}`;
    },
  };
}
