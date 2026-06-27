// Internal channel-system types.
//
// Most of the wire-level types (InboundChannelMessage, OutboundChannelMessage,
// ChannelAdapter) live in @tianshu-ai/plugin-sdk so plugins can import
// them. This file extends them with host-side concerns:
//
//   - InboundEnvelope: an inbound message tagged with the binding +
//     tenant that produced it. The hub fans this into the router.
//
//   - ChannelBinding row shape: how bindings are persisted in
//     `channel_bindings`. The host enforces the per-binding adapter
//     lifecycle on top of these rows.
//
//   - BindingStatus enumeration: the state machine each binding
//     transitions through as its adapter starts / runs / fails.

import type {
  ChannelAdapter,
  InboundChannelMessage,
} from "@tianshu-ai/plugin-sdk";

export type { ChannelAdapter, InboundChannelMessage };
export type {
  ChannelAdapterContext,
  ChannelAdapterFactory,
  ChannelId,
  ChannelReactionKind,
  OutboundChannelMessage,
} from "@tianshu-ai/plugin-sdk";

/** An inbound message after the hub has tagged it with envelope
 *  metadata. Router operates on this rather than the raw adapter
 *  payload so it always knows which binding (and therefore which
 *  tenant) produced the message. */
export interface InboundEnvelope extends InboundChannelMessage {
  /** Binding id this message arrived through. */
  bindingId: string;
  /** Tenant the binding belongs to. */
  tenantId: string;
}

/** State machine each binding moves through. Persisted in
 *  `channel_bindings.status`. */
export type BindingStatus =
  | "idle"      // row exists, adapter not yet started
  | "starting"  // start() in flight
  | "running"   // start() succeeded, listening
  | "error"     // start() failed or adapter emitted error
  | "stopped"   // explicit stop()
  ;

/** Persisted binding row shape. */
export interface ChannelBinding {
  id: string;
  tenantId: string;
  /** User that owns this binding. Channel credentials are personal
   *  (one user's wechat scan shouldn't expose another user's
   *  sessions); all CRUD scopes by both tenant + this id. */
  ownerUserId: string;
  channelId: string;
  pluginId: string;
  displayName: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  status: BindingStatus;
  statusDetail: string | null;
  createdAt: number;
  updatedAt: number;
}
