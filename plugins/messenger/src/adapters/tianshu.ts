// Tianshu-to-tianshu adapter.
//
// Outbound: send messages to a paired tianshu instance via HTTP POST.
// Inbound: handled by the channel adapter in server.ts (receives via /tianshu/receive route).

import type { Contact, TianshuContactConfig } from "../schema.js";
import type { SendAdapter } from "../tool.js";

export interface TianshuAdapterDeps {
  log: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export class TianshuMessengerAdapter implements SendAdapter {
  constructor(private deps: TianshuAdapterDeps) {}

  /** Send a message to a tianshu peer. */
  async send(
    contact: Contact,
    text: string,
  ): Promise<{ delivered: boolean; error?: string }> {
    const sender = "agent";
    const cfg = contact.config as unknown as TianshuContactConfig;
    if (!cfg.endpointUrl || !cfg.authToken) {
      return { delivered: false, error: "missing endpointUrl or authToken" };
    }
    try {
      const resp = await fetch(
        `${cfg.endpointUrl.replace(/\/$/, "")}/api/p/messenger/tianshu/receive`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.authToken}`,
          },
          body: JSON.stringify({ text, sender }),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { delivered: false, error: `HTTP ${resp.status}: ${body}` };
      }
      return { delivered: true };
    } catch (err) {
      return {
        delivered: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Check if a contact is configured for sending. */
  isReady(contact: Contact): boolean {
    const cfg = contact.config as unknown as TianshuContactConfig;
    return !!(cfg.endpointUrl && cfg.authToken);
  }
}
