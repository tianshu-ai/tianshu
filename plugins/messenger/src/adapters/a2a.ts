// A2A (agent-to-agent) messenger adapter.
//
// Sends messages to a remote agent via standard A2A JSON-RPC (message/send).
// The contact config stores { endpoint, apiKey } — the remote's
// receive URL and bearer token.

import type { Contact } from "../schema.js";
import type { SendAdapter } from "../tool.js";
import { appendFileSync } from "node:fs";

export interface A2aAdapterDeps {
  log: Record<string, any>;
  /** Display name of this agent instance, sent as `sender`. */
  agentName?: string;
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

    // Build standard A2A JSON-RPC request
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
      appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ▶ SEND(JSON-RPC) → ${cfg.endpoint}\n  sender: ${senderName}\n  text: ${text.slice(0, 100)}\n\n`);

      const resp = await fetch(cfg.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });

      const responseText = await resp.text().catch(() => "");
      appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ◀ SEND RESPONSE ← ${cfg.endpoint} HTTP ${resp.status}\n  response: ${responseText.slice(0, 500)}\n\n`);

      if (!resp.ok) {
        return { delivered: false, error: `HTTP ${resp.status}: ${responseText.slice(0, 200)}` };
      }

      // Parse JSON-RPC response and extract reply
      let replyText: string | undefined;
      try {
        const result = JSON.parse(responseText);
        if (result.error) {
          return { delivered: false, error: result.error.message || JSON.stringify(result.error) };
        }

        const r = result?.result;
        if (r) {
          // Task response — check artifacts first (e.g. PSS agent)
          if (Array.isArray(r.artifacts)) {
            for (const art of r.artifacts) {
              if (Array.isArray(art?.parts)) {
                const texts = art.parts.filter((p: any) => p.text).map((p: any) => p.text as string);
                if (texts.length) { replyText = texts.join("\n"); break; }
              }
            }
          }
          // Then status.message.parts
          if (!replyText && Array.isArray(r.status?.message?.parts)) {
            const texts = r.status.message.parts.filter((p: any) => p.text).map((p: any) => p.text as string);
            if (texts.length) replyText = texts.join("\n");
          }
          // Message response — parts directly
          if (!replyText && Array.isArray(r.parts)) {
            const texts = r.parts.filter((p: any) => p.text).map((p: any) => p.text as string);
            if (texts.length) replyText = texts.join("\n");
          }
          // Handshake metadata
          if (r.metadata?.communicationToken && typeof r.metadata.communicationToken === "string") {
            return { delivered: true, handshakeResponse: r.metadata };
          }
        }
      } catch { /* not JSON */ }

      // Filter generic ack
      if (replyText === "Message received") replyText = undefined;

      return { delivered: true, ...(replyText ? { replyText } : {}) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ✖ SEND ERROR → ${cfg.endpoint}: ${msg}\n\n`);
      return { delivered: false, error: msg };
    }
  }
}
