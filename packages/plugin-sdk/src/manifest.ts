// Plugin manifest types (ADR-0003 §5).
//
// We deliberately keep these as plain TS interfaces — no schema lib in
// v0. Validation in `core/plugins/manifest.ts` checks the same shape at
// runtime.

export interface PluginManifest {
  /** ^[a-z0-9][a-z0-9-]{1,30}$ */
  id: string;
  /** semver */
  version: string;
  displayName: string;
  description?: string;
  author?: string;
  license?: string;
  /**
   * Declarative permission strings.
   *
   * ⚠️ **NOT enforced in v0.** Plugins run with full host privileges:
   * they share the tenant DB, the workspace filesystem, and the
   * tenant config write surface with each other. The host does not
   * sandbox plugins from each other and does not check this list
   * before granting access to anything. Authoring plugins as if
   * these were enforced is fine — it documents intent for the user
   * — but **never trust this list as a security boundary**.
   *
   * Real enforcement (capability gating, route ACLs, plugin-vs-plugin
   * isolation) lands when the catalog ships third-party plugins;
   * see `docs/architecture/plugins.md` §"Trust model".
   */
  permissions?: string[];
  /**
   * Capabilities (ADR-0004 §3) this plugin claims to provide. Each
   * entry must be a member of `KNOWN_CAPABILITIES` and must be
   * backed by an actual `contributes.*` entry. Validated at
   * activation time.
   */
  provides?: string[];
  /**
   * Capabilities (ADR-0004 §5) this plugin needs from some other
   * active plugin in the same tenant (or from itself, if it both
   * provides and requires). Each entry must be a member of
   * `KNOWN_CAPABILITIES`.
   */
  requires?: string[];
  client?: PluginEntryRef;
  server?: PluginEntryRef;
  contributes?: ContributesV1;
}

export interface PluginEntryRef {
  /**
   * Module specifier resolved by the host bundle / require chain.
   * For builtin v0 plugins this is a known package name in the server
   * or web bundle's module graph.
   */
  entry: string;
}

export interface ContributesV1 {
  topBarButtons?: TopBarButtonContribution[];
  rightPanels?: RightPanelContribution[];
  sidebarSections?: SidebarSectionContribution[];
  /**
   * Sandbox runtime providers (ADR-0004 §1). Each entry registers a
   * `SandboxRunner` whose `kind` selects which agent tools the
   * core wires up (e.g. `kind: "shell"` → `exec` / `reset_sandbox`).
   */
  sandboxes?: SandboxContribution[];
  /**
   * Agent tools the plugin contributes. The host collects every
   * active plugin's tools each turn and registers them with the
   * chat agent. `module` is the key in the plugin's
   * `exports.tools` map.
   */
  tools?: ToolContribution[];
  /**
   * Skills (markdown how-to files) the plugin ships. Each skill is
   * advertised to the agent by name + description; the agent calls
   * the host's `load_skill` meta-tool to pull the body into context
   * on demand. See ADR-0004 §11.
   */
  skills?: SkillContribution[];
  /**
   * Buttons in the chat composer (left of Send). The contributed
   * component renders inside the input row and gets a `composer`
   * prop with `useComposer()`-equivalent capabilities (manage
   * attachments, register draft transforms). See ADR-0003 §7.
   */
  composerActions?: ComposerActionContribution[];
  /**
   * Components that render the attachment chips/thumbnails attached
   * to a user message. The host walks contributions in order and
   * picks the first whose `mimePattern` matches the attachment's
   * mime type. This is how the host stays decoupled from any
   * particular file plugin's URL scheme. See ADR-0003 §12.
   */
  attachmentRenderers?: AttachmentRendererContribution[];
  apiRoutes?: ApiRouteContribution[];
  wsMessages?: WsMessageContribution[];
}

export type SandboxKind = "shell";

export interface SandboxContribution {
  /** Local id; surfaced as `<plugin-id>.<id>` to the world. */
  id: string;
  kind: SandboxKind;
  displayName: string;
  /** Key in the plugin's server-exports `sandboxes` map. */
  module: string;
}

export interface ToolContribution {
  /** Local id, mostly for debugging / Plugin Manager UI. */
  id: string;
  /** Key in the plugin's server-exports `tools` map. The tool's
   *  user-facing name (what the model sees) lives in the tool's
   *  pi-ai schema, not here — we don't enforce a 1:1 between this
   *  contribution id and the schema name. */
  module: string;
}

export interface SkillContribution {
  /** Local id; surfaced as `<plugin-id>.<id>` for logging. */
  id: string;
  /**
   * Path (relative to the plugin's manifest dir) to the markdown
   * skill file. Frontmatter declares `name`, `description`, and an
   * optional `when` predicate. Body is whatever the agent should
   * read after `load_skill(name)`.
   */
  path: string;
}

export interface TopBarButtonContribution {
  /** Local id; surfaced as `<plugin-id>.<id>` to the world. */
  id: string;
  /** lucide-react export name. */
  icon: string;
  tooltip?: string;
  /** Right-panel id (also `<plugin-id>.<id>`) that this button toggles. */
  opensPanel?: string;
  /** Smaller order = further left. Default 100. */
  order?: number;
}

export interface RightPanelContribution {
  id: string;
  displayName: string;
  /** Key in the plugin's client-exports `components` map. */
  component: string;
}

export interface SidebarSectionContribution {
  id: string;
  displayName: string;
  component: string;
  /** Anchor section id (`workers`, `channels`, …). Plugin sections
   *  render after the named anchor. */
  after?: string;
  /** Smaller order = higher up among plugins sharing the same anchor. */
  order?: number;
}

export interface ComposerActionContribution {
  /** Local id; surfaced as `<plugin-id>.<id>` to the world. */
  id: string;
  /** lucide-react export name. Rendered next to the icon-only button. */
  icon?: string;
  tooltip?: string;
  /** Key in the plugin's client-exports `components` map. The
   *  component takes `ComposerActionProps`. If omitted, a built-in
   *  icon-only button is rendered (clicking it triggers a
   *  client-side default action via the manifest — reserved for v1). */
  component: string;
  /** Smaller order = further left among composer actions. Default 100. */
  order?: number;
}

export interface AttachmentRendererContribution {
  /** Local id; surfaced as `<plugin-id>.<id>` to the world. */
  id: string;
  /**
   * Mime pattern this renderer handles. Three forms supported:
   *   - exact:        `application/pdf`
   *   - type wildcard: `image/*`
   *   - catchall:      `*\/*`
   * Patterns are matched in plugin/contrib order; the first match
   * wins. Plugins should give wildcards a higher (numerically
   * larger) `order` so exact-match contributions get a chance first.
   */
  mimePattern: string;
  /** Key in the plugin's client-exports `components` map. The
   *  component receives `AttachmentRendererProps`. */
  component: string;
  /** Smaller order = checked first. Default 100. */
  order?: number;
}

export interface ApiRouteContribution {
  /** HTTP verb. */
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path mounted at `/api/p/<plugin-id><path>`. Must start with `/`. */
  path: string;
  /** Key in the plugin's server-exports `routes` map. */
  handler: string;
}

export interface WsMessageContribution {
  /** Wire-format `type` value. Globally unique across active plugins. */
  type: string;
  /** Key in the plugin's server-exports `wsHandlers` map. */
  handler: string;
}


