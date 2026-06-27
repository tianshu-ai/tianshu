// Public API barrel for the channel system.
//
// Server code outside `channels/` (boot wiring, admin routes, ...)
// imports through this file so the internal layout is free to
// evolve without spraying import paths.

export { ChannelHub, channelHub } from "./hub.js";
export { ChannelAdapterManager } from "./adapter-manager.js";
export type { AdapterManagerDeps } from "./adapter-manager.js";
export {
  createBinding,
  deleteBinding,
  getBinding,
  listBindingsForTenant,
  listBindingsForUser,
  listEnabledBindings,
  setBindingStatus,
  updateBinding,
} from "./bindings.js";
export type {
  CreateBindingInput,
  UpdateBindingInput,
} from "./bindings.js";
export type {
  BindingStatus,
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelAdapterFactory,
  ChannelBinding,
  ChannelId,
  ChannelReactionKind,
  InboundChannelMessage,
  InboundEnvelope,
  OutboundChannelMessage,
} from "./types.js";
export { startChannelRouter } from "./router.js";
export { ensureChannelSession } from "./sessions.js";
