// Renders top-bar buttons contributed by active plugins, **only when
// no right panel is open**. The open panel has its own PluginPanelTabBar
// (per the closed-source predecessor's UX) which exposes the same
// icons; showing them in both places at once would be duplicate noise.

import { Puzzle } from "lucide-react";
import { useSyncExternalStore } from "react";
import { ICONS_BY_NAME } from "../lib/plugin-icons";
import { usePluginStore } from "../stores/plugin-store";
import { getLocale, subscribeLocale } from "../lib/i18n";
import { manifestLabelFor } from "../lib/plugin-manifest-labels";

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
  // Subscribe once so all buttons re-render on locale change.
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);

  // Hide once a right panel is open AND the panel can actually
  // render. If the panel id is stale/invalid, the right panel
  // returns null and we'd leave the user with no buttons at all.
  if (openPanel !== null && plugins) {
    const dot = openPanel.indexOf(".");
    if (dot > 0) {
      const pluginId = openPanel.slice(0, dot);
      const localId = openPanel.slice(dot + 1);
      const owner = plugins.find((p) => p.id === pluginId && p.state === "active");
      const panels = (owner?.contributes as { rightPanels?: { id: string }[] } | undefined)?.rightPanels;
      if (panels?.some((p) => p.id === localId)) {
        return null; // panel will render, PanelTabBar takes over
      }
    }
    // Panel can't render — clear the stale selection and show buttons
    setOpenPanel(null);
  }
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
        // Localize the tooltip: look up
        //   plugin.<id>.manifest.topBarButtons.<contribId>
        // and fall back to the manifest's English tooltip.
        const label = manifestLabelFor(
          locale,
          b.pluginId,
          "topBarButtons",
          b.id,
          b.tooltip ?? b.pluginId,
        );
        return (
          <button
            key={fullId}
            type="button"
            title={label}
            aria-label={label}
            onClick={() => {
              if (!panelTarget) return;
              setOpenPanel(panelTarget);
            }}
            className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg-default"
          >
            <Icon size={16} />
          </button>
        );
      })}
    </>
  );
}
