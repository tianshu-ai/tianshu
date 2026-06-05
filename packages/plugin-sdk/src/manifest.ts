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
  /** Declarative permission strings (not enforced in v0). */
  permissions?: string[];
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
   * Buttons in the chat composer (left of Send). The contributed
   * component renders inside the input row and gets a `composer`
   * prop with `useComposer()`-equivalent capabilities (manage
   * attachments, register draft transforms). See ADR-0003 §7.
   */
  composerActions?: ComposerActionContribution[];
  apiRoutes?: ApiRouteContribution[];
  wsMessages?: WsMessageContribution[];
  commands?: CommandContribution[];
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

export interface CommandContribution {
  id: string;
  title: string;
}
