// A2A (agent-to-agent) messenger adapter.
//
// Sends messages to a remote tianshu instance via HTTP POST.
// The contact config stores { endpoint, apiKey } — the remote's
// receive URL and bearer token.

import type { Contact } from "../schema.js";
import type { SendAdapter } from "../tool.js";

export interface A2aAdapterDeps {
  log: Record<string, any>;
}

export class A2aMessengerAdapter implements SendAdapter {
  constructor(private deps: A2aAdapterDeps) {}

  async send(
    contact: Contact,
    text: string,
  ): Promise<{ delivered: boolean; error?: string }> {
    const cfg = contact.config as { endpoint?: string; apiKey?: string };
    if (!cfg.endpoint || !cfg.apiKey) {
      return { delivered: false, error: "missing endpoint or apiKey in contact config" };
    }

    try {
      const resp = await fetch(cfg.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({ text, sender: "agent" }),
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { delivered: false, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
      }

      return { delivered: true };
    } catch (err) {
      return { delivered: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
