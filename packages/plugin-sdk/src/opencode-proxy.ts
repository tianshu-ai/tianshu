// Host capability: `host.opencodeProxy`.
//
// Registered by the host (packages/server). Lets a plugin (e.g. the
// workboard OpenCode worker) mint a short-lived, single-model,
// single-tenant proxy token for a sandboxed external agent to reach
// a tianshu model — without the sandbox ever seeing the real
// provider key or baseUrl.
//
// Usage sketch (worker side):
//   const grant = ctx.capabilities
//     .get<OpenCodeProxyCapability>("host.opencodeProxy")
//     ?.grant(ctx.tenantId, modelId);
//   // hand grant.token + grant.baseUrl to the sandbox's opencode.json
//   // ... run opencode ...
//   proxy.revoke(grant.token);

export interface OpenCodeProxyGrant {
  /** Opaque bearer the sandbox uses as its "apiKey". */
  token: string;
  /** Full model id the token is bound to, e.g.
   *  "anthropic/claude-opus-4-7". */
  modelId: string;
  /** Base URL the sandbox should point OpenCode at. Already
   *  includes the token path segment, e.g.
   *  "http://host.internal:PORT/opencode-proxy/<token>". The
   *  sandbox appends the protocol tail (`/v1/messages`, etc.). */
  baseUrl: string;
  /** ms epoch after which the grant stops working. */
  expiresAt: number;
}

export interface OpenCodeProxyCapability {
  /** Mint a grant for one (tenant, model). */
  grant(tenantId: string, modelId: string): OpenCodeProxyGrant;
  /** Invalidate a grant (call on task end). */
  revoke(token: string): void;
}
