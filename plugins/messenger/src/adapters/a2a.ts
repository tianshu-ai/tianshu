// A2A (agent-to-agent) messenger adapter.
//
// Async-first: sends message/send, if remote returns "working"/"submitted",
// polls tasks/get in the background and delivers the reply via onReply callback.

import type { Contact } from "../schema.js";
import type { SendAdapter } from "../tool.js";
import { appendFileSync } from "node:fs";
import { Task, Message } from "@a2a-js/sdk";

export interface A2aAdapterDeps {
  log: Record<string, any>;
  agentName?: string;
  /** Called when an async reply arrives (background poll completed) */
  onReply?: (contact: Contact, text: string) => void;
}

/** Extract all text from SDK-parsed Parts */
function extractText(parts: Array<{ content?: { $case: string; value?: unknown } }> | undefined): string {
  if (!parts) return "";
  return parts
    .filter((p) => p.content?.$case === "text" && typeof p.content.value === "string")
    .map((p) => p.content!.value as string)
    .join("\n");
}

/** Extract reply text from a parsed Task */
function extractTaskReply(task: ReturnType<typeof Task.fromJSON>): string | undefined {
  // Check artifacts first (preferred reply location, e.g. PSS agent)
  for (const art of task.artifacts ?? []) {
    const t = extractText(art.parts as any);
    if (t) return t;
  }
  // Fallback to status message
  if (task.status?.message) {
    return extractText(task.status.message.parts as any) || undefined;
  }
  return undefined;
}

const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "rejected", "input_required", "auth_required"]);
const POLL_INTERVAL = 2000;
const MAX_POLL_TIME = 5 * 60 * 1000; // 5 minutes

export class A2aMessengerAdapter implements SendAdapter {
  constructor(private deps: A2aAdapterDeps) {}

  private jsonRpc(endpoint: string, method: string, params: Record<string, unknown>, apiKey?: string) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    return fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params,
      }),
      signal: AbortSignal.timeout(30000),
    });
  }

  private async pollTask(endpoint: string, taskId: string, apiKey: string | undefined, contact: Contact) {
    const start = Date.now();
    appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ⏳ POLL START taskId=${taskId} → ${endpoint}\n`);

    while (Date.now() - start < MAX_POLL_TIME) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      try {
        const resp = await this.jsonRpc(endpoint, "tasks/get", { id: taskId }, apiKey);
        const text = await resp.text();
        const json = JSON.parse(text);
        const r = json.result;
        if (!r) continue;

        const stateStr = (r.status?.state ?? "").toLowerCase().replace(/^task_state_/, "");
        appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ⏳ POLL state=${stateStr} taskId=${taskId}\n`);

        if (!TERMINAL_STATES.has(stateStr)) continue;

        if (stateStr === "completed") {
          const task = Task.fromJSON(r);
          let replyText = extractTaskReply(task);
          if (replyText && replyText !== "Message received") {
            appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ✅ POLL REPLY taskId=${taskId}: ${replyText.slice(0, 100)}\n`);
            this.deps.onReply?.(contact, replyText);
          }
        } else {
          appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ⚠ POLL TERMINAL state=${stateStr} taskId=${taskId}\n`);
        }
        return;
      } catch (err) {
        appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ⚠ POLL ERROR taskId=${taskId}: ${err}\n`);
      }
    }
    appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ⏰ POLL TIMEOUT taskId=${taskId}\n`);
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

    try {
      appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ▶ SEND → ${cfg.endpoint}  text: ${text.slice(0, 100)}\n`);

      const resp = await this.jsonRpc(cfg.endpoint, "message/send", {
        message: {
          role: "user",
          messageId: crypto.randomUUID(),
          parts: [{ text }],
          metadata: { senderName },
        },
      }, cfg.apiKey);

      const responseText = await resp.text().catch(() => "");
      appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ◀ RESP ← HTTP ${resp.status}  ${responseText.slice(0, 300)}\n`);

      if (!resp.ok) {
        return { delivered: false, error: `HTTP ${resp.status}: ${responseText.slice(0, 200)}` };
      }

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

      // Check task state
      const stateStr = (r.status?.state ?? "").toLowerCase().replace(/^task_state_/, "");

      if (stateStr === "completed") {
        // Synchronous reply — extract immediately
        const task = Task.fromJSON(r);
        let replyText = extractTaskReply(task);
        if (replyText === "Message received") replyText = undefined;
        return { delivered: true, ...(replyText ? { replyText } : {}) };
      }

      if (stateStr === "working" || stateStr === "submitted") {
        // Async — poll in background, return immediately
        const taskId = r.id;
        if (taskId) {
          this.pollTask(cfg.endpoint, taskId, cfg.apiKey, contact).catch(() => {});
        }
        return { delivered: true };
      }

      // Message response (direct parts, no task wrapper)
      if (r.parts) {
        const msg = Message.fromJSON(r);
        const replyText = extractText(msg.parts as any) || undefined;
        if (replyText && replyText !== "Message received") {
          return { delivered: true, replyText };
        }
        return { delivered: true };
      }

      return { delivered: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ✖ ERROR → ${cfg.endpoint}: ${msg}\n`);
      return { delivered: false, error: msg };
    }
  }
}
