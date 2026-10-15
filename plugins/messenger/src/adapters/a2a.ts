// A2A (agent-to-agent) messenger adapter.
//
// Uses @a2a-js/sdk for request construction and response parsing.
// Transport is raw fetch (SDK Client requires agent card discovery).

import type { Contact } from "../schema.js";
import type { SendAdapter } from "../tool.js";
import { appendFileSync } from "node:fs";
import { Task, Message } from "@a2a-js/sdk";

export interface A2aAdapterDeps {
  log: Record<string, any>;
  agentName?: string;
}

/** Extract all text from SDK-parsed Parts */
function extractText(parts: Array<{ content?: { $case: string; value?: unknown } }> | undefined): string {
  if (!parts) return "";
  return parts
    .filter((p) => p.content?.$case === "text" && typeof p.content.value === "string")
    .map((p) => p.content!.value as string)
    .join("\n");
}

export class A2aMessengerAdapter implements SendAdapter {
  constructor(private deps: A2aAdapterDeps) {}

  async send(
    contact: Contact,
    text: string,
  ): Promise<{ delivered: boolean; error?: string; replyText?: string; handshakeResponse?: Record<string, unknown> }> {
    const cfg = contact.config as { endpoint?: string; apiKey?: string };
    if (!cfg.endpoint) {
      return { delivered: false, error: "missing endpoint in contact config" };
    }

    const senderName = this.deps.agentName || "Remote Agent";

    // Build JSON-RPC request (role as lowercase string per A2A spec)
    const body = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/send",
      params: {
        message: {
          role: "user",
          messageId: crypto.randomUUID(),
          parts: [{ text }],
          metadata: { senderName },
        },
      },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (cfg.apiKey) {
      headers.Authorization = `Bearer ${cfg.apiKey}`;
    }

    try {
      appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ▶ SEND → ${cfg.endpoint}  text: ${text.slice(0, 100)}\n`);

      const resp = await fetch(cfg.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });

      const responseText = await resp.text().catch(() => "");
      appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ◀ RESP ← ${cfg.endpoint} HTTP ${resp.status}  ${responseText.slice(0, 300)}\n`);

      if (!resp.ok) {
        return { delivered: false, error: `HTTP ${resp.status}: ${responseText.slice(0, 200)}` };
      }

      try {
        const json = JSON.parse(responseText);
        if (json.error) {
          return { delivered: false, error: json.error.message || JSON.stringify(json.error) };
        }

        const r = json.result;
        if (!r) return { delivered: true };

        // Handshake metadata
        if (r.metadata?.communicationToken && typeof r.metadata.communicationToken === "string") {
          return { delivered: true, handshakeResponse: r.metadata };
        }

        let replyText: string | undefined;

        // Parse as Task (has status/artifacts)
        if (r.status || r.artifacts) {
          const task = Task.fromJSON(r);
          for (const art of task.artifacts ?? []) {
            const t = extractText(art.parts as any);
            if (t) { replyText = t; break; }
          }
          if (!replyText && task.status?.message) {
            replyText = extractText(task.status.message.parts as any);
          }
        }
        // Parse as Message (direct parts)
        else if (r.parts) {
          const msg = Message.fromJSON(r);
          replyText = extractText(msg.parts as any);
        }

        if (replyText === "Message received") replyText = undefined;
        return { delivered: true, ...(replyText ? { replyText } : {}) };
      } catch { /* not valid JSON-RPC */ }

      return { delivered: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ✖ ERROR → ${cfg.endpoint}: ${msg}\n`);
      return { delivered: false, error: msg };
    }
  }
}
