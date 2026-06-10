// Capability vocabulary (ADR-0004 §3).
//
// A capability is a maintainer-defined tag that names a concrete
// platform-level capability a plugin can provide or require. The
// vocabulary is closed: extending it is a maintainer PR to this file,
// which forces explicit thought about new platform surface area and
// keeps capability strings from drifting between plugins.
//
// Every entry has:
// - exclusive: when true, only one plugin in a tenant may provide
//   this capability. The registry rejects a second provider at
//   activation time (ADR-0004 §7).
// - description: human-readable surface description, shown in the
//   Plugin Manager UI (Catalog tab) and in error messages.

export interface CapabilitySpec {
  readonly exclusive: boolean;
  readonly description: string;
}

export const KNOWN_CAPABILITIES = {
  "sandbox.shell": {
    exclusive: true,
    description:
      "Run shell commands and read/write files in an isolated per-tenant workspace.",
  },
  "browser.cdp": {
    exclusive: true,
    description:
      "Provide a headless chromium reachable via Chrome DevTools Protocol + Playwright MCP, with a noVNC viewport for the user.",
  },
  "host.agentLoop": {
    exclusive: true,
    description:
      "Run a headless agent loop on behalf of a worker: spin up a kind='worker' session, call the LLM with the tenant's tool/skill set, persist messages, enforce first-response/idle/max-run timeouts, and return a structured terminal result. Provided by the host (not by a plugin); workboard's LLM worker requires it.",
  },
} as const satisfies Record<string, CapabilitySpec>;

export type CapabilityName = keyof typeof KNOWN_CAPABILITIES;

/** True iff the given string is a registered capability name. */
export function isCapabilityName(s: string): s is CapabilityName {
  return Object.prototype.hasOwnProperty.call(KNOWN_CAPABILITIES, s);
}

/** Returns the capability spec or undefined if unknown. */
export function capabilitySpec(name: string): CapabilitySpec | undefined {
  return isCapabilityName(name) ? KNOWN_CAPABILITIES[name] : undefined;
}
