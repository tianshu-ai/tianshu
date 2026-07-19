// host.bridgeToken capability — mint a connection token for a local
// Bridge client (reverse-MCP). The token authenticates the client's
// inbound WebSocket via the host's existing identity resolver chain, so
// no new auth surface is introduced. Tenant + user are pinned by the
// host to the capability's bound context; a plugin cannot mint for
// another tenant/user.

export interface BridgeTokenGrant {
  /** The token to pass as `Authorization: Bearer <token>` on /ws.
   *  Empty string when auth is disabled (the dev resolver needs none). */
  token: string;
  /** Whether the host currently enforces auth. When false, the client
   *  may connect without a token. */
  authEnabled: boolean;
  /** Token expiry (epoch ms), or null when not applicable (no auth). */
  expiresAt: number | null;
}

export interface BridgeTokenCapability {
  /** Mint a connection token for the given user in the bound tenant.
   *  `ttlSec` defaults to a long-lived device token (host-decided). */
  mint(userId: string, ttlSec?: number): BridgeTokenGrant;
}
