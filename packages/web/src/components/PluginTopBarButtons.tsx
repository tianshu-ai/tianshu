// Renders top-bar buttons contributed by active plugins, **only when
// no right panel is open**. The open panel has its own PluginPanelTabBar
// (per the closed-source predecessor's UX) which exposes the same
// icons; showing them in both places at once would be duplicate noise.

import { Puzzle } from "lucide-react";
import { ICONS_BY_NAME } from "../lib/plugin-icons";
import { usePluginStore } from "../stores/plugin-store";

interface ContributesTopBarButton {
  id: string;
  icon: string;
  tooltip?: string;
  opensPanel?: string;
  order?: number;
}

interface ContributesShape {
  topBarButtons?: ContributesTopBarButton[];
}

export default function PluginTopBarButtons() {
  const plugins = usePluginStore((s) => s.plugins);
  const openPanel = usePluginStore((s) => s.openPanel);
  const setOpenPanel = usePluginStore((s) => s.setOpenPanel);

  // Hide once a right panel is open — its PanelTabBar takes over.
  if (openPanel !== null) return null;
  if (!plugins) return null;

  type FlatButton = ContributesTopBarButton & { pluginId: string };
  const buttons: FlatButton[] = [];
  for (const p of plugins) {
    if (p.state !== "active") continue;
    const c = (p.contributes as ContributesShape).topBarButtons ?? [];
    for (const b of c) buttons.push({ ...b, pluginId: p.id });
  }
  buttons.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  if (buttons.length === 0) return null;

  return (
    <>
      {buttons.map((b) => {
        const fullId = `${b.pluginId}.${b.id}`;
        const panelTarget = b.opensPanel
          ? b.opensPanel.includes(".")
            ? b.opensPanel
            : `${b.pluginId}.${b.opensPanel}`
          : null;
        const Icon = ICONS_BY_NAME[b.icon] ?? Puzzle;
        return (
          <button
            key={fullId}
            type="button"
            title={b.tooltip ?? b.pluginId}
            aria-label={b.tooltip ?? b.pluginId}
            onClick={() => {
              if (!panelTarget) return;
              setOpenPanel(panelTarget);
            }}
            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
          >
            <Icon size={16} />
          </button>
        );
      })}
    </>
  );
}
