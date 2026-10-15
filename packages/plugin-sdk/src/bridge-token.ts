// Backward compatibility — re-exports from token-mint.ts
// New code should import from "./token-mint.js" directly.
export {
  type TokenGrant as BridgeTokenGrant,
  type TokenMintOptions as BridgeTokenMintOptions,
  type TokenMintCapability as BridgeTokenCapability,
} from "./token-mint.js";
