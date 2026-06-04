// Client-side plugin authoring types. Imported as
// `@tianshu/plugin-sdk/client`.
//
// The chat shell's PluginRegistry expects a plugin's client module to
// export a `components` map keyed by the strings used in the manifest's
// `contributes.{rightPanels|sidebarSections}.component`.

import type { ComponentType } from "react";

export interface PluginRuntimeInfo {
  id: string;
  version: string;
  displayName: string;
}

export interface PanelProps {
  tenantId: string;
  userId: string;
  plugin: PluginRuntimeInfo;
}

export interface SidebarSectionProps extends PanelProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export interface PluginClientExports {
  components: Record<string, ComponentType<PanelProps | SidebarSectionProps>>;
}
