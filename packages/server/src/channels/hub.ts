// Central registry + event bus for inbound channel messages.
//
// The hub holds one entry per *binding* (a tenant + channel + account
// pair), not per channel. A binding wraps:
//   - the underlying ChannelAdapter instance,
//   - the tenant it belongs to (router dispatches per-tenant),
//   - the binding id (used as the public lookup key).
//
// Inbound messages get tagged with `bindingId` + `tenantId` before
// fanning out to listeners. Outbound sends pick the adapter by
// `bindingId` so multiple bindings (two Feishu apps, one Telegram bot,
// ...) coexist without ambiguity.
//
// The hub is intentionally state-free beyond the entry map: it does
// not own the binding row, does not retry, does not buffer. Those
// concerns live in `adapter-manager.ts` and the per-adapter plugin
// code respectively.

import type {
  ChannelAdapter,
  ChannelId,
  InboundEnvelope,
  OutboundChannelMessage,
} from "./types.js";

type MessageHandler = (msg: InboundEnvelope) => void;
type ErrorHandler = (bindingId: string, channelId: ChannelId, err: Error) => void;

interface HubEntry {
  bindingId: string;
  tenantId: string;
  adapter: ChannelAdapter;
}

export class ChannelHub {
  private entries = new Map<string, HubEntry>();
  private messageHandlers = new Set<MessageHandler>();
  private errorHandlers = new Set<ErrorHandler>();

  /** Wire an adapter into the hub under `bindingId`. Does NOT call
   *  `start()` — that's the caller's job, so connect failures can be
   *  captured + persisted on the binding row. */
  register(bindingId: string, tenantId: string, adapter: ChannelAdapter): void {
    if (this.entries.has(bindingId)) {
      throw new Error(`[channel-hub] Duplicate binding id: ${bindingId}`);
    }
    adapter.onMessage((msg) => {
      const envelope: InboundEnvelope = { ...msg, bindingId, tenantId };
      for (const h of this.messageHandlers) {
        try {
          h(envelope);
        } catch (err) {
          // Handlers MUST NOT propagate errors back through the hub;
          // a misbehaving listener should not stop the others.
          console.error(
            `[channel-hub] message handler threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    });
    adapter.onError((err) => {
      for (const h of this.errorHandlers) {
        try {
          h(bindingId, adapter.id, err);
        } catch (err2) {
          console.error(
            `[channel-hub] error handler threw: ${
              err2 instanceof Error ? err2.message : String(err2)
            }`,
          );
        }
      }
    });
    this.entries.set(bindingId, { bindingId, tenantId, adapter });
  }

  /** Drop a binding from the hub. Does NOT call `stop()`; the
   *  caller is expected to drive the adapter lifecycle separately. */
  unregister(bindingId: string): void {
    this.entries.delete(bindingId);
  }

  /** Look up the adapter behind a binding id. Returns null when the
   *  binding isn't registered (e.g. it was disabled or its adapter
   *  failed to start). */
  getAdapter(bindingId: string): ChannelAdapter | null {
    return this.entries.get(bindingId)?.adapter ?? null;
  }

  /** Return every active binding's metadata, sorted by tenant id
   *  for deterministic admin UIs. */
  listBindings(): ReadonlyArray<Pick<HubEntry, "bindingId" | "tenantId"> & {
    channelId: ChannelId;
    displayName: string;
  }> {
    return Array.from(this.entries.values())
      .map((e) => ({
        bindingId: e.bindingId,
        tenantId: e.tenantId,
        channelId: e.adapter.id,
        displayName: e.adapter.displayName,
      }))
      .sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  }

  /** Subscribe to inbound messages. The same handler can be
   *  registered multiple times; each call gets one delivery. The
   *  returned function unregisters when invoked. */
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  /** Subscribe to adapter errors. Same multi-registration + unsub
   *  semantics as `onMessage`. */
  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  /** Route an outbound message through the binding's adapter.
   *  Throws when the binding is unknown so callers (the router)
   *  can decide whether to drop or re-queue. */
  async send(bindingId: string, msg: OutboundChannelMessage): Promise<void> {
    const entry = this.entries.get(bindingId);
    if (!entry) {
      throw new Error(`[channel-hub] Unknown binding id: ${bindingId}`);
    }
    await entry.adapter.send(msg);
  }
}

/** Process-wide singleton. We use one hub for the whole server so
 *  every binding's traffic lands on the same router; tenants only
 *  see their own envelopes because the router filters on
 *  `envelope.tenantId`. */
export const channelHub = new ChannelHub();
