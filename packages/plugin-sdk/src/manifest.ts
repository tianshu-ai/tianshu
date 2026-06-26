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
  /**
   * Optional declarative schema for the plugin's own config
   * (`tenant config.plugins.<id>.config`). When present the host
   * exposes a config form in the Plugin Manager UI; users edit
   * fields, host writes back via `PATCH /api/plugins/:id`.
   *
   * Field kinds we currently support:
   *   - boolean : checkbox
   *   - number  : number input (with optional `min`, `max`, `step`)
   *   - string  : single-line text input
   *
   * The schema is intentionally tiny — anything richer should land
   * in a dedicated admin page contribution. The values are passed
   * verbatim to the plugin via `PluginContext.pluginConfig`.
   */
  configSchema?: PluginConfigSchema;
}

export interface PluginConfigSchema {
  /** Top-level fields. Order is preserved in the UI. */
  fields: PluginConfigField[];
}

export type PluginConfigField =
  | PluginConfigBoolField
  | PluginConfigNumberField
  | PluginConfigStringField
  | PluginConfigSecretField
  | PluginConfigSelectField;

interface PluginConfigFieldBase {
  /** Dotted path under the plugin's config object, e.g. "echo.enabled". */
  key: string;
  /** Short label shown next to the input. */
  label: string;
  /** Optional one-line help, rendered under the input. */
  description?: string;
  /**
   * Optional grouping. Fields sharing the same `group.id` render
   * inside a bordered card with `group.label` as the section
   * header; `group.badge` (when set) renders as a coloured pill
   * next to the label so domain concepts (e.g. "worker type") get
   * visual emphasis. Fields without `group` keep the flat layout.
   */
  group?: PluginConfigFieldGroup;
}

export interface PluginConfigFieldGroup {
  /** Stable id; fields sharing this id are rendered together. */
  id: string;
  /** Section header text. */
  label: string;
  /** Optional small uppercase pill rendered next to the header.
   *  Used today to highlight worker type names. */
  badge?: string;
  /** Optional one-line description under the header. */
  description?: string;
}

export interface PluginConfigBoolField extends PluginConfigFieldBase {
  kind: "boolean";
  default?: boolean;
}

export interface PluginConfigNumberField extends PluginConfigFieldBase {
  kind: "number";
  default?: number;
  min?: number;
  max?: number;
  step?: number;
  /** Optional unit suffix shown to the right of the input ("ms", "s", etc). */
  unit?: string;
}

export interface PluginConfigStringField extends PluginConfigFieldBase {
  kind: "string";
  default?: string;
  placeholder?: string;
  /** When set, render as a textarea instead of an <input>. */
  multiline?: boolean;
}

/**
 * Secret string — API key, OAuth client secret, anything the user
 * shouldn't see in plaintext after entering. Storage rules differ
 * from `string`:
 *   - persisted to `<tenant>/secrets/plugin-<id>.json` (mode 0700,
 *     already a sibling-only directory) instead of `config.json`,
 *     so a leak of `config.json` doesn't leak credentials.
 *   - the GET /api/plugins response REDACTS the value: clients see
 *     `{ "<key>": { "__secret": true, "set": true|false } }` and
 *     never the cleartext.
 *   - PATCH semantics: passing a string sets it; passing
 *     `{ "__secret": true, "clear": true }` removes it; omitting
 *     the field leaves the existing value untouched. ("submit-the-
 *     redacted-shape-back" stays a no-op, which is what the form
 *     does on save when the user didn't touch the field.)
 *
 * The plugin sees the cleartext at activation time (merged into
 * `pluginConfig` from `secrets/`) — same shape as a regular string
 * field, no extra plumbing in the plugin code.
 */
export interface PluginConfigSecretField extends PluginConfigFieldBase {
  kind: "secret";
  /** Optional placeholder, e.g. "tvly-...". No `default`: secrets
   *  must come from the user, not the manifest. */
  placeholder?: string;
}

/**
 * Single-choice picker. Used when the field has a small fixed set
 * of valid values (e.g. "tavily" | "brave") — lets the form
 * surface a labelled dropdown instead of a free-text input the
 * user might typo into.
 *
 *   - `default` is the option's `value` (not its label) — same
 *     contract as the persisted config.
 *   - `options[].label` is the human-readable text shown in the
 *     dropdown; `options[].value` is what's persisted.
 */
export interface PluginConfigSelectField extends PluginConfigFieldBase {
  kind: "select";
  default?: string;
  options: Array<{ label: string; value: string }>;
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
   * Admin pages the plugin contributes to the chat shell's `/admin`
   * surface (sidebar + nested route). Each entry shows up as a left-nav
   * item under `/admin/<plugin-id>/<id>` and renders the named
   * client component. Use this for management UIs that don't fit
   * the right-panel form factor: full-width forms, multi-section
   * settings pages, log viewers, etc. See ADR-0004 §12.
   */
  adminPages?: AdminPageContribution[];
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
   * Dynamic *toolsets* the plugin contributes — most commonly an
   * MCP server reflected through the SDK's `McpToolset`. Each entry
   * names a `ToolsetProvider` exported from
   * `exports.toolsetProviders`. The host calls
   * `provider.listTools()` every turn so the visible tool surface
   * can grow / shrink as upstream MCP servers come online or
   * disappear, without re-activating the plugin.
   */
  toolsets?: ToolsetContribution[];
  /**
   * Skills (markdown how-to files) the plugin ships. Each skill is
   * advertised to the agent by name + description; the agent calls
   * the host's `load_skill` meta-tool to pull the body into context
   * on demand. See ADR-0004 §11.
   */
  skills?: SkillContribution[];
  /**
   * Worker-agent seed bundles the plugin ships. On first activation
   * for a tenant, the host copies each entry's `path` into
   * `<tenant>/_tenant/config/workers/<id>/`. Already-existing
   * directories are left alone, so a user edit survives plugin
   * upgrades and a deleted seed stays deleted (mirrors the
   * `ensureTenantConfigDefaults` semantics for skill bundles).
   *
   * The seed directory layout matches the runtime layout the loader
   * expects:
   *
   *   <id>/
   *     agent.json           (required: kind, modelId?, enabled, ...)
   *     SOUL.md              (optional: system prompt)
   *     skills/<name>/...    (optional: pre-installed skills)
   *
   * `<id>` becomes the worker's slug — stable, kebab-case,
   * unique within the plugin.
   */
  agentSeeds?: AgentSeedContribution[];
  /**
   * Chat-platform channel adapters the plugin contributes.
   * Each entry registers a `ChannelAdapter` factory (keyed in
   * the plugin's server-exports `channels` map). The host's
   * channel hub picks adapters up by `id`, instantiates one per
   * configured account binding, fans inbound messages into the
   * router, and routes outbound replies back.
   *
   * Examples: feishu / telegram / discord / wechat / slack. The
   * built-in `webchat` channel is not contributed via this
   * mechanism — it sits inside the host directly because it
   * shares the agent's WebSocket transport.
   */
  channels?: ChannelContribution[];
  /**
   * Static system-prompt fragments injected into the main chat
   * agent's prompt when this plugin is active for the current
   * tenant. Use sparingly — each fragment costs context budget
   * on every turn for every user. The right shape is a short
   * imperative sentence or two that changes the agent's default
   * disposition; long instructions belong in skills (which are
   * read on demand) instead.
   *
   * Worker-side prompts are not affected. Only the main chat
   * agent loads these.
   *
   * Example: workboard ships a fragment that nudges the main
   * agent toward delegating non-trivial requests to the worker
   * pool rather than doing the work in-line.
   */
  systemPromptFragments?: SystemPromptFragmentContribution[];
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
  /**
   * Semver string marking the release this tool first appeared in.
   *
   * Currently interpreted as a **tianshu app version** (the host's
   * `package.json/version`). The boot-time tool-delta detector
   * uses this to push a synthetic system message into any session
   * whose `created_under_app_version` predates a tool's `since`,
   * so the agent learns about newly-available tools across
   * server restarts.
   *
   * v1 marketplace target: re-interpret as the plugin's own
   * `manifest.version` (per-plugin granularity). The field name
   * stays; only the comparison reference changes.
   *
   * Required for builtin plugins (manifest-hygiene tests pin
   * this). Optional for third-party plugins during the v0
   * transition — absent means "assume it has existed forever".
   */
  since?: string;
}

export interface ToolsetContribution {
  /** Local id, surfaced in the admin MCP servers view + plugin
   *  manager. */
  id: string;
  /** Key in the plugin's server-exports `toolsetProviders` map. */
  module: string;
  /** Optional human label shown in the admin MCP servers view.
   *  Defaults to `id`. */
  displayName?: string;
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

export interface SystemPromptFragmentContribution {
  /** Local id; surfaced as `<plugin-id>.<id>` for log lines. */
  id: string;
  /**
   * The literal markdown / plain text injected into the system
   * prompt. Wrapped automatically in a section header derived
   * from the plugin's displayName so the agent can tell where
   * the rule came from. Keep it tight — one or two sentences
   * unless you really need more.
   */
  text: string;
}

export interface AgentSeedContribution {
  /**
   * Local slug. Becomes the directory name under
   * `_tenant/config/workers/<id>/`. Kebab-case, must be unique
   * within this plugin (and ideally across plugins; collisions are
   * resolved last-writer-wins with a console warning).
   */
  id: string;
  /**
   * Path to the seed directory, relative to the plugin's manifest.
   * The host copies the *contents* of this directory into the
   * tenant slot — not the directory itself — so an `agent.json`
   * sitting at `<path>/agent.json` lands at
   * `_tenant/config/workers/<id>/agent.json`.
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

export interface AdminPageContribution {
  /** Local id; surfaced as `<plugin-id>.<id>` for routing/logging. */
  id: string;
  /** Sidebar label. */
  displayName: string;
  /** lucide-react export name; rendered next to the label. */
  icon?: string;
  /** Key in the plugin's client-exports `components` map. The
   *  component receives `AdminPageProps`. */
  component: string;
  /** Smaller order = higher in the sidebar. Default 100. */
  order?: number;
  /** Optional sub-section title in the sidebar (e.g. "Sandbox",
   *  "Models"). Pages with the same group render under one heading
   *  in declaration order. */
  group?: string;
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

/**
 * Channel contribution — register a chat-platform adapter
 * (Feishu / Telegram / WeChat / Discord / Slack / ...) the host's
 * channel hub can instantiate per-binding.
 *
 * The plugin's `server.ts` exports a `channels` map keyed by
 * `module`; each entry is a `ChannelAdapterFactory` (see
 * `server.ts: ChannelAdapterFactory`). The host calls the factory
 * once per binding (an account configured for this tenant), wires
 * the resulting `ChannelAdapter` into the hub, then drives it via
 * `start()` / `stop()` / `send()` / `onMessage()`.
 */
export interface ChannelContribution {
  /**
   * Stable channel id. MUST be globally unique across plugins
   * because the router uses it as the dispatch key (the
   * "feishu" / "telegram" / "wechat" prefix on session titles
   * and binding rows). Lowercase, no spaces, no version suffix.
   */
  id: string;
  /** Human-readable name for admin / log UIs. */
  displayName: string;
  /** Key in the plugin's server-exports `channels` map. */
  module: string;
  /**
   * Semver string marking the release this channel first
   * appeared in. Same role as ToolContribution.since — the
   * boot-time tool-delta detector treats new channels as a
   * new capability surface worth telling the agent about.
   */
  since?: string;
}


