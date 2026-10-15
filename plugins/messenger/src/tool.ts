// Messenger plugin — the agent-facing `send_message` tool.
//
// Looks up a contact by name, dispatches through the appropriate
// adapter (wechat → channelHub, ws → connection pool), and returns
// delivery status.

import { Type } from "typebox";
import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";
import type { Db, Contact } from "./schema.js";
import { getContactByName, listContacts, logMessage } from "./schema.js";

export interface SendAdapter {
  /** Send a text message to the contact. Resolves with a delivery
   *  receipt or rejects on failure. */
  send(contact: Contact, text: string): Promise<{ delivered: boolean; error?: string; replyText?: string; handshakeResponse?: Record<string, unknown> }>;
}

export interface ToolDeps {
  db: Db;
  adapters: Map<string, SendAdapter>;
  broadcast?: (event: string, data: unknown) => void;
  notifyA2a?: (sender: string, text: string, userId?: string) => void;
}

const DESCRIPTION = `Send a message to an external contact (WeChat friend, WebSocket-connected system, etc.).

Parameters:
- to: contact name (as configured in Messenger settings). Use list_contacts to see available names.
- message: text to send.
- action: "send" (default) sends a message. "list" lists all configured contacts.

The contact's type determines the transport:
- wechat: delivered via WeChat (requires wechat plugin active)
- ws: delivered via WebSocket to the connected endpoint

Examples:
  {"action":"send","to":"老王","message":"明天开会改到3点"}
  {"action":"list"}`;

export function buildSendMessageTool(deps: ToolDeps): AgentTool {
  return {
    schema: {
      name: "send_message",
      description: DESCRIPTION,
      parameters: Type.Object({
        action: Type.Optional(Type.String({ description: "send | list (default: send)" })),
        to: Type.Optional(Type.String({ description: "Contact name" })),
        message: Type.Optional(Type.String({ description: "Message text" })),
      }),
    },
    execute: async (raw, toolCtx) => {
      const p = raw as Record<string, unknown>;
      const action = String(p.action ?? "send");
      const userId = toolCtx?.userId ?? "";

      if (action === "list") {
        const contacts = listContacts(deps.db, userId);
        if (contacts.length === 0) {
          return { ok: true, text: "No contacts configured. Add contacts in Messenger settings." };
        }
        const lines = contacts.map((c) => {
          const status = c.enabled ? "✅" : "⏸️";
          const peerCard = (c.config as any)?.peerCard as { name?: string; description?: string } | undefined;
          let line = `${status} ${c.name} (${c.type})${c.waitReply ? " [wait reply]" : ""}`;
          if (peerCard?.description) {
            line += `\n   📋 ${peerCard.name || c.name}: ${peerCard.description}`;
          }
          return line;
        });
        return { ok: true, text: lines.join("\n"), data: contacts };
      }

      if (action === "send") {
        const name = p.to as string | undefined;
        const text = p.message as string | undefined;
        if (!name) return { ok: false, text: "Missing 'to' — specify the contact name." };
        if (!text) return { ok: false, text: "Missing 'message' — what should I send?" };

        const contact = getContactByName(deps.db, name, userId);
        if (!contact) {
          const all = listContacts(deps.db, userId);
          const names = all.map((c) => `"${c.name}"`).join(", ");
          return {
            ok: false,
            text: `Contact "${name}" not found. Available: ${names || "none (add in Messenger settings)"}`,
          };
        }
        if (!contact.enabled) {
          return { ok: false, text: `Contact "${name}" is disabled.` };
        }

        const adapter = deps.adapters.get(contact.type);
        if (!adapter) {
          return { ok: false, text: `No adapter for contact type "${contact.type}". Is the required plugin active?` };
        }

        try {
          const result = await adapter.send(contact, text);
          if (result.delivered) {
            logMessage(deps.db, { contactId: contact.id, text, status: "sent" });
            // If the A2A response included a synchronous reply, push it as incoming message
            if (result.replyText) {
              logMessage(deps.db, { contactId: contact.id, text: result.replyText, status: "received", direction: "inbound" });
              deps.notifyA2a?.(contact.name, result.replyText, userId);
            }
            deps.broadcast?.("messenger_changed", {});
            return { ok: true, text: `✅ Message sent to ${contact.name} via ${contact.type}.` };
          }
          logMessage(deps.db, { contactId: contact.id, text, status: "failed", error: result.error });
          deps.broadcast?.("messenger_changed", {});
          return { ok: false, text: `Failed to deliver to ${contact.name}: ${result.error ?? "unknown error"}` };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logMessage(deps.db, { contactId: contact.id, text, status: "failed", error: errMsg });
          deps.broadcast?.("messenger_changed", {});
          return { ok: false, text: `Send failed: ${errMsg}` };
        }
      }

      return { ok: false, text: `Unknown action "${action}". Use "send" or "list".` };
    },
  };
}
