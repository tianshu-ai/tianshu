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
  "sandbox.taskPool": {
    exclusive: true,
    description:
      "Manage per-task sandbox lifecycle: acquire a dedicated sandbox at worker pickup time, release it (stop without removing) when the task terminates, and destroy it on task delete. Workboard binds task ids to agent sessions through this capability so per-task `exec` calls land in the right sandbox.",
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
  "host.sessionInbox": {
    exclusive: true,
    description:
      "Deliver a system-level message to a chat session's inbox. If the session has an active turn running, the message is queued via harness.followUp(); otherwise it persists in the DB and is flushed as a system note the next time the session takes a user turn. Provided by the host; workboard uses this to notify the parent agent when a delegated task finishes.",
  },
  "host.toolCatalog": {
    exclusive: true,
    description:
      "Read the tool catalog the host can offer to the current tenant: every tool name registered by the host plus every active plugin's contributions. Plugins use this to seed allow-list defaults (e.g. workboard's Default LLM agent grants every tool by default rather than 'unlimited' meaning silent fallthrough).",
  },
  "host.skillCatalog": {
    exclusive: true,
    description:
      "Read the skill catalog the host can offer to the current tenant: every skill name registered host-side plus every active plugin's contributions. Same role as host.toolCatalog but for the skill allow-list field.",
  },
  "host.modelCatalog": {
    exclusive: true,
    description:
      "Read the LLM model catalog the host can offer to the current tenant: every provider/model registered in the host's `models.providers` config, plus the default modelId. Used by the main agent and worker-creator to pick a model for new worker bundles instead of hard-coding ids.",
  },
  "host.lsp": {
    exclusive: true,
    description:
      "Diagnose a file via the host's LSP manager after a write/edit. Plugins (notably `files`) call `diagnoseAfterEdit({ filePath, contents })` and append the formatted diagnostic block to their tool result so the model sees compile errors in the same turn that introduced them. Tenant-scoped: the manager refuses files outside the calling tenant's workspace. See ADR-0005.",
  },
  "host.channelBindings": {
    exclusive: true,
    description:
      "Manage channel adapter bindings (chat-platform integrations). Plugins contributing a channel (Feishu / Telegram / WeChat / ...) call create/start/stop/delete here so the host's adapter manager actually wires the inbound stream to the agent. The DB row + adapter lifecycle live together behind this capability.",
  },
  "host.workforceSnapshot": {
    exclusive: true,
    description:
      "Build a read-only snapshot of the tenant's agent configuration (main agent prompt + tools + skills, every worker agent's prompt + allowed tools + allowed skills). Used by the Workforce Studio plugin to render an inspect-and-export UI; the snapshot includes full skill markdown bodies so the studio can ship a faithful bundle.",
  },
  "host.solutions": {
    exclusive: true,
    description:
      "Manage Solutions (ADR-0008): declarative descriptions of the desired agent configuration for a tenant. Extract current reality into a named solution, list / read / save / delete solutions, and diff a solution against reality or another solution. Phase 2 has no Apply — solutions are inert files on disk until a later phase reconciles them into reality.",
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
