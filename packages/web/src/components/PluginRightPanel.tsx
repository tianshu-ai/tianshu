// Renders the currently-open plugin right panel, if any.
//
// Reads (openPanel, plugins) from the plugin store, looks up the
// matching active plugin, and asks the web PluginRegistry to resolve
// the React component declared in `contributes.rightPanels[*]`.
//
// Failure modes (any of which silently render nothing per ADR-0003
// §1 "not installed = not visible"):
//   - openPanel set but no active plugin owns it
//   - plugin's client.entry isn't in the bundle
//   - manifest claims `<key>` but the client module didn't export it

import { useChatStore } from "../stores/chat-store";
import { usePluginStore } from "../stores/plugin-store";
import { resolveComponent } from "../lib/plugin-registry";
import type { PanelProps } from "@tianshu/plugin-sdk/client";

interface ContributesPanel {
  id: string;
  displayName: string;
  component: string;
}

export default function PluginRightPanel() {
  const me = useChatStore((s) => s.me);
  const openPanel = usePluginStore((s) => s.openPanel);
  const plugins = usePluginStore((s) => s.plugins);

  if (!openPanel || !plugins) return null;
  const dot = openPanel.indexOf(".");
  if (dot < 0) return null;
  const pluginId = openPanel.slice(0, dot);
  const localId = openPanel.slice(dot + 1);

  const plugin = plugins.find((p) => p.id === pluginId);
  if (!plugin || plugin.state !== "active") return null;

  const panels = (plugin.contributes as { rightPanels?: ContributesPanel[] }).rightPanels;
  const panelDef = panels?.find((p) => p.id === localId);
  if (!panelDef) return null;

  const Component = resolveComponent(plugin.clientEntry, panelDef.component);
  if (!Component) return null;

  const props: PanelProps = {
    tenantId: me?.tenantId ?? "",
    userId: me?.userId ?? "",
    plugin: {
      id: plugin.id,
      version: plugin.version,
      displayName: plugin.displayName,
    },
  };

  return (
    <aside className="flex h-full w-96 flex-shrink-0 flex-col border-l border-gray-800 bg-gray-900">
      <Component {...props} />
    </aside>
  );
}
