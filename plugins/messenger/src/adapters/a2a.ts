// A2A (agent-to-agent) messenger adapter.
//
// Async-first: uses message/stream (SSE) for non-blocking sends.
// Falls back to message/send if streaming unavailable.
// Reply delivered via onReply callback → notifyA2a.

import type { Contact } from "../schema.js";
import type { SendAdapter } from "../tool.js";
import { Task, Message } from "@a2a-js/sdk";

export interface A2aAdapterDeps {
  log: Record<string, any>;
  agentName?: string;
  onReply?: (contact: Contact, text: string) => void;
}

function extractText(parts: Array<{ content?: { $case: string; value?: unknown } }> | undefined): string {
  if (!parts) return "";
  return parts
    .filter((p) => p.content?.$case === "text" && typeof p.content.value === "string")
    .map((p) => p.content!.value as string)
    .join("\n");
}

function extractTaskReply(task: ReturnType<typeof Task.fromJSON>): string | undefined {
  for (const art of task.artifacts ?? []) {
    const t = extractText(art.parts as any);
    if (t) return t;
  }
  if (task.status?.message) {
    return extractText(task.status.message.parts as any) || undefined;
  }
  return undefined;
}

/** Extract reply from raw JSON (before SDK parsing, handles both formats) */
function extractRawReply(r: any): string | undefined {
  // artifacts[].parts[].text (raw JSON format)
  if (Array.isArray(r?.artifacts)) {
    for (const art of r.artifacts) {
      if (Array.isArray(art?.parts)) {
        const texts = art.parts.filter((p: any) => p.text).map((p: any) => p.text);
        if (texts.length) return texts.join("\n");
      }
    }
  }
  // status.message.parts[].text
  if (Array.isArray(r?.status?.message?.parts)) {
    const texts = r.status.message.parts.filter((p: any) => p.text).map((p: any) => p.text);
    if (texts.length) return texts.join("\n");
  }
  // Try SDK parsing
  try {
    if (r?.status || r?.artifacts) {
      const task = Task.fromJSON(r);
      return extractTaskReply(task);
    }
    if (r?.parts) {
      const msg = Message.fromJSON(r);
      return extractText(msg.parts as any) || undefined;
    }
  } catch { /* ignore */ }
  return undefined;
}

function isUsefulReply(text: string | undefined): text is string {
  return !!text && text !== "Message received";
}

function dbg(msg: string) {
}

export class A2aMessengerAdapter implements SendAdapter {
  constructor(private deps: A2aAdapterDeps) {}

  private buildBody(text: string, senderName: string) {
    return {
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
  }

  private buildHeaders(apiKey?: string) {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) h.Authorization = "Bearer " + apiKey;
    return h;
  }

  /** Process SSE stream in background */
  private async processStream(reader: ReadableStreamDefaultReader<Uint8Array>, contact: Contact) {
    const decoder = new TextDecoder();
    let buffer = "";
    let lastReply: string | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          const lines = part.split("\n");
          let eventType = "";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event:")) eventType = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;

          try {
            const json = JSON.parse(data);
            dbg(`⚡ SSE event=${eventType || "message"} state=${json.status?.state ?? "?"}`);

            const state = (json.status?.state ?? "").toLowerCase();
            if (state === "completed" || state === "task_state_completed") {
              const reply = extractRawReply(json);
              if (isUsefulReply(reply)) lastReply = reply;
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch (err) {
      dbg(`⚠ SSE ERROR: ${err}`);
    }

    if (lastReply) {
      dbg(`✅ SSE REPLY: ${lastReply.slice(0, 100)}`);
      this.deps.onReply?.(contact, lastReply);
    }
  }

  /** Fallback: process JSON-RPC response in background */
  private async processJsonResponse(resp: Response, contact: Contact) {
    const text = await resp.text().catch(() => "");
    dbg(`◀ RESP ← HTTP ${resp.status}  ${text.slice(0, 300)}`);
    if (!resp.ok) return;

    try {
      const json = JSON.parse(text);
      if (json.error) return;
      const r = json.result;
      if (!r) return;
      if (r.metadata?.communicationToken) return; // handshake

      const reply = extractRawReply(r);
      if (isUsefulReply(reply)) {
        dbg(`✅ SYNC REPLY: ${reply.slice(0, 100)}`);
        this.deps.onReply?.(contact, reply);
      }
    } catch { /* not JSON */ }
  }

  async send(
    contact: Contact,
    text: string,
  ): Promise<{ delivered: boolean; error?: string; replyText?: string; handshakeResponse?: Record<string, unknown> }> {
    const cfg = contact.config as { endpoint?: string; apiKey?: string };
    if (!cfg.endpoint) {
      return { delivered: false, error: "missing endpoint in contact config" };
    }

    const senderName = this.deps.agentName || "Remote Agent";
    dbg(`▶ SEND → ${cfg.endpoint}  text: ${text.slice(0, 100)}`);

    // Fire and forget — entire HTTP round-trip runs in background
    const headers = this.buildHeaders(cfg.apiKey);
    headers.Accept = "text/event-stream";
    const body = JSON.stringify(this.buildBody(text, senderName));

    fetch(cfg.endpoint, { method: "POST", headers, body })
      .then(async (resp) => {
        const ct = resp.headers.get("content-type") || "";
        if (ct.includes("text/event-stream") && resp.body) {
          dbg(`📡 SSE STREAM started`);
          await this.processStream(resp.body.getReader(), contact);
        } else {
          await this.processJsonResponse(resp, contact);
        }
      })
      .catch((e) => dbg(`✖ ERROR → ${cfg.endpoint}: ${e}`));

    return { delivered: true };
  }
}
