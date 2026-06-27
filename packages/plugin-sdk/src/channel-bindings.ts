// Capability-side type for `host.channelBindings`.
//
// Channel plugins (wechat / telegram / discord / ...) call into
// this through `ctx.capabilities.get<ChannelBindingsCapability>(
// "host.channelBindings")` after a successful login flow to:
//
//   - persist the binding row (token, account metadata, ...) on
//     `channel_bindings`
//   - kick the adapter manager to actually start the adapter so
//     the long-poll begins immediately, no server restart
//   - list / delete previously-created bindings for the admin UI
//
// We keep the wire shape in plugin-sdk (not @tianshu/server) so
// plugins don't pull a host dep just to register a binding. The
// host registers a matching impl in index.ts; the registry hooks
// it under the capability name.

/** Subset of the channel_bindings row plugins can see. The full row
 *  (status, status_detail, timestamps) is host-internal; the plugin
 *  cares about creating / updating identity + config. */
export interface ChannelBindingView {
  /** Stable id, prefixed `cb_`. */
  id: string;
  /** Tenant this binding belongs to. */
  tenantId: string;
  /** The user this binding belongs to. Channel accounts (a wechat
   *  login, a telegram bot token, ...) are personal credentials —
   *  one user binding their phone shouldn't surface that account
   *  to other users on the same tenant. The host scopes list /
   *  delete to this id. */
  ownerUserId: string;
  /** Channel id ("wechat" / "telegram" / ...). */
  channelId: string;
  /** Plugin id that contributes the channel. */
  pluginId: string;
  /** Human-readable label admins set / the login flow inferred. */
  displayName: string | null;
  /** Whether the host's adapter manager should keep it active. */
  enabled: boolean;
  /** Last lifecycle state the adapter reached. */
  status: "idle" | "starting" | "running" | "error" | "stopped";
  /** Free-text last status detail (auth failure, last reconnect, etc.). */
  statusDetail: string | null;
  /** Per-binding adapter config (token + identity, plugin-defined). */
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CreateChannelBindingInput {
  /** Per-user scope. Channel credentials are personal — the host
   *  refuses any operation where the caller-supplied userId doesn't
   *  own the targeted binding. Plugin admin routes get this from
   *  `req.ctx.userId` (set by the host's tenant middleware). */
  ownerUserId: string;
  channelId: string;
  pluginId: string;
  displayName?: string;
  config: Record<string, unknown>;
  /** Default true. Set false to create a binding without starting
   *  the adapter (admin can flip later). */
  enabled?: boolean;
}

export interface ChannelBindingsCapability {
  /** Create + start a binding in one call. Returns the row the
   *  host persisted. */
  create(input: CreateChannelBindingInput): Promise<ChannelBindingView>;
  /** Enumerate the calling user's bindings. */
  list(opts: { ownerUserId: string; channelId?: string }): ChannelBindingView[];
  /** Stop the adapter, delete the row. Refuses the operation when
   *  the binding doesn't belong to the supplied user. Returns true
   *  if anything was removed. */
  delete(bindingId: string, ownerUserId: string): Promise<boolean>;
}
