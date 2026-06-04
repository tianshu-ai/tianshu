// Renders top-bar buttons contributed by active plugins.
//
// The manifest declares an `icon` string (a lucide-react export name).
// We resolve it against an explicit whitelist below — named imports
// keep tree-shaking working (a star import doubles the bundle).
// Unknown names fall back to a Puzzle glyph; if your plugin needs a
// new icon, add it to this whitelist in the same PR.

import {
  FolderOpen,
  Globe,
  Calendar,
  Kanban,
  Terminal,
  FileText,
  Search,
  Wrench,
  Bot,
  MessageSquare,
  Puzzle,
} from "lucide-react";
import type { ComponentType } from "react";
import { usePluginStore } from "../stores/plugin-store";

const ICONS: Record<string, ComponentType<{ size?: number }>> = {
  FolderOpen,
  Globe,
  Calendar,
  Kanban,
  Terminal,
  FileText,
  Search,
  Wrench,
  Bot,
  MessageSquare,
};

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
          ? // opensPanel is a local (per-plugin) id. The right-panel id
            // we expose globally is `<plugin-id>.<local>`. Manifests
            // sometimes already namespace it; tolerate both shapes.
            b.opensPanel.includes(".")
            ? b.opensPanel
            : `${b.pluginId}.${b.opensPanel}`
          : null;
        const isOpen = panelTarget !== null && panelTarget === openPanel;
        const Icon = ICONS[b.icon] ?? Puzzle;
        return (
          <button
            key={fullId}
            type="button"
            title={b.tooltip ?? b.pluginId}
            aria-label={b.tooltip ?? b.pluginId}
            aria-pressed={isOpen}
            onClick={() => {
              if (!panelTarget) return;
              setOpenPanel(isOpen ? null : panelTarget);
            }}
            className={[
              // Match the closed-source repo's panel-toggle buttons:
              // tight 1.5 padding, transparent default, gray hover,
              // active state lights the slot up.
              "rounded-lg p-1.5 transition-colors",
              isOpen
                ? "bg-gray-700 text-white"
                : "text-gray-400 hover:bg-gray-800 hover:text-gray-200",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <Icon size={16} />
          </button>
        );
      })}
    </>
  );
}
