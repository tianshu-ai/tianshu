// host.tokenMint capability — mint a scoped, signed session token for
// plugin-to-plugin or external-client authentication. The token is a
// standard session credential the host's identity resolver already
// accepts. Tenant is pinned to the capability's bound context; the
// plugin passes the user id.
//
// Use cases:
//   - Bridge (reverse-MCP): long-lived token for WebSocket auth
//   - Messenger A2A: short-lived pairing token + long-lived scoped communication token

export interface TokenGrant {
  /** The token to pass as `Authorization: Bearer <token>`.
   *  Empty string when auth is disabled (the dev resolver needs none). */
  token: string;
  /** Whether the host currently enforces auth. When false, the client
   *  may connect without a token. */
  authEnabled: boolean;
  /** Token expiry (epoch ms), or null when not applicable (no auth). */
  expiresAt: number | null;
}

export interface TokenMintOptions {
  /** Restrict this token to specific plugin routes.
   *  Format: `"pluginId.pathPattern"` e.g. `"messenger./a2a/*"`.
   *  When set, any request outside these scopes gets 403.
   *  Absent = unrestricted (full session). */
  scope?: string[];
}

export interface TokenMintCapability {
  /** Mint a signed session token for the given user in the bound tenant.
   *  `ttlSec` defaults to a long-lived device token (host-decided). */
  mint(userId: string, ttlSec?: number, options?: TokenMintOptions): TokenGrant;
}
