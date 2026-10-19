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
  /** Send a file (image/video/document) to the contact. Optional —
   *  not all adapters support file sending. */
  sendFile?(contact: Contact, filePath: string): Promise<{ delivered: boolean; error?: string }>;
}

export interface ToolDeps {
  db: Db;
  adapters: Map<string, SendAdapter>;
  broadcast?: (event: string, data: unknown) => void;
  notifyA2a?: (sender: string, text: string, userId?: string) => void;
  /** TTS synthesis: text → audio buffer (mp3). Uses tenant's configured TTS. */
  tts?: (text: string) => Promise<Buffer>;
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
        file: Type.Optional(Type.String({ description: "Workspace-relative file path to send as attachment (image/video/document). Use workspace:// URI or relative path like uploads/photo.jpg" })),
        voice: Type.Optional(Type.String({ description: "Text to convert to speech and send as a voice file. Uses edge-tts for synthesis." })),
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
        const file = p.file as string | undefined;
        const voice = p.voice as string | undefined;
        if (!name) return { ok: false, text: "Missing 'to' — specify the contact name." };
        if (!text && !file && !voice) return { ok: false, text: "Missing 'message', 'file', or 'voice' — what should I send?" };

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
          // TTS voice: convert text to audio, save to workspace, send as file
          let voiceFile: string | undefined;
          if (voice) {
            if (!adapter.sendFile) {
              return { ok: false, text: `Contact type "${contact.type}" does not support file sending.` };
            }
            try {
              if (!deps.tts) {
                return { ok: false, text: "TTS not configured for this tenant." };
              }
              const audioBytes = await deps.tts(voice);
              const nodePath = await import("node:path");
              const nodeFs = await import("node:fs/promises");
              const voiceDir = nodePath.default.join(toolCtx?.userHomeDir ?? ".", "uploads", "voice");
              await nodeFs.default.mkdir(voiceDir, { recursive: true });
              const filename = `tts_${Date.now()}.wav`;
              voiceFile = nodePath.default.join(voiceDir, filename);
              await nodeFs.default.writeFile(voiceFile, audioBytes);
            } catch (err) {
              return { ok: false, text: `TTS failed: ${err instanceof Error ? err.message : String(err)}` };
            }
            const fileResult = await adapter.sendFile(contact, voiceFile);
            if (!fileResult.delivered) {
              return { ok: false, text: `Failed to send voice: ${fileResult.error ?? "unknown error"}` };
            }
            logMessage(deps.db, { contactId: contact.id, text: `[voice] ${voice}`, status: "sent" });
            deps.broadcast?.("messenger_changed", {});
          }
          // Send file if provided
          if (file) {
            if (!adapter.sendFile) {
              return { ok: false, text: `Contact type "${contact.type}" does not support file sending.` };
            }
            // Resolve workspace path to absolute path
            let filePath = file.replace(/^workspace:\/\/\/?/, "");
            const nodePath = await import("node:path");
            filePath = nodePath.default.resolve(toolCtx?.userHomeDir ?? ".", filePath);
            const fileResult = await adapter.sendFile(contact, filePath);
            if (!fileResult.delivered) {
              return { ok: false, text: `Failed to send file: ${fileResult.error ?? "unknown error"}` };
            }
            logMessage(deps.db, { contactId: contact.id, text: `[file] ${file}`, status: "sent" });
            deps.broadcast?.("messenger_changed", {});
          }
          // Send text if provided
          if (text) {
            const result = await adapter.send(contact, text);
            if (result.delivered) {
              logMessage(deps.db, { contactId: contact.id, text, status: "sent" });
              deps.broadcast?.("messenger_changed", {});
            } else {
              logMessage(deps.db, { contactId: contact.id, text, status: "failed", error: result.error });
              deps.broadcast?.("messenger_changed", {});
              return { ok: false, text: `Failed to deliver to ${contact.name}: ${result.error ?? "unknown error"}` };
            }
          }
          const parts: string[] = [];
          if (voice) parts.push(`voice`);
          if (file) parts.push(`file`);
          if (text) parts.push(`message`);
          const meta: Record<string, unknown> = { ok: true };
          if (voiceFile) {
            const np = await import("node:path");
            meta.voiceFile = `workspace:///${np.default.relative(toolCtx?.userHomeDir ?? ".", voiceFile)}`;
          }
          return { ...meta, text: `✅ ${parts.join(" + ")} sent to ${contact.name} via ${contact.type}.` };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logMessage(deps.db, { contactId: contact.id, text: text || `[file] ${file}`, status: "failed", error: errMsg });
          deps.broadcast?.("messenger_changed", {});
          return { ok: false, text: `Send failed: ${errMsg}` };
        }
      }

      return { ok: false, text: `Unknown action "${action}". Use "send" or "list".` };
    },
  };
}
