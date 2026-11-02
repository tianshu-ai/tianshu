// A2A (agent-to-agent) messenger adapter.
//
// Async-first: uses message/stream (SSE) for non-blocking sends.
// Falls back to message/send if streaming unavailable.
// Reply delivered via onReply callback → notifyA2a.

import type { Contact } from "../schema.js";
import type { SendAdapter } from "../tool.js";
import { Task, Message } from "@a2a-js/sdk";
import fs from "node:fs";
import path from "node:path";

export interface A2aAdapterDeps {
  log: Record<string, any>;
  agentName?: string;
  onReply?: (contact: Contact, text: string) => void;
  /** Check if the relay WS connection is currently alive. */
  isRelayConnected?: () => boolean;
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

  private buildBody(text: string, senderName: string, fileParts?: Array<{ kind: "file"; file: { bytes: string; mimeType: string; name?: string } }>) {
    const parts: Array<Record<string, unknown>> = [];
    if (text) parts.push({ text });
    if (fileParts) parts.push(...fileParts);
    return {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/send",
      params: {
        message: {
          role: "user",
          messageId: crypto.randomUUID(),
          parts,
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

    const headers = this.buildHeaders(cfg.apiKey);
    headers.Accept = "text/event-stream";
    const body = JSON.stringify(this.buildBody(text, senderName));

    // Retry with exponential backoff on transient failures
    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [2000, 5000, 10000]; // ms
    let lastError = "";

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS[attempt - 1] ?? 10000;
        dbg(`🔄 retry ${attempt}/${MAX_RETRIES} in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        const resp = await fetch(cfg.endpoint, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(30_000),
        });

        // Check for relay-level errors (agent_offline, etc.)
        const ct = resp.headers.get("content-type") || "";
        if (!resp.ok) {
          const errBody = await resp.text().catch(() => "");
          dbg(`◀ HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
          try {
            const errJson = JSON.parse(errBody);
            lastError = errJson.message || errJson.error || `HTTP ${resp.status}`;
            // agent_offline is retryable (WS may reconnect)
            if (errJson.error === "agent_offline") continue;
          } catch { lastError = `HTTP ${resp.status}: ${errBody.slice(0, 200)}`; }
          // Non-retryable HTTP errors (4xx except agent_offline)
          if (resp.status >= 400 && resp.status < 500) break;
          // 5xx: retry
          continue;
        }

        // Success — process response in background for async replies
        if (ct.includes("text/event-stream") && resp.body) {
          dbg(`📡 SSE STREAM started`);
          // Process stream in background — don't block the tool
          this.processStream(resp.body.getReader(), contact).catch(() => {});
        } else {
          // Check for JSON-RPC error in response body
          const respText = await resp.text().catch(() => "");
          dbg(`◀ RESP ← HTTP ${resp.status}  ${respText.slice(0, 300)}`);
          try {
            const json = JSON.parse(respText);
            if (json.error) {
              const errMsg = typeof json.error === "string" ? json.error : json.error.message || json.message || JSON.stringify(json.error);
              lastError = errMsg;
              if (errMsg.includes("agent_offline") || errMsg.includes("not connected")) continue;
              break; // non-retryable error
            }
            // Process reply in background
            const r = json.result;
            if (r) {
              const reply = extractRawReply(r);
              if (isUsefulReply(reply)) {
                dbg(`✅ SYNC REPLY: ${reply.slice(0, 100)}`);
                this.deps.onReply?.(contact, reply);
              }
            }
          } catch { /* not JSON, treat as success */ }
        }

        return { delivered: true };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        dbg(`✖ attempt ${attempt} ERROR → ${cfg.endpoint}: ${lastError}`);
        // Network errors are retryable
        continue;
      }
    }

    // All retries exhausted
    dbg(`✖ FAILED after ${MAX_RETRIES} retries: ${lastError}`);
    return { delivered: false, error: `a2a delivery failed: ${lastError}` };
  }

  async sendFile(
    contact: Contact,
    filePath: string,
    text?: string,
  ): Promise<{ delivered: boolean; error?: string }> {
    const cfg = contact.config as { endpoint?: string; apiKey?: string };
    if (!cfg.endpoint) {
      return { delivered: false, error: "missing endpoint in contact config" };
    }

    try {
      const data = fs.readFileSync(filePath);
      const base64 = data.toString("base64");
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap: Record<string, string> = {
        ".pdf": "application/pdf",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xls": "application/vnd.ms-excel",
        ".csv": "text/csv",
        ".doc": "application/msword",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".txt": "text/plain",
        ".json": "application/json",
        ".zip": "application/zip",
      };
      const mimeType = mimeMap[ext] || "application/octet-stream";
      const fileName = path.basename(filePath);

      const senderName = this.deps.agentName || "Remote Agent";
      const filePart = { kind: "file" as const, file: { bytes: base64, mimeType, name: fileName } };
      const body = JSON.stringify(this.buildBody(text || "", senderName, [filePart]));
      const headers = this.buildHeaders(cfg.apiKey);

      const resp = await fetch(cfg.endpoint, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(60_000),
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        return { delivered: false, error: `HTTP ${resp.status}: ${errBody.slice(0, 200)}` };
      }

      return { delivered: true };
    } catch (err) {
      return { delivered: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
