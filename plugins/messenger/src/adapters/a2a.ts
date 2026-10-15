// A2A (agent-to-agent) messenger adapter.
//
// Fire-and-forget: sends message/send, returns immediately.
// Response handling + async polling runs in background.
// Reply delivered via onReply callback → notifyA2a.

import type { Contact } from "../schema.js";
import type { SendAdapter } from "../tool.js";
import { appendFileSync } from "node:fs";
import { Task, Message } from "@a2a-js/sdk";

export interface A2aAdapterDeps {
  log: Record<string, any>;
  agentName?: string;
  /** Called when a reply arrives (sync or async) */
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

const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "rejected", "input_required", "auth_required"]);
const POLL_INTERVAL = 2000;
const MAX_POLL_TIME = 5 * 60 * 1000;

export class A2aMessengerAdapter implements SendAdapter {
  constructor(private deps: A2aAdapterDeps) {}

  private async jsonRpc(endpoint: string, method: string, params: Record<string, unknown>, apiKey?: string) {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (apiKey) headers.Authorization = "Bearer " + apiKey;
    return fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
      signal: AbortSignal.timeout(30000),
    });
  }

  private async pollTask(endpoint: string, taskId: string, apiKey: string | undefined, contact: Contact) {
    const start = Date.now();
    appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ⏳ POLL START taskId=${taskId}\n`);
    while (Date.now() - start < MAX_POLL_TIME) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      try {
        const resp = await this.jsonRpc(endpoint, "tasks/get", { id: taskId }, apiKey);
        const text = await resp.text();
        const json = JSON.parse(text);
        const r = json.result;
        if (!r) continue;
        const state = (r.status?.state ?? "").toLowerCase().replace(/^task_state_/, "");
        appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ⏳ POLL state=${state}\n`);
        if (!TERMINAL_STATES.has(state)) continue;
        if (state === "completed") {
          const task = Task.fromJSON(r);
          const reply = extractTaskReply(task);
          if (reply && reply !== "Message received") this.deps.onReply?.(contact, reply);
        }
        return;
      } catch (err) {
        appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ⚠ POLL ERROR: ${err}\n`);
      }
    }
    appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ⏰ POLL TIMEOUT taskId=${taskId}\n`);
  }

  /** Handle HTTP response in background — extract reply or start polling */
  private async handleResponse(endpoint: string, apiKey: string | undefined, contact: Contact, resp: Response) {
    const responseText = await resp.text().catch(() => "");
    appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ◀ RESP ← HTTP ${resp.status}  ${responseText.slice(0, 300)}\n`);

    if (!resp.ok) return;

    let json: any;
    try { json = JSON.parse(responseText); } catch { return; }
    if (json.error) return;

    const r = json.result;
    if (!r) return;

    // Handshake — skip reply handling
    if (r.metadata?.communicationToken) return;

    const state = (r.status?.state ?? "").toLowerCase().replace(/^task_state_/, "");

    if (state === "completed") {
      const task = Task.fromJSON(r);
      const reply = extractTaskReply(task);
      if (reply && reply !== "Message received") this.deps.onReply?.(contact, reply);
      return;
    }

    if ((state === "working" || state === "submitted") && r.id) {
      await this.pollTask(endpoint, r.id, apiKey, contact);
      return;
    }

    // Direct message response (no task wrapper)
    if (r.parts) {
      const msg = Message.fromJSON(r);
      const reply = extractText(msg.parts as any);
      if (reply && reply !== "Message received") this.deps.onReply?.(contact, reply);
    }
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

      // Fire request — handle response in background
      const respPromise = this.jsonRpc(cfg.endpoint, "message/send", {
        message: {
          role: "user",
          messageId: crypto.randomUUID(),
          parts: [{ text }],
          metadata: { senderName },
        },
      }, cfg.apiKey);

      // Don't await — process response asynchronously
      respPromise
        .then((resp) => this.handleResponse(cfg.endpoint!, cfg.apiKey, contact, resp))
        .catch((err) => {
          appendFileSync("/tmp/a2a-debug.log", `[${new Date().toISOString()}] ✖ ERROR → ${cfg.endpoint}: ${err}\n`);
        });

      return { delivered: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { delivered: false, error: msg };
    }
  }
}
